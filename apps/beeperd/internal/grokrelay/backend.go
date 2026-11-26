package grokrelay

import (
	"context"
	"errors"
	"regexp"
	"time"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/host"
)

// message is one message in a Grok bot's chat, as the relay needs it.
type message struct {
	ID     string
	ChatID string
	// SortKey orders the messages of a chat. It is also the cursor grok_bot_read takes.
	SortKey string
	// IsSender is true for Leon's account: Leon himself, or Hermes writing as him.
	IsSender bool
	// Text is plain text.
	Text      string
	Timestamp string
	// Type is set for anything but an ordinary text message, e.g. "m.notice".
	Type      string
	IsDeleted bool
}

// bot is one of Leon's Grok bots: a one-to-one chat on Beeper's Grok Bot network.
type bot struct {
	Name         string  `json:"name"`
	ChatID       string  `json:"chatID"`
	LastActivity *string `json:"lastActivity"`
}

// backend is where the relay reads and sends. In the daemon it is the Beeper inbox (inboxBackend).
type backend interface {
	// bots lists Leon's Grok bots. refresh asks for a fresh list, for a bot created or renamed since
	// the last one.
	bots(ctx context.Context, refresh bool) ([]bot, error)
	// messages reads one page of a chat's history, newest messages, in any order: wanted of them at
	// most. This is the slow way to read (about half a second per message through the inbox); live is
	// the fast one.
	messages(ctx context.Context, chatID string, wanted int) ([]message, error)
	// send sends as Leon. key names this one send, so retrying it can never post twice.
	send(ctx context.Context, chatID, text, key string) (id string, err error)
	// live follows chats through the journal, or is nil for a backend that has none.
	live() live
}

// live is new messages as they arrive, from the inbox's journal. With it the relay waits for a
// reply, judges whether a bot is busy and answers follow-up reads without reading history.
type live interface {
	// coveredSince is the time from which latest and since are known to hold every message.
	coveredSince() (int64, error)
	// latest returns the newest count messages of a chat that the journal holds.
	latest(chatID string, count int) ([]message, error)
	// since returns a chat's messages sent at or after a time.
	since(chatID string, sinceMS int64) ([]message, error)
	// cursor is the position for "from now on".
	cursor() (int64, error)
	// changes returns the messages of a chat that arrived or changed after a position, and the
	// position to ask from next. It waits up to wait for the first one.
	changes(ctx context.Context, chatID string, cursor int64, wait time.Duration) ([]message, int64, error)
}

// toolFunc runs one of the Beeper inbox's tools; inside the daemon this is a direct call. The result
// holds what a JSON client would see: objects, arrays, strings, float64 numbers and nil.
type toolFunc func(ctx context.Context, name string, args map[string]any) (map[string]any, error)

// grokNetwork is the inbox's short name for Beeper's "Grok Bot" network (bridge protocol grokbot).
const grokNetwork = "grok"

// historyMax is the most events one history read asks for. A page costs about half a second per
// event, and the inbox reads one page at a time, so a large one holds everything else up.
const historyMax = 20

var bridgeFailed = regexp.MustCompile(`(?i)fail`)

// inboxBackend is the relay's reads and sends through Hermes's Beeper inbox: Matrix, with no Beeper
// Desktop. With the inbox's journal it follows chats live.
type inboxBackend struct {
	tool    toolFunc
	journal host.Journal
}

func records(value any) []map[string]any {
	list, _ := value.([]any)
	var found []map[string]any
	for _, item := range list {
		if record, ok := item.(map[string]any); ok {
			found = append(found, record)
		}
	}
	return found
}

// bots pages through the Grok network's one-to-one chats. Numbers go to the inbox's tools as
// float64, the type a JSON call from Hermes carries.
func (b *inboxBackend) bots(ctx context.Context, refresh bool) ([]bot, error) {
	bots := []bot{}
	offset := 0.0
	for page := 0; page < 10; page++ {
		args := map[string]any{
			"network":     grokNetwork,
			"direct_only": true,
			"limit":       100.0,
			"offset":      offset,
		}
		if refresh && page == 0 {
			args["refresh"] = true
		}
		result, err := b.tool(ctx, "list_conversations", args)
		if err != nil {
			return nil, err
		}
		for _, room := range records(result["conversations"]) {
			roomID, ok := room["room_id"].(string)
			if !ok {
				continue
			}
			name, _ := room["name"].(string)
			if name == "" {
				name = roomID
			}
			found := bot{Name: name, ChatID: roomID}
			if lastActivity, ok := room["last_activity"].(string); ok {
				found.LastActivity = &lastActivity
			}
			bots = append(bots, found)
		}
		next, ok := result["next_offset"].(float64)
		if !ok {
			break
		}
		offset = next
	}
	return bots, nil
}

func (b *inboxBackend) messages(ctx context.Context, chatID string, wanted int) ([]message, error) {
	result, err := b.tool(ctx, "list_messages", map[string]any{
		"room_id": chatID,
		"limit":   float64(min(max(wanted, 1), historyMax)),
	})
	if err != nil {
		return nil, err
	}
	found := []message{}
	position := map[string]int{}
	for _, record := range records(result["messages"]) {
		id, hasID := record["event_id"].(string)
		ts, hasTS := record["ts"].(float64)
		timestamp, hasTimestamp := record["timestamp"].(string)
		if !hasID || !hasTS || !hasTimestamp {
			continue
		}
		text, _ := record["text"].(string)
		entry := message{
			ID:        id,
			ChatID:    chatID,
			SortKey:   sortKeyOf(int64(ts), id),
			IsSender:  record["is_me"] == true,
			Text:      text,
			Timestamp: timestamp,
		}
		if kind, ok := record["type"].(string); ok && kind != "m.text" {
			entry.Type = kind
		}
		// An event listed twice keeps its first place and its last reading.
		if index, seen := position[id]; seen {
			found[index] = entry
			continue
		}
		position[id] = len(found)
		found = append(found, entry)
	}
	return found, nil
}

// send calls the inbox's send_message. The daemon knows the call comes from this service, which is
// the only one allowed to write in a Grok chat.
func (b *inboxBackend) send(ctx context.Context, chatID, text, key string) (string, error) {
	result, err := b.tool(ctx, "send_message", map[string]any{
		"room_id":         chatID,
		"text":            text,
		"idempotency_key": key,
	})
	if err != nil {
		return "", err
	}
	id, _ := result["event_id"].(string)
	if id == "" {
		return "", errors.New("Beeper accepted the message but gave no event ID for it")
	}
	bridge, _ := result["bridge_status"].(map[string]any)
	if status, ok := bridge["status"].(string); ok && bridgeFailed.MatchString(status) {
		detail := ""
		if reason, ok := bridge["message"].(string); ok {
			detail = ": " + utf16Prefix(reason, 200)
		}
		return "", errors.New("The message reached Beeper but the Grok Bot bridge reported " + status + detail + ". The bot may not have received it.")
	}
	return id, nil
}

func (b *inboxBackend) live() live {
	if b.journal == nil {
		return nil
	}
	return journalLive{b.journal}
}

// journalLive reads the inbox's journal as the relay's messages.
type journalLive struct {
	journal host.Journal
}

func fromJournal(entry host.JournalEntry) message {
	mapped := message{
		ID:        entry.EventID,
		ChatID:    entry.RoomID,
		SortKey:   sortKeyOf(entry.TS, entry.EventID),
		IsSender:  entry.IsMe,
		Text:      entry.Text,
		Timestamp: isoTime(entry.TS),
		IsDeleted: entry.Redacted,
	}
	if entry.Type != "m.text" {
		mapped.Type = entry.Type
	}
	return mapped
}

func fromJournalAll(entries []host.JournalEntry, err error) ([]message, error) {
	if err != nil {
		return nil, err
	}
	mapped := make([]message, len(entries))
	for index, entry := range entries {
		mapped[index] = fromJournal(entry)
	}
	return mapped, nil
}

func (l journalLive) coveredSince() (int64, error) { return l.journal.CoveredSince() }

func (l journalLive) latest(chatID string, count int) ([]message, error) {
	return fromJournalAll(l.journal.Latest(chatID, count))
}

func (l journalLive) since(chatID string, sinceMS int64) ([]message, error) {
	return fromJournalAll(l.journal.Since(chatID, sinceMS))
}

func (l journalLive) cursor() (int64, error) { return l.journal.Head() }

func (l journalLive) changes(ctx context.Context, chatID string, cursor int64, wait time.Duration) ([]message, int64, error) {
	entries, next, err := l.journal.Changes(ctx, host.ChangesOptions{After: cursor, RoomID: chatID, Wait: wait})
	if err != nil {
		return nil, cursor, err
	}
	mapped, _ := fromJournalAll(entries, nil)
	return mapped, next, nil
}
