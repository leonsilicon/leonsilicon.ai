package inbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf16"

	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/crypto/attachment"
	"maunium.net/go/mautrix/crypto/backup"
	"maunium.net/go/mautrix/crypto/olm"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/format"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/handoff"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/ledger"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/msg"
)

// sendFailure is why a send didn't complete. reached says whether the event may have reached the
// homeserver: a failure before the request, or a plain refusal (4xx), is definite; anything else
// (a timeout, a 5xx) leaves delivery unknown.
type sendFailure struct {
	err     error
	reached bool
	status  int
}

func (f *sendFailure) Error() string { return f.err.Error() }

func (f *sendFailure) definite() bool {
	return !f.reached || (f.status >= 400 && f.status < 500 && f.status != http.StatusTooManyRequests)
}

func before(err error) *sendFailure { return &sendFailure{err: err} }

type sendOutcome struct {
	record       ledger.SendRecord
	deduplicated bool
	resent       bool
}

// ledgered runs one send through the ledger, under the send lock, so overlapping requests with the
// same key wait for the first and get its result instead of sending again.
func (ib *Inbox) ledgered(roomID string, kind ledger.SendKind, hash string, explicit *string, send func(txnID string) (string, *sendFailure)) (sendOutcome, error) {
	sends := ib.sends()
	key, derived, err := ledger.IdempotencyKey(explicit, roomID, kind, hash)
	if err != nil {
		return sendOutcome{}, toolError("bad_argument", err.Error())
	}
	ib.sendMu.Lock()
	defer ib.sendMu.Unlock()
	now := ib.now()
	existing, err := sends.Get(key)
	if err != nil {
		return sendOutcome{}, err
	}
	if existing != nil && !derived && existing.PayloadHash != hash {
		return sendOutcome{}, toolError("bad_argument", "this idempotency_key was already used for different content; use a new key")
	}
	if existing != nil && derived && now-existing.CreatedAt > ledger.DerivedKeyWindowMS &&
		existing.Status != ledger.StatusPending && existing.Status != ledger.StatusUnknown {
		if err := sends.Retire(key, now); err != nil {
			return sendOutcome{}, err
		}
		existing = nil
	}
	if existing != nil && existing.Status == ledger.StatusSent {
		return sendOutcome{record: *existing, deduplicated: true}, nil
	}
	if existing != nil && (existing.Status == ledger.StatusUnknown || existing.Status == ledger.StatusPending) &&
		now-existing.UpdatedAt > ledger.SafeResendWindowMS {
		return sendOutcome{}, toolErrorData("delivery_unknown", fmt.Sprintf(
			"an earlier attempt with this key (%d attempt(s), last %s) may or may not have been delivered, and it is too old to resend safely. Check list_messages; to send anyway, pass a new idempotency_key.",
			existing.Attempts, format.ISOTime(existing.UpdatedAt)),
			map[string]any{"txn_id": existing.TxnID, "status": existing.Status})
	}
	txnID := ledger.TxnIDFor(key, 0)
	if existing != nil {
		txnID = existing.TxnID
	}
	record, err := sends.Begin(ledger.Attempt{Key: key, Derived: derived, RoomID: roomID, Kind: kind, PayloadHash: hash, TxnID: txnID}, now)
	if err != nil {
		return sendOutcome{}, err
	}
	eventID, failure := send(txnID)
	if failure == nil {
		finished, err := sends.Finish(record.Key, ledger.StatusSent, eventID, "", ib.now())
		if err != nil {
			return sendOutcome{}, err
		}
		return sendOutcome{record: finished, resent: existing != nil}, nil
	}
	status := ledger.StatusUnknown
	if failure.definite() {
		status = ledger.StatusFailed
	}
	message := failure.Error()
	finished, _ := sends.Finish(record.Key, status, "", trim(message, 500), ib.now())
	ib.log("warn", "send did not complete", map[string]any{
		"roomId": roomID, "kind": string(kind), "status": string(status),
		"reached": failure.reached, "lastStatus": failure.status, "error": trim(message, 300),
	})
	data := map[string]any{"txn_id": finished.TxnID, "reached_homeserver": failure.reached, "http_status": failure.status}
	if status == ledger.StatusFailed {
		return sendOutcome{}, toolErrorData("send_failed", fmt.Sprintf("the homeserver did not accept the %s: %s", kind, message), data)
	}
	return sendOutcome{}, toolErrorData("delivery_unknown", fmt.Sprintf(
		"the %s may or may not have been delivered (%s). Calling again with the same arguments (or idempotency_key) within %d minutes is safe: it reuses the same transaction ID, so the homeserver won't post it twice.",
		kind, message, ledger.SafeResendWindowMS/60_000), data)
}

func (ib *Inbox) sends() *ledger.SendLedger {
	ib.mu.Lock()
	defer ib.mu.Unlock()
	return ib.ledger
}

// prepareRecipients makes sure the library knows the room is encrypted and who is in it, which is
// what it shares the message key with. Sync only delivers the members who spoke lately.
func (ib *Inbox) prepareRecipients(ctx context.Context, core *matrixCore, roomID id.RoomID) error {
	encrypted, err := core.cli.StateStore.IsEncrypted(ctx, roomID)
	if err != nil {
		return err
	}
	if !encrypted {
		var encryption event.EncryptionEventContent
		if err := core.cli.StateEvent(ctx, roomID, event.StateEncryption, "", &encryption); err != nil {
			return err
		}
		if err := core.cli.StateStore.SetEncryptionEvent(ctx, roomID, &encryption); err != nil {
			return err
		}
	}
	members, err := core.cli.JoinedMembers(ctx, roomID)
	if err != nil {
		return err
	}
	for userID, member := range members.Joined {
		err := core.cli.StateStore.SetMember(ctx, roomID, userID, &event.MemberEventContent{
			AvatarURL: id.ContentURIString(member.AvatarURL), Displayname: member.DisplayName, Membership: event.MembershipJoin,
		})
		if err != nil {
			return err
		}
	}
	return nil
}

// backUpOutboundSession uploads the key of the session this device encrypts with to the account's
// key backup, so Leon's future devices can read what Hermes sent. Failing to is not a send failure.
func (ib *Inbox) backUpOutboundSession(ctx context.Context, core *matrixCore, roomID id.RoomID) {
	if core.backupKey == nil || core.backupVersion == "" {
		return
	}
	session, err := core.mach.CryptoStore.GetOutboundGroupSession(ctx, roomID)
	if err != nil || session == nil || !session.Shared {
		return
	}
	content := session.ShareContent()
	shared := content.AsRoomKey()
	if shared == nil || shared.SessionID == "" || shared.SessionKey == "" {
		return
	}
	if ib.cache.backedUp(roomID.String(), shared.SessionID.String()) {
		return
	}
	inbound, err := olm.NewInboundGroupSession([]byte(shared.SessionKey))
	if err != nil {
		return
	}
	exported, err := inbound.Export(inbound.FirstKnownIndex())
	if err != nil {
		return
	}
	encrypted, err := backup.EncryptSessionData(core.backupKey, backup.MegolmSessionData{
		Algorithm:          id.AlgorithmMegolmV1,
		ForwardingKeyChain: []string{},
		SenderClaimedKeys:  backup.SenderClaimedKeys{Ed25519: core.mach.GetAccount().SigningKey()},
		SenderKey:          core.mach.GetAccount().IdentityKey(),
		SessionKey:         string(exported),
	})
	if err != nil {
		return
	}
	raw, err := json.Marshal(encrypted)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	_, err = core.cli.PutKeysInBackupForRoom(ctx, core.backupVersion, roomID, &mautrix.ReqRoomKeyBackup{
		Sessions: map[id.SessionID]mautrix.ReqKeyBackupData{shared.SessionID: {IsVerified: true, SessionData: raw}},
	})
	if err == nil {
		ib.cache.setBackedUp(roomID.String(), shared.SessionID.String())
	}
}

// sendEvent sends one event with a fixed transaction ID. For an encrypted room it encrypts here and
// sends the ciphertext itself, so nothing readable can go into an encrypted room by mistake, and a
// retry repeats the same request for the homeserver to deduplicate.
func (ib *Inbox) sendEvent(ctx context.Context, core *matrixCore, roomID string, eventType event.Type, content any, encrypt bool, txnID string) (string, *sendFailure) {
	room := id.RoomID(roomID)
	payload := content
	if encrypt {
		if err := ib.prepareRecipients(ctx, core, room); err != nil {
			return "", before(fmt.Errorf("couldn't prepare the room's encryption: %w", err))
		}
		encrypted, err := core.helper.Encrypt(ctx, room, eventType, content)
		if err != nil {
			return "", before(fmt.Errorf("couldn't encrypt: %w", err))
		}
		payload, eventType = encrypted, event.EventEncrypted
		ib.backUpOutboundSession(ctx, core, room)
	}
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	resp, err := core.cli.SendMessageEvent(ctx, room, eventType, payload, mautrix.ReqSendEvent{TransactionID: txnID, DontEncrypt: true})
	if err != nil {
		failure := &sendFailure{err: err, reached: true}
		var httpErr mautrix.HTTPError
		if errors.As(err, &httpErr) && httpErr.Response != nil {
			failure.status = httpErr.Response.StatusCode
		}
		return "", failure
	}
	return resp.EventID.String(), nil
}

func (ib *Inbox) readBack(ctx context.Context, core *matrixCore, roomID, eventID string, expectEncrypted bool) (*msg.Message, map[string]any) {
	ib.mu.Lock()
	own := ib.session.UserID
	ib.mu.Unlock()
	message, raw, err := ib.fetchMessage(ctx, core, roomID, eventID)
	if err != nil {
		return nil, map[string]any{"found": false, "error": err.Error()}
	}
	sentEncrypted := raw != nil && raw.Type.Type == event.EventEncrypted.Type
	senderIsMe := raw != nil && raw.Sender.String() == own
	if message != nil {
		senderIsMe = message.Sender.IsMe
	}
	return message, map[string]any{
		"found":                  raw != nil,
		"decrypted":              message != nil,
		"sent_encrypted":         sentEncrypted,
		"encryption_as_expected": !expectEncrypted || sentEncrypted,
		"sender_is_me":           senderIsMe,
	}
}

func (ib *Inbox) sendResult(ctx context.Context, core *matrixCore, roomID string, outcome sendOutcome, expectEncrypted bool, extra func(message *msg.Message, out map[string]any)) map[string]any {
	eventID := ""
	if outcome.record.EventID != nil {
		eventID = *outcome.record.EventID
	}
	message, readback := ib.readBack(ctx, core, roomID, eventID, expectEncrypted)
	var bridge bridgeStatus
	var observed bool
	bridged := ib.bridged(roomID)
	switch {
	case outcome.deduplicated || !bridged:
		// Nothing to wait for: an earlier send's status is already here if it came, and a plain Matrix
		// room has no bridge to report.
		bridge, observed = ib.cache.bridgeStatus(eventID)
	default:
		bridge, observed = ib.cache.awaitBridgeStatus(eventID, ib.bridgeStatusWait)
	}
	out := map[string]any{
		"status":         "sent",
		"room_id":        roomID,
		"event_id":       eventID,
		"txn_id":         outcome.record.TxnID,
		"deduplicated":   outcome.deduplicated,
		"encrypted_room": expectEncrypted,
		"readback":       readback,
	}
	if outcome.deduplicated {
		out["note"] = "an identical send with this key already went through; nothing was sent again"
	}
	if outcome.resent {
		out["resent_after_unknown"] = true
	}
	if observed {
		status := map[string]any{"status": bridge.Status}
		if bridge.Reason != "" {
			status["reason"] = bridge.Reason
		}
		if bridge.Message != "" {
			status["message"] = bridge.Message
		}
		out["bridge_status"] = status
	} else if !bridged {
		out["bridge_status"] = map[string]any{
			"status": "not_applicable",
			"note":   "this is a plain Matrix room with no bridge; the homeserver accepted the event",
		}
	} else {
		out["bridge_status"] = map[string]any{
			"status": "not_observed",
			"note":   fmt.Sprintf("no bridge delivery status within %gs; the homeserver accepted the event", ib.bridgeStatusWait.Seconds()),
		}
	}
	if extra != nil {
		extra(message, out)
	}
	return out
}

// bridged reports whether a room belongs to a bridge, which then reports each message's delivery.
// An unknown room counts as bridged, so its status is waited for.
func (ib *Inbox) bridged(roomID string) bool {
	record, err := ib.rooms().Get(roomID)
	return err != nil || record == nil || record.Bridge != nil
}

// sendNetwork returns the network of a room Leon is in, learning the room first when needed.
func (ib *Inbox) sendNetwork(ctx context.Context, core *matrixCore, roomID string) (string, error) {
	if err := ib.requireJoined(ctx, roomID); err != nil {
		return "", err
	}
	record := ib.roomRecord(ctx, core, roomID)
	if record == nil {
		return "", toolError("unavailable", "Couldn't identify the network for "+roomID+"; try again after the conversation appears in list_conversations.")
	}
	return record.Network, nil
}

func requireGrokHandoff(network string, fromGrokRelay bool) error {
	if network == "grok" && !fromGrokRelay {
		return toolError("refused", "Grok Bot requests must use grok_bot_send with slack_channel and slack_thread_ts. Use the task's Slack thread, or the ts of Leon's message when there is no thread. For a task bot already talking to you in Slack, answer it in that thread.")
	}
	return nil
}

func utf16Length(text string) int { return len(utf16.Encode([]rune(text))) }

func explicitKey(args map[string]any) *string {
	if key, ok := stringArg(args, "idempotency_key"); ok {
		return &key
	}
	return nil
}

// SendMessage sends text into one of Leon's existing conversations, as Leon. fromGrokRelay is true
// only for the Grok relay inside this daemon, which alone may deliver a handoff to a Grok room.
func (ib *Inbox) SendMessage(ctx context.Context, args map[string]any, fromGrokRelay bool) (map[string]any, error) {
	core, _, err := ib.ready()
	if err != nil {
		return nil, err
	}
	roomID, err := roomIDOf(args["room_id"])
	if err != nil {
		return nil, err
	}
	given, _ := stringArg(args, "text")
	if handoff.TrimSpace(given) == "" {
		return nil, toolError("bad_argument", "text is required")
	}
	// A message to Silicon Dot is a task: it carries the Slack thread Hermes works in, and Dot's
	// Codex session for it talks to Hermes there.
	network, err := ib.sendNetwork(ctx, core, roomID)
	if err != nil {
		return nil, err
	}
	if err := requireGrokHandoff(network, fromGrokRelay); err != nil {
		return nil, err
	}
	dot := handoff.IsDotNetwork(network)
	_, hasChannel := args["slack_channel"]
	_, hasThread := args["slack_thread_ts"]
	if !dot && (hasChannel || hasThread) {
		return nil, toolError("bad_argument", "slack_channel and slack_thread_ts are only for Silicon Dot's chats; for a Grok bot use grok_bot_send")
	}
	body := given
	var handoffInfo map[string]string
	if dot {
		thread, err := handoff.ParseThread(args["slack_channel"], args["slack_thread_ts"])
		if err != nil {
			return nil, toolError("bad_argument", "This is Silicon Dot's chat. "+err.Error())
		}
		body = handoff.TrimSpace(given) + "\n\n" + handoff.CodexBlock(thread)
		handoffInfo = map[string]string{"slack_identifier": handoff.Identifier(thread), "codex_session_title": handoff.TaskName(thread)}
	}
	if utf16Length(body) > MaxSendChars {
		return nil, toolError("bad_argument", fmt.Sprintf("text is over %d characters", MaxSendChars))
	}
	replyTo := ""
	if raw, present := args["reply_to"]; present && raw != nil && raw != "" {
		if replyTo, err = eventIDOf(raw, "reply_to"); err != nil {
			return nil, err
		}
		target, err := ib.matrix(ctx, http.MethodGet, roomPath(roomID)+"/event/"+pathEscape(replyTo), nil, nil, 0)
		if err != nil {
			return nil, toolError("unavailable", "couldn't check reply_to: "+trim(err.Error(), 200))
		}
		if target.Status != 200 {
			return nil, toolError("not_found", fmt.Sprintf("reply_to %s isn't an event in %s (HTTP %d)", replyTo, roomID, target.Status))
		}
	}
	encrypted, err := ib.roomEncrypted(ctx, roomID)
	if err != nil {
		return nil, err
	}
	content := &event.MessageEventContent{MsgType: event.MsgText, Body: body}
	if replyTo != "" {
		content.RelatesTo = (&event.RelatesTo{}).SetReplyTo(id.EventID(replyTo))
	}
	hash := ledger.PayloadHash("text", body, replyTo)
	outcome, err := ib.ledgered(roomID, ledger.KindText, hash, explicitKey(args), func(txnID string) (string, *sendFailure) {
		return ib.sendEvent(ctx, core, roomID, event.EventMessage, content, encrypted, txnID)
	})
	if err != nil {
		return nil, err
	}
	return ib.sendResult(ctx, core, roomID, outcome, encrypted, func(message *msg.Message, out map[string]any) {
		if replyTo != "" {
			out["reply_to"] = replyTo
			out["reply_linked"] = nil
			if message != nil {
				out["reply_linked"] = message.ReplyTo == replyTo
			}
		}
		out["text_matches"] = nil
		if message != nil {
			out["text_matches"] = message.Text == body
		}
		for key, value := range handoffInfo {
			out[key] = value
		}
	}), nil
}

// SendFile sends a file from Hermes's machine into a conversation.
func (ib *Inbox) SendFile(ctx context.Context, args map[string]any) (map[string]any, error) {
	core, _, err := ib.ready()
	if err != nil {
		return nil, err
	}
	roomID, err := roomIDOf(args["room_id"])
	if err != nil {
		return nil, err
	}
	inputPath, _ := stringArg(args, "path")
	inputPath = strings.TrimSpace(inputPath)
	if inputPath == "" || !filepath.IsAbs(inputPath) {
		return nil, toolError("bad_argument", "path must be an absolute path to a file on Hermes's machine")
	}
	realPath, err := filepath.EvalSymlinks(inputPath)
	if err != nil {
		return nil, toolError("not_found", inputPath+" doesn't exist")
	}
	stateDir, err := filepath.EvalSymlinks(ib.paths.State)
	if err != nil {
		stateDir = ib.paths.State
	}
	if reason, refused := format.RefusedUploadReason(realPath, stateDir); refused {
		return nil, toolError("refused", "won't send "+realPath+": "+reason)
	}
	info, err := os.Stat(realPath)
	if err != nil {
		return nil, toolError("not_found", inputPath+" doesn't exist")
	}
	switch {
	case !info.Mode().IsRegular():
		return nil, toolError("bad_argument", realPath+" isn't a regular file")
	case info.Size() == 0:
		return nil, toolError("bad_argument", realPath+" is empty")
	case info.Size() > MaxUploadBytes:
		return nil, toolError("too_large", fmt.Sprintf("%s is %d bytes; the limit is %d", realPath, info.Size(), MaxUploadBytes))
	}
	name := filepath.Base(realPath)
	if given, ok := stringArg(args, "filename"); ok && strings.TrimSpace(given) != "" {
		name = given
	}
	filename := format.SafeFilename(name, "file")
	contentType := format.ContentTypeFor(filename)
	if given, ok := stringArg(args, "content_type"); ok && strings.Contains(given, "/") {
		contentType = strings.TrimSpace(given)
	}
	caption, _ := stringArg(args, "caption")
	if strings.TrimSpace(caption) == "" {
		caption = ""
	}
	sendAs := "auto"
	if args["send_as"] == "file" {
		sendAs = "file"
	}
	network, err := ib.sendNetwork(ctx, core, roomID)
	if err != nil {
		return nil, err
	}
	if err := requireGrokHandoff(network, false); err != nil {
		return nil, err
	}
	encrypted, err := ib.roomEncrypted(ctx, roomID)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(realPath)
	if err != nil {
		return nil, toolError("not_found", "couldn't read "+realPath+": "+err.Error())
	}
	digest := sha256Hex(data)
	hash := ledger.PayloadHash("file", digest, filename, contentType, caption, sendAs)
	outcome, err := ib.ledgered(roomID, ledger.KindFile, hash, explicitKey(args), func(txnID string) (string, *sendFailure) {
		content := &event.MessageEventContent{
			MsgType:  event.MessageType("m." + format.MediaKind(contentType, sendAs)),
			Body:     filename,
			FileName: filename,
			Info:     &event.FileInfo{MimeType: contentType, Size: len(data)},
		}
		if caption != "" {
			content.Body = caption
		}
		uploadCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
		defer cancel()
		if encrypted {
			file := attachment.NewEncryptedFile()
			ciphertext := file.Encrypt(data)
			uploaded, err := core.cli.UploadBytesWithName(uploadCtx, ciphertext, "application/octet-stream", filename)
			if err != nil {
				return "", before(fmt.Errorf("the upload failed: %w", err))
			}
			content.File = &event.EncryptedFileInfo{EncryptedFile: *file, URL: uploaded.ContentURI.CUString()}
		} else {
			uploaded, err := core.cli.UploadBytesWithName(uploadCtx, data, contentType, filename)
			if err != nil {
				return "", before(fmt.Errorf("the upload failed: %w", err))
			}
			content.URL = uploaded.ContentURI.CUString()
		}
		return ib.sendEvent(ctx, core, roomID, event.EventMessage, content, encrypted, txnID)
	})
	if err != nil {
		return nil, err
	}
	return ib.sendResult(ctx, core, roomID, outcome, encrypted, func(message *msg.Message, out map[string]any) {
		out["file"] = map[string]any{
			"path": realPath, "filename": filename, "content_type": contentType, "bytes": len(data), "sha256": digest,
		}
		out["sent_attachment"] = nil
		if message == nil || len(message.Attachments) == 0 {
			return
		}
		sent := message.Attachments[0]
		out["sent_attachment"] = format.AttachmentRefs([]msg.Attachment{sent})[0]
		if len(data) > RoundTripVerifyBytes {
			return
		}
		back, err := ib.downloadBytes(ctx, core, sent)
		if err != nil {
			out["round_trip"] = map[string]any{"error": err.Error()}
			return
		}
		out["round_trip"] = map[string]any{"bytes": len(back), "sha256_matches": sha256Hex(back) == digest}
	}), nil
}

// SendReaction reacts to a message.
func (ib *Inbox) SendReaction(ctx context.Context, args map[string]any) (map[string]any, error) {
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
	key, _ := stringArg(args, "key")
	key = strings.TrimSpace(key)
	if key == "" || utf16Length(key) > 64 {
		return nil, toolError("bad_argument", "key must be an emoji or short text (up to 64 characters)")
	}
	if err := ib.requireJoined(ctx, roomID); err != nil {
		return nil, err
	}
	target, err := ib.matrix(ctx, http.MethodGet, roomPath(roomID)+"/event/"+pathEscape(eventID), nil, nil, 0)
	if err != nil {
		return nil, toolError("unavailable", "couldn't check the event: "+trim(err.Error(), 200))
	}
	if target.Status != 200 {
		return nil, toolError("not_found", fmt.Sprintf("event %s isn't in %s (HTTP %d)", eventID, roomID, target.Status))
	}
	hash := ledger.PayloadHash("reaction", eventID, key)
	content := &event.ReactionEventContent{RelatesTo: *(&event.RelatesTo{}).SetAnnotation(id.EventID(eventID), key)}
	// Reactions go out unencrypted by design (mautrix and most clients), so they aren't encrypted here.
	outcome, err := ib.ledgered(roomID, ledger.KindReaction, hash, explicitKey(args), func(txnID string) (string, *sendFailure) {
		return ib.sendEvent(ctx, core, roomID, event.EventReaction, content, false, txnID)
	})
	if err != nil {
		return nil, err
	}
	sent := ""
	if outcome.record.EventID != nil {
		sent = *outcome.record.EventID
	}
	status := map[string]any{"status": "not_observed"}
	if !outcome.deduplicated && ib.bridged(roomID) {
		if bridge, observed := ib.cache.awaitBridgeStatus(sent, ib.bridgeStatusWait); observed {
			status = map[string]any{"status": bridge.Status}
			if bridge.Reason != "" {
				status["reason"] = bridge.Reason
			}
		}
	}
	return map[string]any{
		"status": "sent", "room_id": roomID, "reacted_to": eventID, "key": key, "event_id": sent,
		"txn_id": outcome.record.TxnID, "deduplicated": outcome.deduplicated, "bridge_status": status,
	}, nil
}
