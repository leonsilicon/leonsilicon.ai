package inbox

import (
	"context"
	"errors"
	"net/http"
	"time"

	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/msg"
)

func text(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	default:
		return ""
	}
}

// onBridgeStatus remembers what a bridge said about a sent message: delivered, or why not.
func (ib *Inbox) onBridgeStatus(evt *event.Event) {
	content := evt.Content.Raw
	relates, _ := content["m.relates_to"].(map[string]any)
	target := text(relates["event_id"])
	if target == "" {
		return
	}
	status := text(content["status"])
	if status == "" {
		status = "unknown"
	}
	ib.cache.setBridgeStatus(target, bridgeStatus{
		Status: status, Reason: text(content["reason"]), Message: text(content["message"]),
		Network: text(content["network"]), At: ib.now(),
	})
}

// setMuted reads the muted chats out of Leon's push rules. Beeper keeps a muted chat as a push rule
// for the room with no "notify" action (measured 2026-11-21: 213 room rules, actions [] or
// ["dont_notify"], and no Beeper-specific field).
func (ib *Inbox) setMuted(global any) {
	ruleset, _ := global.(map[string]any)
	rules, ok := ruleset["room"].([]any)
	if !ok {
		return
	}
	muted := map[string]bool{}
	for _, raw := range rules {
		rule, _ := raw.(map[string]any)
		ruleID, isString := rule["rule_id"].(string)
		if !isString {
			continue
		}
		if enabled, isBool := rule["enabled"].(bool); isBool && !enabled {
			continue
		}
		notifies := false
		actions, _ := rule["actions"].([]any)
		for _, action := range actions {
			if action == "notify" {
				notifies = true
			}
		}
		if !notifies {
			muted[ruleID] = true
		}
	}
	ib.cache.mu.Lock()
	ib.cache.muted = muted
	ib.cache.mutedAtTime = ib.now()
	ib.cache.mu.Unlock()
}

// refreshMuted reads Leon's muted chats from the homeserver. Sync also brings changes as they happen.
func (ib *Inbox) refreshMuted(ctx context.Context) {
	response, err := ib.matrix(ctx, http.MethodGet, "/_matrix/client/v3/pushrules/", nil, nil, 20*time.Second)
	if err != nil {
		ib.log("warn", "couldn't read the muted chats", map[string]any{"error": trim(err.Error(), 200)})
		return
	}
	if response.Status != 200 {
		ib.log("warn", "couldn't read the muted chats", map[string]any{"status": response.Status})
		return
	}
	ib.setMuted(response.object()["global"])
}

// fetchMessage reads one event from the homeserver and decrypts it. message is nil when the event
// isn't a message or couldn't be decrypted; raw is the event as the homeserver has it.
func (ib *Inbox) fetchMessage(ctx context.Context, core *matrixCore, roomID, eventID string) (message *msg.Message, raw *event.Event, err error) {
	evt, err := core.cli.GetEvent(ctx, id.RoomID(roomID), id.EventID(eventID))
	if err != nil {
		var httpErr mautrix.HTTPError
		if errors.Is(err, mautrix.MNotFound) || (errors.As(err, &httpErr) && httpErr.IsStatus(http.StatusNotFound)) {
			return nil, nil, toolError("not_found", "event "+eventID+" wasn't found in "+roomID)
		}
		return nil, nil, err
	}
	if evt.RoomID == "" {
		evt.RoomID = id.RoomID(roomID)
	}
	return ib.decryptAndConvert(ctx, core, evt), evt, nil
}

// decryptAndConvert returns the message an event holds, decrypting it first when it is encrypted
// (from the store, then from the key backup). The event itself is left as it was.
func (ib *Inbox) decryptAndConvert(ctx context.Context, core *matrixCore, evt *event.Event) *msg.Message {
	if evt.Type.Type != event.EventEncrypted.Type {
		return convertMessage(evt, core.cli.UserID)
	}
	if evt.Content.Parsed == nil {
		if evt.Content.ParseRaw(event.EventEncrypted) != nil {
			return nil
		}
	}
	decrypted, err := core.helper.Decrypt(ctx, evt)
	if err != nil {
		decrypted = ib.decryptFromBackup(ctx, core, evt)
		if decrypted == nil {
			ib.cache.setDecryptError(evt.ID.String(), err.Error())
			return nil
		}
	}
	decrypted.Mautrix.EventSource |= event.SourceDecrypted
	if decrypted.RoomID == "" {
		decrypted.RoomID = evt.RoomID
	}
	return convertMessage(decrypted, core.cli.UserID)
}
