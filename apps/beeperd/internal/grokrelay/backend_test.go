package grokrelay

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/host"
)

// These are the cases of slack22grokbot/__tests__/backend.test.ts.

type toolCall struct {
	name string
	args map[string]any
}

// fakeInbox answers the inbox's tools from a script, and notes what was asked.
type fakeInbox struct {
	answers map[string][]map[string]any
	calls   []toolCall
}

func (f *fakeInbox) tool(_ context.Context, name string, args map[string]any) (map[string]any, error) {
	f.calls = append(f.calls, toolCall{name, args})
	if len(f.answers[name]) == 0 {
		return nil, errors.New("unexpected " + name)
	}
	next := f.answers[name][0]
	f.answers[name] = f.answers[name][1:]
	return throughJSON(next), nil
}

// throughJSON is a tool's result as the daemon hands it to a service: what a JSON client would see.
func throughJSON(result map[string]any) map[string]any {
	data, err := json.Marshal(result)
	if err != nil {
		panic(err)
	}
	var plain map[string]any
	if err := json.Unmarshal(data, &plain); err != nil {
		panic(err)
	}
	return plain
}

func (f *fakeInbox) args() []map[string]any {
	asked := make([]map[string]any, len(f.calls))
	for index, call := range f.calls {
		asked[index] = call.args
	}
	return asked
}

// stubJournal is a journal that says what it is told to.
type stubJournal struct {
	head, covered int64
	latest, since []host.JournalEntry
	changes       func(options host.ChangesOptions) ([]host.JournalEntry, int64, error)
}

func (j *stubJournal) Head() (int64, error)         { return j.head, nil }
func (j *stubJournal) CoveredSince() (int64, error) { return j.covered, nil }
func (j *stubJournal) Latest(string, int) ([]host.JournalEntry, error) {
	return j.latest, nil
}
func (j *stubJournal) Since(string, int64) ([]host.JournalEntry, error) {
	return j.since, nil
}
func (j *stubJournal) Recent(int64, int) ([]host.JournalEntry, error) { return nil, nil }
func (j *stubJournal) Changes(_ context.Context, options host.ChangesOptions) ([]host.JournalEntry, int64, error) {
	return j.changes(options)
}
func (j *stubJournal) Subscribe(func()) func() { return func() {} }

func text(value string) *string { return &value }

func TestBotsTheGrokNetworksOneToOneChatsAcrossPagesRefreshingOnlyWhenAsked(t *testing.T) {
	inbox := &fakeInbox{answers: map[string][]map[string]any{
		"list_conversations": {
			{
				"conversations": []any{
					map[string]any{"room_id": "!a:beeper.local", "name": "Google Bot", "last_activity": "2026-11-20T20:43:56.205Z"},
					map[string]any{"room_id": "!b:beeper.local", "name": nil},
				},
				"next_offset": 2,
			},
			{"conversations": []map[string]any{{"room_id": "!c:beeper.local", "name": "UofT Bot"}}, "next_offset": nil},
		},
	}}
	backend := &inboxBackend{tool: inbox.tool}
	bots, err := backend.bots(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	want := []bot{
		{Name: "Google Bot", ChatID: "!a:beeper.local", LastActivity: text("2026-11-20T20:43:56.205Z")},
		{Name: "!b:beeper.local", ChatID: "!b:beeper.local"},
		{Name: "UofT Bot", ChatID: "!c:beeper.local"},
	}
	if !reflect.DeepEqual(bots, want) {
		t.Errorf("bots = %+v, want %+v", bots, want)
	}
	// Numbers go to the inbox as float64, like a JSON call's.
	wantArgs := []map[string]any{
		{"network": "grok", "direct_only": true, "limit": 100.0, "offset": 0.0, "refresh": true},
		{"network": "grok", "direct_only": true, "limit": 100.0, "offset": 2.0},
	}
	if !reflect.DeepEqual(inbox.args(), wantArgs) {
		t.Errorf("asked %v, want %v", inbox.args(), wantArgs)
	}
}

func TestMessagesOnePageOfHistoryCappedMappedAndKeyedByTimeThenEventID(t *testing.T) {
	event := func(id string, ts int64, extra map[string]any) map[string]any {
		record := map[string]any{
			"event_id":  id,
			"ts":        ts,
			"timestamp": isoTime(ts),
			"type":      "m.text",
			"text":      id,
			"is_me":     false,
		}
		for key, value := range extra {
			record[key] = value
		}
		return record
	}
	inbox := &fakeInbox{answers: map[string][]map[string]any{
		"list_messages": {
			{
				"messages": []any{
					event("$new", 1795000002000, map[string]any{"type": "m.notice"}),
					map[string]any{"event_id": "$broken"},
					event("$old", 1795000001000, map[string]any{"is_me": true}),
				},
				"next_cursor": "older",
			},
			{"messages": []any{}},
		},
	}}
	backend := &inboxBackend{tool: inbox.tool}
	messages, err := backend.messages(context.Background(), "!a:beeper.local", 500)
	if err != nil {
		t.Fatal(err)
	}
	want := []message{
		{ID: "$new", ChatID: "!a:beeper.local", SortKey: "1795000002000:$new", Text: "$new", Timestamp: isoTime(1795000002000), Type: "m.notice"},
		{ID: "$old", ChatID: "!a:beeper.local", SortKey: "1795000001000:$old", IsSender: true, Text: "$old", Timestamp: isoTime(1795000001000)},
	}
	if !reflect.DeepEqual(messages, want) {
		t.Errorf("messages = %+v, want %+v", messages, want)
	}
	if _, err := backend.messages(context.Background(), "!a:beeper.local", 3); err != nil {
		t.Fatal(err)
	}
	// never more than one capped page: history costs about half a second a message
	wantArgs := []map[string]any{
		{"room_id": "!a:beeper.local", "limit": float64(historyMax)},
		{"room_id": "!a:beeper.local", "limit": 3.0},
	}
	if !reflect.DeepEqual(inbox.args(), wantArgs) {
		t.Errorf("asked %v, want %v", inbox.args(), wantArgs)
	}
	if !(sortKeyOf(999, "$z") < sortKeyOf(1000, "$a")) {
		t.Error("an earlier time must sort first as a string")
	}
}

func TestLiveTheInboxsJournalAsTheRelaysMessages(t *testing.T) {
	entry := host.JournalEntry{
		Seq:        4,
		Rev:        9,
		RoomID:     "!a:beeper.local",
		EventID:    "$j",
		Sender:     "@bot:beeper.local",
		Type:       "m.notice",
		Text:       "working",
		TS:         1795000003000,
		ReceivedAt: 1795000003500,
		Edited:     true,
	}
	if (&inboxBackend{tool: (&fakeInbox{}).tool}).live() != nil {
		t.Error("no journal, no live path")
	}
	redacted := entry
	redacted.Redacted, redacted.Text = true, ""
	var asked []host.ChangesOptions
	journal := &stubJournal{
		head:    9,
		covered: 1795000000000,
		latest:  []host.JournalEntry{entry},
		since:   []host.JournalEntry{redacted},
		changes: func(options host.ChangesOptions) ([]host.JournalEntry, int64, error) {
			asked = append(asked, options)
			return []host.JournalEntry{entry}, 9, nil
		},
	}
	live := (&inboxBackend{tool: (&fakeInbox{}).tool, journal: journal}).live()
	if live == nil {
		t.Fatal("a journal gives the live path")
	}
	mapped := message{
		ID:        "$j",
		ChatID:    "!a:beeper.local",
		SortKey:   "1795000003000:$j",
		Text:      "working",
		Timestamp: isoTime(1795000003000),
		Type:      "m.notice",
	}
	if latest, _ := live.latest("!a:beeper.local", 5); !reflect.DeepEqual(latest, []message{mapped}) {
		t.Errorf("latest = %+v", latest)
	}
	deleted := mapped
	deleted.Text, deleted.IsDeleted = "", true
	if since, _ := live.since("!a:beeper.local", 0); !reflect.DeepEqual(since, []message{deleted}) {
		t.Errorf("since = %+v", since)
	}
	changed, cursor, err := live.changes(context.Background(), "!a:beeper.local", 3, 1500*time.Millisecond)
	if err != nil || cursor != 9 || !reflect.DeepEqual(changed, []message{mapped}) {
		t.Errorf("changes = %+v, %d, %v", changed, cursor, err)
	}
	wantAsked := []host.ChangesOptions{{After: 3, RoomID: "!a:beeper.local", Wait: 1500 * time.Millisecond}}
	if !reflect.DeepEqual(asked, wantAsked) {
		t.Errorf("asked the journal %+v, want %+v", asked, wantAsked)
	}
	position, _ := live.cursor()
	covered, _ := live.coveredSince()
	mustEqual(t, position, 9)
	mustEqual(t, covered, 1795000000000)
}

func TestSendPassesTheKeyThroughAndABridgeFailureIsAnError(t *testing.T) {
	inbox := &fakeInbox{answers: map[string][]map[string]any{
		"send_message": {
			{"event_id": "$sent", "bridge_status": map[string]any{"status": "SUCCESS"}},
			{"event_id": "$lost", "bridge_status": map[string]any{"status": "FAIL_PERMANENT", "message": "bot is gone"}},
			{"bridge_status": map[string]any{"status": "not_observed"}},
		},
	}}
	backend := &inboxBackend{tool: inbox.tool}
	id, err := backend.send(context.Background(), "!a:beeper.local", "hi", "send-1")
	if err != nil || id != "$sent" {
		t.Errorf("send = %q, %v", id, err)
	}
	// Nothing says who is calling: the daemon knows which service runs the tool.
	wantArgs := map[string]any{"room_id": "!a:beeper.local", "text": "hi", "idempotency_key": "send-1"}
	if !reflect.DeepEqual(inbox.calls[0].args, wantArgs) {
		t.Errorf("asked %v, want %v", inbox.calls[0].args, wantArgs)
	}
	if _, err := backend.send(context.Background(), "!a:beeper.local", "hi", "send-2"); err == nil {
		t.Error("a failed bridge delivery was accepted")
	} else {
		mustMatch(t, err.Error(), `FAIL_PERMANENT: bot is gone`)
	}
	if _, err := backend.send(context.Background(), "!a:beeper.local", "hi", "send-3"); err == nil {
		t.Error("a send with no event ID was accepted")
	} else {
		mustMatch(t, err.Error(), `no event ID`)
	}
}

func TestARefusedInboxToolKeepsItsMessage(t *testing.T) {
	refused := func(context.Context, string, map[string]any) (map[string]any, error) {
		return nil, &host.ToolError{Code: "unavailable", Message: "Beeper is unreachable"}
	}
	_, err := (&inboxBackend{tool: refused}).bots(context.Background(), false)
	if err == nil || err.Error() != "Beeper is unreachable" {
		t.Errorf("err = %v", err)
	}
}
