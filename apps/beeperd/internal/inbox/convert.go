package inbox

import (
	"strings"

	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/journal"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/msg"
)

// convertMessage turns a message event (already decrypted, if it was encrypted) into the form the
// tools and the journal use. An edit comes back under the ID of the message it replaces, with the
// new text. It returns nil for anything that isn't a message.
func convertMessage(evt *event.Event, own id.UserID) *msg.Message {
	if evt == nil || evt.Type.Type != event.EventMessage.Type {
		return nil
	}
	if evt.Content.Parsed == nil {
		_ = evt.Content.ParseRaw(event.EventMessage)
	}
	content, ok := evt.Content.Parsed.(*event.MessageEventContent)
	if !ok {
		return nil
	}
	encrypted := evt.Mautrix.EventSource&event.SourceDecrypted != 0 || evt.Mautrix.WasEncrypted
	message := &msg.Message{
		Content:   evt.Content.Raw,
		Encrypted: encrypted,
		EventID:   evt.ID.String(),
		Kind:      "message",
		RoomID:    evt.RoomID.String(),
		Sender:    msg.Sender{IsMe: evt.Sender == own, UserID: evt.Sender.String()},
		Type:      evt.Type.Type,
	}
	if evt.Timestamp > 0 {
		timestamp := evt.Timestamp
		message.Timestamp = &timestamp
	}
	body := content
	if replaced := content.RelatesTo.GetReplaceID(); replaced != "" {
		if content.NewContent == nil {
			return nil
		}
		body = content.NewContent
		message.EventID = replaced.String()
		message.Replaces = replaced.String()
		message.Edited = true
		message.Relation = &msg.Relation{EventID: replaced.String(), Type: string(event.RelReplace)}
	} else {
		message.Relation = relation(content.RelatesTo)
		message.Edited = evt.Unsigned.Relations.GetLatestEdit() != nil
	}
	// Work on a copy: removing the reply fallback changes the content, and the event is shared.
	clone := *body
	clone.RemoveReplyFallback()
	message.Text = clone.Body
	if clone.FormattedBody != "" {
		html := clone.FormattedBody
		message.HTML = &html
	}
	message.MessageType = string(clone.MsgType)
	message.ReplyTo = clone.RelatesTo.GetNonFallbackReplyTo().String()
	message.ThreadRoot = clone.RelatesTo.GetThreadParent().String()
	message.Attachments = attachments(&clone)
	return message
}

func relation(rel *event.RelatesTo) *msg.Relation {
	if rel == nil {
		return nil
	}
	switch rel.Type {
	case event.RelAnnotation:
		if rel.EventID == "" {
			return nil
		}
		return &msg.Relation{EventID: rel.EventID.String(), Type: string(rel.Type), Key: rel.Key}
	case event.RelReplace, event.RelThread, event.RelReference:
		if rel.EventID == "" {
			return nil
		}
		return &msg.Relation{EventID: rel.EventID.String(), Type: string(rel.Type)}
	default:
		if reply := rel.GetNonFallbackReplyTo(); reply != "" {
			return &msg.Relation{EventID: reply.String(), Type: "m.in_reply_to"}
		}
		return nil
	}
}

func attachments(content *event.MessageEventContent) []msg.Attachment {
	if content == nil || !content.MsgType.IsMedia() {
		return []msg.Attachment{}
	}
	attachment := msg.Attachment{Kind: strings.TrimPrefix(string(content.MsgType), "m.")}
	if name := content.GetFileName(); name != "" {
		attachment.Filename = &name
	}
	if content.URL != "" {
		uri := string(content.URL)
		attachment.ContentURI = &uri
	}
	if content.File != nil {
		file := &msg.EncryptedFile{
			IV:  content.File.InitVector,
			URL: string(content.File.URL),
			V:   content.File.Version,
			Key: map[string]any{
				"alg": content.File.Key.Algorithm, "ext": content.File.Key.Extractable,
				"k": content.File.Key.Key, "key_ops": content.File.Key.KeyOps, "kty": content.File.Key.KeyType,
			},
		}
		file.Hashes.SHA256 = content.File.Hashes.SHA256
		attachment.EncryptedFile = file
	}
	if info := content.Info; info != nil {
		if info.MimeType != "" {
			mime := info.MimeType
			attachment.ContentType = &mime
		}
		if info.Duration > 0 {
			duration := int64(info.Duration)
			attachment.Duration = &duration
		}
		if info.Height > 0 {
			height := info.Height
			attachment.Height = &height
		}
		if info.Width > 0 {
			width := info.Width
			attachment.Width = &width
		}
		if info.Size > 0 {
			size := int64(info.Size)
			attachment.Size = &size
		}
	}
	return []msg.Attachment{attachment}
}

// record writes a converted message into the journal.
func (ib *Inbox) record(message *msg.Message) {
	messages := ib.Journal()
	if messages == nil || message.EventID == "" || message.RoomID == "" {
		return
	}
	entry := journal.Message{
		RoomID:      message.RoomID,
		EventID:     message.EventID,
		Sender:      message.Sender.UserID,
		IsMe:        message.Sender.IsMe,
		Type:        message.MessageType,
		Text:        message.Text,
		HTML:        message.HTML,
		Replaces:    message.Replaces,
		ReplyTo:     message.ReplyTo,
		Attachments: len(message.Attachments),
		TS:          ib.now(),
	}
	if message.Timestamp != nil {
		entry.TS = *message.Timestamp
	}
	if _, err := messages.Record(entry, ib.now()); err != nil {
		// The journal must never get in sync's way.
		ib.log("warn", "journal update failed", map[string]any{"error": err.Error()})
	}
}

func trimSpace(text string) string { return strings.TrimSpace(text) }
