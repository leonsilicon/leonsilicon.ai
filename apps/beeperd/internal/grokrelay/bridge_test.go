package grokrelay

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/handoff"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/host"
)

// The first test is the case of slack22grokbot/__tests__/slack22grokbot.test.ts.

const bridgeStart = int64(1_795_280_001_000)

var (
	wrongThread = handoff.SlackThread{Channel: "C0TASKS002", ThreadTS: taskThread.ThreadTS}
	taskBotName = handoff.TaskName(taskThread)
)

// fakeSlack is a workspace with one thread, whose first copy of a Grok message loses its answer.
type fakeSlack struct {
	t       *testing.T
	replies []slackReply

	mu     sync.Mutex
	copies []mirrorPost
	fail   bool
}

func (s *fakeSlack) thread(_ context.Context, target handoff.SlackThread, after string) (slackThreadPage, error) {
	if target.Channel != taskThread.Channel {
		return slackThreadPage{}, errors.New("thread_not_found")
	}
	page := slackThreadPage{Channel: target.Channel, Cursor: target.ThreadTS, Replies: []slackReply{}}
	if after != "" {
		page.Cursor = after
		for _, reply := range s.replies {
			if reply.TS > after {
				page.Replies = append(page.Replies, reply)
				page.Cursor = reply.TS
			}
		}
	}
	return page, nil
}

func (s *fakeSlack) mirror(_ context.Context, target handoff.SlackThread, post mirrorPost) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if target != taskThread {
		s.t.Errorf("mirrored to %v", target)
	}
	s.copies = append(s.copies, post)
	if s.fail {
		s.fail = false
		return "", errors.New("response lost")
	}
	return "1795280002.123000", nil
}

type fakeRoster struct {
	mu   sync.Mutex
	bots []rosterBot
}

func (r *fakeRoster) list(context.Context) ([]rosterBot, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.bots), nil
}

func (r *fakeRoster) remove(_ context.Context, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.bots = slices.DeleteFunc(r.bots, func(listed rosterBot) bool { return listed.ID == id })
	return nil
}

func (r *fakeRoster) ids() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	ids := make([]string, len(r.bots))
	for index, listed := range r.bots {
		ids[index] = listed.ID
	}
	return ids
}

// fakeGrokChats is Beeper with a fixed list of Grok chats; it notes what is sent to them.
type fakeGrokChats struct {
	rooms []bot

	mu    sync.Mutex
	sends []postedMessage
}

func (c *fakeGrokChats) bots(context.Context, bool) ([]bot, error) { return slices.Clone(c.rooms), nil }

func (c *fakeGrokChats) messages(context.Context, string, int) ([]message, error) { return nil, nil }

func (c *fakeGrokChats) send(_ context.Context, chatID, text, key string) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sends = append(c.sends, postedMessage{chatID, text, key})
	return "$sent", nil
}

func (c *fakeGrokChats) live() live { return nil }

func TestRoutesByTheFullBotNameRetriesAcrossRestartsMirrorsEditsAndRetiresOnlyTheCompletedBot(t *testing.T) {
	ctx := context.Background()
	var entries []host.JournalEntry
	entry := func(rev int64, text string, isMe bool) host.JournalEntry {
		return host.JournalEntry{
			Seq:        1,
			Rev:        rev,
			RoomID:     "!grok:test",
			EventID:    "$grok",
			Sender:     "@sender:test",
			IsMe:       isMe,
			Type:       "m.text",
			Text:       text,
			TS:         bridgeStart + 1,
			ReceivedAt: bridgeStart + 1,
			Edited:     rev > 1,
		}
	}
	journal := &stubJournal{changes: func(options host.ChangesOptions) ([]host.JournalEntry, int64, error) {
		cursor := options.After
		var found []host.JournalEntry
		for _, held := range entries {
			if held.RoomID == options.RoomID && held.Rev > options.After {
				found = append(found, held)
				cursor = held.Rev
			}
		}
		return found, cursor, nil
	}}
	roster := &fakeRoster{bots: []rosterBot{
		{ID: "1", Name: taskBotName},
		{ID: "2", Name: handoff.TaskName(wrongThread)},
	}}
	slack := &fakeSlack{t: t, fail: true, replies: []slackReply{
		{TS: "1795280002.001000", From: "bot", Author: "Captain Claude", UserID: "UHERMES", Files: []string{}, Text: " to grok bot:  Please check page 2."},
		{TS: "1795280002.002000", From: "leon", Author: "Leon", Files: []string{}, Text: "Include the date."},
		{TS: "1795280002.003000", From: "codex", Author: "Codex", Files: []string{}, Text: "Check the release URL."},
		{TS: "1795280002.004000", From: "bot", Author: "Muse", Files: []string{}, Text: "To Grok Bot: Can you verify the page?"},
	}}
	chats := &fakeGrokChats{rooms: []bot{
		{Name: taskBotName, ChatID: "!grok:test"},
		{Name: handoff.TaskName(wrongThread), ChatID: "!other:test"},
	}}
	options := bridgeOptions{
		stateFile:    filepath.Join(t.TempDir(), "state.json"),
		now:          func() int64 { return bridgeStart },
		hermesUserID: "UHERMES",
		journal:      journal,
		services:     bridgeServices{slack: slack, roster: roster},
		backend:      chats,
		log:          func(string, map[string]any) {},
	}
	open := func() *slackBridge {
		t.Helper()
		bridge, err := newBridge(options)
		if err != nil {
			t.Fatal(err)
		}
		return bridge
	}
	bridge := open()
	entries = append(entries, entry(1, "First Grok result", false))
	if err := bridge.tick(ctx); err != nil {
		t.Fatal(err)
	}
	failures := bridge.status()["errors"].(map[string]string)
	mustEqual(t, failures[taskBotName], "response lost")
	mustEqual(t, failures[handoff.TaskName(wrongThread)], "thread_not_found")
	wantSends := []struct{ chat, text string }{
		// Hermes's reply goes out as Leon's own message, without "To Grok Bot:".
		{"!grok:test", "Please check page 2."},
		{"!grok:test", "Include the date."},
		{"!grok:test", "Slack reply from Codex (collaborator):\nCheck the release URL."},
		{"!grok:test", "Slack reply from Muse (other Slack participant):\nTo Grok Bot: Can you verify the page?"},
	}
	mustEqual(t, len(chats.sends), len(wantSends))
	for index, want := range wantSends {
		mustEqual(t, chats.sends[index].chatID, want.chat)
		mustEqual(t, chats.sends[index].text, want.text)
	}
	if chats.sends[0].key == chats.sends[1].key {
		t.Error("two Slack replies went out under one key")
	}

	// The state as it is on disk between two runs has the TypeScript bridge's shape.
	var saved map[string]any
	data, err := os.ReadFile(options.stateFile)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &saved); err != nil {
		t.Fatal(err)
	}
	wantSaved := map[string]any{
		"started":      float64(bridgeStart),
		"journalStart": 0.0,
		"retired":      []any{},
		"routes": map[string]any{"1": map[string]any{
			"name":         taskBotName,
			"chatID":       "!grok:test",
			"thread":       map[string]any{"channel": "C0TASKS001", "threadTs": "1795280000.123456"},
			"fromMs":       float64(bridgeStart),
			"beeperCursor": 0.0,
			"slackCursor":  "1795280002.004000",
			"mirrors":      map[string]any{"$grok": map[string]any{"started": "1795279941.000000"}},
		}},
	}
	if !reflect.DeepEqual(saved, wantSaved) {
		t.Errorf("saved state = %v\nwant %v", saved, wantSaved)
	}

	bridge = open()
	if err := bridge.tick(ctx); err != nil {
		t.Fatal(err)
	}
	mustEqual(t, slack.copies[1].EventID, slack.copies[0].EventID)
	mustEqual(t, slack.copies[1].RetrySince, "1795279941.000000")
	mustEqual(t, len(chats.sends), 4)

	entries = append(entries, entry(2, "Edited final Grok result", false))
	owner := entry(3, "Slack reply copied into Grok", true)
	owner.EventID = "$owner"
	entries = append(entries, owner)
	result, err := bridge.complete(ctx, taskThread)
	if err != nil {
		t.Fatal(err)
	}
	if want := map[string]any{"ok": true, "deleted": taskBotName}; !reflect.DeepEqual(result, want) {
		t.Errorf("complete = %v, want %v", result, want)
	}
	mustEqual(t, slack.copies[2].SlackTS, "1795280002.123000")
	mustEqual(t, slack.copies[2].Text, "Edited final Grok result")
	mustEqual(t, len(slack.copies), 3)
	if ids := roster.ids(); !reflect.DeepEqual(ids, []string{"2"}) {
		t.Errorf("roster = %v", ids)
	}
	mustEqual(t, open().retired("!grok:test"), true)

	// Asked again, it has nothing left to close.
	result, err = bridge.complete(ctx, taskThread)
	if err != nil {
		t.Fatal(err)
	}
	if want := map[string]any{"ok": true, "already_closed": true}; !reflect.DeepEqual(result, want) {
		t.Errorf("complete again = %v, want %v", result, want)
	}
}

func TestTheBridgeReadsTheStateTheTypeScriptBridgeSaved(t *testing.T) {
	stateFile := filepath.Join(t.TempDir(), "slack22grokbot.json")
	saved := `{
  "started": 1795280001000,
  "journalStart": 41,
  "routes": {
    "7": {
      "name": "Task slack:C0TASKS001/1795280000.123456",
      "chatID": "!grok:test",
      "thread": { "channel": "C0TASKS001", "threadTs": "1795280000.123456" },
      "fromMs": 1795280001000,
      "beeperCursor": 57,
      "slackCursor": "1795280002.004000",
      "mirrors": { "$grok": { "started": "1795279941.000000", "ts": "1795280002.123000", "digest": "abc" } },
      "closing": true
    }
  },
  "retired": ["!old:test"]
}
`
	if err := os.WriteFile(stateFile, []byte(saved), 0o600); err != nil {
		t.Fatal(err)
	}
	bridge, err := newBridge(bridgeOptions{stateFile: stateFile})
	if err != nil {
		t.Fatal(err)
	}
	mustEqual(t, bridge.retired("!old:test"), true)
	mustEqual(t, bridge.retired("!grok:test"), false)
	mustEqual(t, bridge.status()["active"], any(1))
	served := bridge.state.Routes["7"]
	mustEqual(t, served.Thread, taskThread)
	mustEqual(t, served.BeeperCursor, 57)
	mustEqual(t, served.Closing, true)
	mustEqual(t, *served.Mirrors["$grok"], mirrorState{Started: "1795279941.000000", TS: "1795280002.123000", Digest: "abc"})

	// A state file that can't be read is an error, not a fresh start that forgets every route.
	if err := os.WriteFile(stateFile, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := newBridge(bridgeOptions{stateFile: stateFile}); err == nil {
		t.Error("a broken state file was accepted")
	}
}

func TestALongSlackReplyGoesToGrokInPartsWithItsFiles(t *testing.T) {
	ctx := context.Background()
	long := strings.Repeat("é", 8001)
	slack := &fakeSlack{t: t, replies: []slackReply{
		{TS: "1795280002.001000", From: "hermes", Author: "Leon", Text: long, Files: []string{"https://files.test/a.png"}},
		{TS: "1795280002.002000", From: "bot", Author: "  Some\n  Bot ", Text: "", Files: []string{"report.pdf"}},
		{TS: "1795280002.003000", From: "leon", Author: "Leon", Text: " \n "},
	}}
	chats := &fakeGrokChats{rooms: []bot{{Name: taskBotName, ChatID: "!grok:test"}}}
	bridge, err := newBridge(bridgeOptions{
		stateFile: filepath.Join(t.TempDir(), "state.json"),
		now:       func() int64 { return bridgeStart },
		journal:   &stubJournal{changes: func(host.ChangesOptions) ([]host.JournalEntry, int64, error) { return nil, 0, nil }},
		services:  bridgeServices{slack: slack, roster: &fakeRoster{bots: []rosterBot{{ID: "1", Name: taskBotName}}}},
		backend:   chats,
		log:       func(string, map[string]any) {},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := bridge.tick(ctx); err != nil {
		t.Fatal(err)
	}
	mustEqual(t, len(bridge.status()["errors"].(map[string]string)), 0)
	mustEqual(t, len(chats.sends), 3)
	mustEqual(t, chats.sends[0].text, strings.Repeat("é", 8000))
	mustEqual(t, chats.sends[1].text, "é\nSlack attachment: https://files.test/a.png")
	mustEqual(t, chats.sends[2].text, "Slack reply from Some Bot (other Slack participant):\nSlack attachment: report.pdf")
	key := hash("C0TASKS001/1795280002.001000")[:40]
	mustEqual(t, chats.sends[0].key, "slack22grokbot-"+key+"-0")
	mustEqual(t, chats.sends[1].key, "slack22grokbot-"+key+"-8000")
	mustEqual(t, bridge.state.Routes["1"].SlackCursor, "1795280002.003000")
}

// scriptedHTTP answers each request from a function, and notes what was asked.
type scriptedHTTP struct {
	mu       sync.Mutex
	requests []scriptedRequest
	answer   func(request scriptedRequest) (status int, body string)
}

type scriptedRequest struct {
	url, authorization, contentType, body string
}

func (h *scriptedHTTP) Do(request *http.Request) (*http.Response, error) {
	body, _ := io.ReadAll(request.Body)
	asked := scriptedRequest{
		url:           request.URL.String(),
		authorization: request.Header.Get("Authorization"),
		contentType:   request.Header.Get("Content-Type"),
		body:          string(body),
	}
	h.mu.Lock()
	h.requests = append(h.requests, asked)
	h.mu.Unlock()
	status, answer := h.answer(asked)
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(answer)), Header: http.Header{}}, nil
}

var bridgeEnv = map[string]string{
	"SLACK_AS_LEON_PUBLIC_ORIGIN":   "https://slack.test",
	"SLACK_AS_LEON_MCP_TOKEN":       " slack-token ",
	"GROK_BOT_ROSTER_PUBLIC_ORIGIN": "https://admin.test",
	"GROK_BOT_ROSTER_MCP_TOKEN":     "admin-token",
}

func TestTheBridgeCallsSlackPuppetAndTheGrokBotAdminServiceAsTheTypeScriptDid(t *testing.T) {
	ctx := context.Background()
	rosterText := func(value string) string {
		envelope, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "result": map[string]any{"content": []any{map[string]any{"type": "text", "text": value}}}})
		return string(envelope)
	}
	client := &scriptedHTTP{}
	services, err := newBridgeServices(bridgeEnv, client)
	if err != nil {
		t.Fatal(err)
	}

	client.answer = func(scriptedRequest) (int, string) {
		return 200, `{"channel":"C0TASKS001","cursor":"1795280002.001000","replies":[{"ts":"1795280002.001000","from":"leon","author":"Leon","userId":"ULEON","text":"hi","files":["a.png"]}]}`
	}
	page, err := services.slack.thread(ctx, handoff.SlackThread{Channel: "#leon-42", ThreadTS: "1795280000.123456"}, "")
	if err != nil {
		t.Fatal(err)
	}
	wantPage := slackThreadPage{Channel: "C0TASKS001", Cursor: "1795280002.001000", Replies: []slackReply{
		{TS: "1795280002.001000", From: "leon", Author: "Leon", UserID: "ULEON", Text: "hi", Files: []string{"a.png"}},
	}}
	if !reflect.DeepEqual(page, wantPage) {
		t.Errorf("thread = %+v", page)
	}
	if _, err := services.slack.thread(ctx, taskThread, "1795280001.000000"); err != nil {
		t.Fatal(err)
	}

	client.answer = func(scriptedRequest) (int, string) { return 200, `{"ts":"1795280002.123000"}` }
	ts, err := services.slack.mirror(ctx, taskThread, mirrorPost{Bot: taskBotName, EventID: "$grok", Text: "a <b> & c"})
	if err != nil || ts != "1795280002.123000" {
		t.Errorf("mirror = %q, %v", ts, err)
	}
	if _, err := services.slack.mirror(ctx, taskThread, mirrorPost{Bot: taskBotName, EventID: "$grok", Text: "again", RetrySince: "1795279941.000000"}); err != nil {
		t.Fatal(err)
	}
	if _, err := services.slack.mirror(ctx, taskThread, mirrorPost{Bot: taskBotName, EventID: "$grok", Text: "edited", SlackTS: "1795280002.123000"}); err != nil {
		t.Fatal(err)
	}

	client.answer = func(scriptedRequest) (int, string) {
		return 200, rosterText(`{"ok":true,"bots":[{"id":"1","agent_id":"a-1","name":"Task Bot","created_at":"2026-11-21T18:00:00.000Z"},{"id":"2","name":"Old Bot","created_at":null}]}`)
	}
	bots, err := services.roster.list(ctx)
	if err != nil {
		t.Fatal(err)
	}
	wantBots := []rosterBot{{ID: "1", Name: "Task Bot", CreatedAt: text("2026-11-21T18:00:00.000Z")}, {ID: "2", Name: "Old Bot"}}
	if !reflect.DeepEqual(bots, wantBots) {
		t.Errorf("roster = %+v", bots)
	}
	client.answer = func(scriptedRequest) (int, string) { return 200, rosterText(`{"ok":true,"deleted":"Task Bot"}`) }
	if err := services.roster.remove(ctx, "1"); err != nil {
		t.Fatal(err)
	}

	want := []scriptedRequest{
		{"https://slack.test/slack22grokbot/thread", "Bearer slack-token", "application/json", `{"channel":"#leon-42","threadTs":"1795280000.123456"}`},
		{"https://slack.test/slack22grokbot/thread", "Bearer slack-token", "application/json", `{"channel":"C0TASKS001","threadTs":"1795280000.123456","after":"1795280001.000000"}`},
		{"https://slack.test/slack22grokbot/message", "Bearer slack-token", "application/json", `{"channel":"C0TASKS001","threadTs":"1795280000.123456","bot":"Task slack:C0TASKS001/1795280000.123456","eventId":"$grok","text":"a <b> & c"}`},
		{"https://slack.test/slack22grokbot/message", "Bearer slack-token", "application/json", `{"channel":"C0TASKS001","threadTs":"1795280000.123456","bot":"Task slack:C0TASKS001/1795280000.123456","eventId":"$grok","text":"again","retrySince":"1795279941.000000"}`},
		{"https://slack.test/slack22grokbot/message", "Bearer slack-token", "application/json", `{"channel":"C0TASKS001","threadTs":"1795280000.123456","bot":"Task slack:C0TASKS001/1795280000.123456","eventId":"$grok","text":"edited","slackTs":"1795280002.123000"}`},
		{"https://admin.test/mcp", "Bearer admin-token", "application/json", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"grok_bots_list","arguments":{}}}`},
		{"https://admin.test/mcp", "Bearer admin-token", "application/json", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"grok_bot_delete","arguments":{"bot":"1"}}}`},
	}
	if !reflect.DeepEqual(client.requests, want) {
		for index, asked := range client.requests {
			if index >= len(want) || asked != want[index] {
				t.Errorf("request %d = %+v", index, asked)
			}
		}
	}

	// Refusals keep the service's own words.
	for _, c := range []struct {
		status  int
		body    string
		call    func() error
		pattern string
	}{
		{400, `{"error":"thread_not_found"}`, func() error { _, err := services.slack.thread(ctx, taskThread, ""); return err }, `^thread_not_found$`},
		{502, `{}`, func() error { _, err := services.slack.thread(ctx, taskThread, ""); return err }, `^Bridge HTTP 502$`},
		{200, rosterText(`{"ok":false,"refused":"That ID isn't one of Leon's bots."}`), func() error { return services.roster.remove(ctx, "9") }, `^That ID isn't one of Leon's bots\.$`},
		{200, rosterText(`{"ok":false,"error":"signed out"}`), func() error { _, err := services.roster.list(ctx); return err }, `^signed out$`},
		{200, `{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Unknown tool"}}`, func() error { return services.roster.remove(ctx, "9") }, `^Grok Bot admin refused grok_bot_delete$`},
		{200, rosterText(`{"ok":true}`), func() error { _, err := services.roster.list(ctx); return err }, `^Grok Bot admin returned no roster$`},
		{401, `{"error":"unauthorized"}`, func() error { _, err := services.roster.list(ctx); return err }, `^unauthorized$`},
	} {
		client.answer = func(scriptedRequest) (int, string) { return c.status, c.body }
		mustRefuse(t, c.call(), c.pattern)
	}
}

func TestTheBridgeNeedsAllFourSettings(t *testing.T) {
	for _, missing := range []string{
		"SLACK_AS_LEON_PUBLIC_ORIGIN",
		"SLACK_AS_LEON_MCP_TOKEN",
		"GROK_BOT_ROSTER_PUBLIC_ORIGIN",
		"GROK_BOT_ROSTER_MCP_TOKEN",
	} {
		env := map[string]string{}
		for key, value := range bridgeEnv {
			if key != missing {
				env[key] = value
			}
		}
		_, err := newBridgeServices(env, &scriptedHTTP{})
		mustRefuse(t, err, "^slack22grokbot needs "+missing+"$")
	}
}

func TestOnlyALeadingGrokAddressIsDropped(t *testing.T) {
	for text, want := range map[string]string{
		"To Grok Bot: Retry the fill.":         "Retry the fill.",
		"\n TO GROK BOT:\nRetry the fill.":     "Retry the fill.",
		"To Grok Bot:":                         "",
		"To Muse: Check the page.":             "To Muse: Check the page.",
		"Ask it. To Grok Bot: Retry the fill.": "Ask it. To Grok Bot: Retry the fill.",
		"To Grok":                              "To Grok",
		"Tö Grok Bot: Retry the fill.":         "Tö Grok Bot: Retry the fill.",
	} {
		mustEqual(t, withoutGrokAddress(text), want)
	}
}
