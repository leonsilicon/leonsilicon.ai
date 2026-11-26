package inbox

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"time"

	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/crypto/attachment"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/format"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/msg"
)

func itoa(value int) string { return strconv.Itoa(value) }

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// rawEvent is an event as the homeserver sent it, for accounting: what a page held besides the
// messages that were returned.
func rawEvent(evt *event.Event) format.RawEvent {
	raw := format.RawEvent{
		EventID: evt.ID.String(), Type: evt.Type.Type, Sender: evt.Sender.String(),
		OriginServerTS: evt.Timestamp, StateKey: evt.StateKey, Content: evt.Content.Raw,
	}
	if data, err := json.Marshal(evt.Unsigned); err == nil {
		_ = json.Unmarshal(data, &raw.Unsigned)
	}
	return raw
}

// ListMessages reads one page of a room's history, decrypted, oldest first, and accounts for every
// event the page held.
func (ib *Inbox) ListMessages(ctx context.Context, args map[string]any) (map[string]any, error) {
	core, _, err := ib.ready()
	if err != nil {
		return nil, err
	}
	roomID, err := roomIDOf(args["room_id"])
	if err != nil {
		return nil, err
	}
	if err := ib.requireJoined(ctx, roomID); err != nil {
		return nil, err
	}
	limit := clamp(numberArg(args, "limit", DefaultPage), 1, MaxPage)
	cursor, _ := stringArg(args, "cursor")
	direction := mautrix.DirectionBackward
	if args["direction"] == "forward" {
		direction = mautrix.DirectionForward
		if cursor == "" {
			return nil, toolError("bad_argument", "direction forward needs a cursor from an earlier page")
		}
	}
	page, err := core.cli.Messages(ctx, id.RoomID(roomID), cursor, "", direction, nil, limit)
	if err != nil {
		return nil, toolError("unavailable", "couldn't read "+roomID+"'s history: "+trim(err.Error(), 300))
	}
	raw := make([]format.RawEvent, 0, len(page.Chunk))
	var messages []*msg.Message
	for _, evt := range page.Chunk {
		if evt == nil {
			continue
		}
		if evt.RoomID == "" {
			evt.RoomID = id.RoomID(roomID)
		}
		raw = append(raw, rawEvent(evt))
		message := ib.decryptAndConvert(ctx, core, evt)
		if message == nil || message.ThreadRoot != "" {
			continue
		}
		messages = upsert(messages, message)
	}
	sort.SliceStable(messages, func(i, j int) bool { return timestamp(messages[i]) < timestamp(messages[j]) })

	returned := map[string]bool{}
	senders := make([]string, 0, len(messages))
	for _, message := range messages {
		returned[message.EventID] = true
		senders = append(senders, message.Sender.UserID)
	}
	accounting := format.AccountPage(raw, returned, ib.cache.decryptErrorsCopy())
	reactions := format.ReactionsByTarget(raw)
	names := ib.senderNames(ctx, senders)
	formatted := make([]format.FormattedMessage, 0, len(messages))
	for _, message := range messages {
		entry := format.FormatMessage(*message, format.Options{MaxText: MaxTextChars, SenderName: names[message.Sender.UserID]})
		if byKey := reactions[message.EventID]; len(byKey) > 0 {
			entry.Reactions = byKey
		}
		formatted = append(formatted, entry)
	}
	conversation := map[string]any{"room_id": roomID, "name": nil, "network": nil}
	if record, _ := ib.rooms().Get(roomID); record != nil {
		conversation["name"], conversation["network"] = record.Name, record.Network
	}
	out := map[string]any{
		"conversation":    conversation,
		"messages":        formatted,
		"order":           "oldest first",
		"next_cursor":     nil,
		"direction":       map[mautrix.Direction]string{mautrix.DirectionBackward: "backward", mautrix.DirectionForward: "forward"}[direction],
		"complete":        len(accounting.Undecryptable) == 0,
		"undecryptable":   accounting.Undecryptable,
		"raw_event_count": accounting.RawEvents,
		"omitted": map[string]any{
			"thread_replies": accounting.ThreadReplies,
			"other_events":   accounting.Other[:min(len(accounting.Other), 20)],
			"other_count":    len(accounting.Other),
			"edits_merged":   accounting.EditsMerged,
			"reactions":      accounting.Reactions,
			"redacted":       accounting.Redacted,
			"state_events":   accounting.StateEvents,
		},
	}
	if page.End != "" {
		out["next_cursor"] = page.End
	}
	if count := len(accounting.Undecryptable); count > 0 {
		out["decryption_note"] = fmt.Sprintf("%d event(s) in this page could not be decrypted; their text is unavailable. See inbox_status for key backup state.", count)
	}
	return out, nil
}

func timestamp(message *msg.Message) int64 {
	if message.Timestamp == nil {
		return 0
	}
	return *message.Timestamp
}

// upsert adds a message to a page, or lets an edit (or a later copy) replace the message it changes.
func upsert(messages []*msg.Message, next *msg.Message) []*msg.Message {
	if next.EventID == "" {
		return append(messages, next)
	}
	for index, existing := range messages {
		if existing.EventID != next.EventID {
			continue
		}
		if next.Edited || timestamp(next) >= timestamp(existing) {
			// The edit's own time is when it was edited; the message keeps its place in the page.
			if next.Replaces != "" && existing.Replaces == "" {
				next.Timestamp = existing.Timestamp
			}
			messages[index] = next
		}
		return messages
	}
	return append(messages, next)
}

// GetMessage reads one event, with its whole text.
func (ib *Inbox) GetMessage(ctx context.Context, args map[string]any) (map[string]any, error) {
	core, _, err := ib.ready()
	if err != nil {
		return nil, err
	}
	roomID, err := roomIDOf(args["room_id"])
	if err != nil {
		return nil, err
	}
	eventID, err := eventIDOf(args["event_id"], "event_id")
	if err != nil {
		return nil, err
	}
	if err := ib.requireJoined(ctx, roomID); err != nil {
		return nil, err
	}
	message, raw, err := ib.fetchMessage(ctx, core, roomID, eventID)
	if err != nil {
		return nil, err
	}
	if message == nil {
		out := map[string]any{"room_id": roomID, "event_id": eventID, "type": "unknown", "sender": nil, "timestamp": nil}
		rawType := ""
		if raw != nil {
			rawType = raw.Type.Type
			out["type"], out["sender"] = rawType, raw.Sender.String()
			if raw.Timestamp > 0 {
				out["timestamp"] = format.ISOTime(raw.Timestamp)
			}
		}
		if failure, failed := ib.cache.decryptError(eventID); rawType == event.EventEncrypted.Type && failed {
			out["decrypted"], out["error"] = false, "could not decrypt: "+failure
			return out, nil
		}
		out["decrypted"] = rawType != event.EventEncrypted.Type
		out["note"] = "this event isn't a message (or decrypts to a non-message type)"
		if raw != nil && rawType != event.EventEncrypted.Type {
			out["content"] = raw.Content.Raw
		}
		return out, nil
	}
	names := ib.senderNames(ctx, []string{message.Sender.UserID})
	formatted := format.FormatMessage(*message, format.Options{MaxText: MaxSendChars, SenderName: names[message.Sender.UserID], IncludeHTML: true})
	out := map[string]any{}
	data, _ := json.Marshal(formatted)
	_ = json.Unmarshal(data, &out)
	out["raw_type"] = nil
	if raw != nil {
		out["raw_type"] = raw.Type.Type
	}
	out["decrypted"] = true
	return out, nil
}

// downloadBytes fetches an attachment's bytes, decrypting them when the file is encrypted.
func (ib *Inbox) downloadBytes(ctx context.Context, core *matrixCore, file msg.Attachment) ([]byte, error) {
	uri := ""
	if file.EncryptedFile != nil {
		uri = file.EncryptedFile.URL
	} else if file.ContentURI != nil {
		uri = *file.ContentURI
	}
	parsed, err := id.ParseContentURI(uri)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	data, err := core.cli.DownloadBytes(ctx, parsed)
	if err != nil {
		return nil, err
	}
	if file.EncryptedFile == nil {
		return data, nil
	}
	// The key material goes through JSON so the library reads it exactly as the event had it.
	encoded, err := json.Marshal(file.EncryptedFile)
	if err != nil {
		return nil, err
	}
	var keys attachment.EncryptedFile
	if err := json.Unmarshal(encoded, &keys); err != nil {
		return nil, err
	}
	return keys.Decrypt(data)
}

// DownloadAttachment saves one of a message's files on the persistent volume and returns its path.
func (ib *Inbox) DownloadAttachment(ctx context.Context, args map[string]any) (map[string]any, error) {
	core, _, err := ib.ready()
	if err != nil {
		return nil, err
	}
	roomID, err := roomIDOf(args["room_id"])
	if err != nil {
		return nil, err
	}
	eventID, err := eventIDOf(args["event_id"], "event_id")
	if err != nil {
		return nil, err
	}
	index := max(numberArg(args, "attachment_index", 0), 0)
	if err := ib.requireJoined(ctx, roomID); err != nil {
		return nil, err
	}
	message, raw, err := ib.fetchMessage(ctx, core, roomID, eventID)
	if err != nil {
		return nil, err
	}
	if message == nil {
		data := map[string]any{"raw_type": nil}
		if raw != nil {
			data["raw_type"] = raw.Type.Type
		}
		if failure, failed := ib.cache.decryptError(eventID); failed {
			return nil, toolErrorData("undecryptable", "event "+eventID+" could not be decrypted ("+failure+"), so its attachment keys are unavailable", data)
		}
		return nil, toolErrorData("not_found", "event "+eventID+" isn't a message with attachments", data)
	}
	if index >= len(message.Attachments) {
		return nil, toolErrorData("not_found",
			fmt.Sprintf("event %s has %d attachment(s); index %d doesn't exist", eventID, len(message.Attachments), index),
			map[string]any{"attachments": format.AttachmentRefs(message.Attachments)})
	}
	file := message.Attachments[index]
	if file.Size != nil && *file.Size > MaxDownloadBytes {
		return nil, toolError("too_large", fmt.Sprintf("the attachment is %d bytes; the limit is %d", *file.Size, MaxDownloadBytes))
	}
	if file.EncryptedFile == nil && file.ContentURI == nil {
		return nil, toolError("not_found", "the attachment has no media URI")
	}
	data, err := ib.downloadBytes(ctx, core, file)
	if err != nil {
		return nil, toolError("unavailable", "the download failed: "+trim(err.Error(), 300))
	}
	if len(data) > MaxDownloadBytes {
		return nil, toolError("too_large", fmt.Sprintf("downloaded %d bytes, over the limit", len(data)))
	}
	digest := sha256Hex(data)
	name := ""
	if file.Filename != nil {
		name = *file.Filename
	} else if message.MessageType != "m.text" {
		name = message.Text
	}
	filename := format.SafeFilename(name, "attachment-"+itoa(index))
	sentAt := ib.now()
	if message.Timestamp != nil {
		sentAt = *message.Timestamp
	}
	dir := filepath.Join(ib.paths.Downloads, time.UnixMilli(sentAt).UTC().Format("2006-01-02"))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, digest[:12]+"-"+filename)
	if info, statErr := os.Stat(path); statErr != nil || info.Size() != int64(len(data)) {
		temp := path + "." + strconv.FormatInt(time.Now().UnixNano(), 36) + ".part"
		if err := os.WriteFile(temp, data, 0o644); err != nil {
			return nil, err
		}
		if err := os.Rename(temp, path); err != nil {
			return nil, err
		}
	}
	out := map[string]any{
		"path":         path,
		"filename":     filename,
		"content_type": format.ContentTypeFor(filename),
		"bytes":        len(data),
		"sha256":       digest,
		"encrypted":    file.EncryptedFile != nil,
		"mxc":          nil,
		"room_id":      roomID,
		"event_id":     eventID,
		"sender":       message.Sender.UserID,
		"timestamp":    nil,
		"note":         "Saved on Hermes's persistent volume; open it with your file or vision tools at this path.",
	}
	if file.ContentType != nil {
		out["content_type"] = *file.ContentType
	}
	if file.EncryptedFile != nil {
		out["mxc"] = file.EncryptedFile.URL
	} else if file.ContentURI != nil {
		out["mxc"] = *file.ContentURI
	}
	if message.Timestamp != nil {
		out["timestamp"] = format.ISOTime(*message.Timestamp)
	}
	if file.Size != nil && *file.Size != int64(len(data)) {
		out["warnings"] = []string{fmt.Sprintf("the event says %d bytes but %d were downloaded", *file.Size, len(data))}
	}
	return out, nil
}
