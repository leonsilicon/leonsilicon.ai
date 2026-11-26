package grokrelay

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/handoff"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/host"
)

// The service as the daemon runs it, against a fake daemon: what Start reads, what the tools
// answer, and that Stop ends everything.

// memoryJournal is a journal in memory that wakes waiters like the real one.
type memoryJournal struct {
	mu      sync.Mutex
	entries []host.JournalEntry
	head    int64
}

func (j *memoryJournal) add(roomID, eventID, body string, isMe bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.head++
	now := time.Now().UnixMilli()
	j.entries = append(j.entries, host.JournalEntry{
		Seq: j.head, Rev: j.head, RoomID: roomID, EventID: eventID, IsMe: isMe, Type: "m.text", Text: body, TS: now, ReceivedAt: now,
	})
}

func (j *memoryJournal) Head() (int64, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.head, nil
}

func (j *memoryJournal) CoveredSince() (int64, error) { return 0, nil }

func (j *memoryJournal) room(roomID string, keep func(host.JournalEntry) bool) []host.JournalEntry {
	j.mu.Lock()
	defer j.mu.Unlock()
	var found []host.JournalEntry
	for _, entry := range j.entries {
		if entry.RoomID == roomID && keep(entry) {
			found = append(found, entry)
		}
	}
	return found
}

func (j *memoryJournal) Latest(roomID string, count int) ([]host.JournalEntry, error) {
	held := j.room(roomID, func(host.JournalEntry) bool { return true })
	return held[max(0, len(held)-count):], nil
}

func (j *memoryJournal) Since(roomID string, sinceTS int64) ([]host.JournalEntry, error) {
	return j.room(roomID, func(entry host.JournalEntry) bool { return entry.TS >= sinceTS }), nil
}

func (j *memoryJournal) Recent(int64, int) ([]host.JournalEntry, error) { return nil, nil }

func (j *memoryJournal) Changes(ctx context.Context, options host.ChangesOptions) ([]host.JournalEntry, int64, error) {
	deadline := time.Now().Add(options.Wait)
	for {
		found := j.room(options.RoomID, func(entry host.JournalEntry) bool { return entry.Rev > options.After })
		if len(found) > 0 || !time.Now().Before(deadline) || ctx.Err() != nil {
			cursor := options.After
			if len(found) > 0 {
				cursor = found[len(found)-1].Rev
			}
			return found, cursor, nil
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (j *memoryJournal) Subscribe(func()) func() { return func() {} }

type hostLog struct {
	level, message string
	fields         map[string]any
}

// fakeHost is the daemon as the service sees it: a few Grok chats, a journal and a log.
type fakeHost struct {
	home    string
	journal *memoryJournal
	rooms   map[string]string

	mu    sync.Mutex
	calls []toolCall
	logs  []hostLog
}

func newFakeHost(t *testing.T) *fakeHost {
	return &fakeHost{
		home:    filepath.Join(t.TempDir(), serviceName),
		journal: &memoryJournal{},
		rooms:   map[string]string{"!task:beeper.local": "Task Bot", "!parent:beeper.local": "Grok Bot"},
	}
}

func (h *fakeHost) Tool(_ context.Context, name string, args map[string]any) (map[string]any, error) {
	h.mu.Lock()
	h.calls = append(h.calls, toolCall{name, args})
	sent := len(h.calls)
	rooms := maps.Clone(h.rooms)
	h.mu.Unlock()
	switch name {
	case "list_conversations":
		var conversations []map[string]any
		for _, roomID := range slices.Sorted(maps.Keys(rooms)) {
			conversations = append(conversations, map[string]any{"room_id": roomID, "name": rooms[roomID], "last_activity": nil})
		}
		return throughJSON(map[string]any{"conversations": conversations, "next_offset": nil}), nil
	case "send_message":
		eventID := "$sent" + strconv.Itoa(sent)
		h.journal.add(args["room_id"].(string), eventID, args["text"].(string), true)
		return throughJSON(map[string]any{"event_id": eventID, "bridge_status": map[string]any{"status": "SUCCESS"}}), nil
	case "list_messages":
		return throughJSON(map[string]any{"messages": []any{}}), nil
	}
	return nil, &host.ToolError{Code: "unknown_tool", Message: "unknown tool " + name}
}

func (h *fakeHost) Journal() host.Journal { return h.journal }
func (h *fakeHost) Rooms(context.Context, []string) ([]host.RoomInfo, error) {
	return nil, nil
}
func (h *fakeHost) Connections(context.Context) ([]host.Connection, error) { return nil, nil }
func (h *fakeHost) SenderNames(context.Context, []string) (map[string]string, error) {
	return nil, nil
}
func (h *fakeHost) PublishLinearIssue(context.Context, string, map[string]any) error { return nil }
func (h *fakeHost) PublishProjectAppearance(context.Context, string, map[string]any) error {
	return nil
}
func (h *fakeHost) PublishProjectVisibility(context.Context, map[string]any) error { return nil }
func (h *fakeHost) Home() string                                                   { return h.home }
func (h *fakeHost) Log() host.Logger {
	return func(level, message string, fields map[string]any) {
		h.mu.Lock()
		defer h.mu.Unlock()
		h.logs = append(h.logs, hostLog{level, message, fields})
	}
}

// sends returns what the service sent through the inbox's send_message.
func (h *fakeHost) sends() []map[string]any {
	h.mu.Lock()
	defer h.mu.Unlock()
	var sent []map[string]any
	for _, call := range h.calls {
		if call.name == "send_message" {
			sent = append(sent, call.args)
		}
	}
	return sent
}

func (h *fakeHost) logged(message string) *hostLog {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, entry := range h.logs {
		if entry.message == message {
			return &entry
		}
	}
	return nil
}

// writeSettings writes the relay's own settings file, slack22grokbot.env.
func (h *fakeHost) writeSettings(t *testing.T, content string) {
	t.Helper()
	if err := os.MkdirAll(h.home, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(h.home, "slack22grokbot.env"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

const fullSettings = `SLACK_AS_LEON_PUBLIC_ORIGIN=https://slack.test
SLACK_AS_LEON_MCP_TOKEN=slack-token
GROK_BOT_ROSTER_PUBLIC_ORIGIN=https://admin.test
GROK_BOT_ROSTER_MCP_TOKEN=admin-token
SLACK_HERMES_USER_ID=UHERMES
`

// testService is the service with the outside world replaced: Hermes lives in hermesHome, and
// nothing reaches the network or runs a command unless the test says how.
func testService(hermesHome string, client httpDoer, box boxDeps) *service {
	now := func() int64 { return time.Now().UnixMilli() }
	if box.now == nil {
		box.now = now
	}
	return &service{
		now:    now,
		client: client,
		getenv: func(key string) string {
			if key == "HERMES_HOME" {
				return hermesHome
			}
			return ""
		},
		box:        box,
		cycleEvery: cycleEvery,
		boxEvery:   boxEvery,
	}
}

func start(t *testing.T, s *service, h *fakeHost) host.Running {
	t.Helper()
	running, err := s.Start(context.Background(), h)
	if err != nil {
		t.Fatal(err)
	}
	return running
}

func mustCall(t *testing.T, running host.Running, name string, args map[string]any) map[string]any {
	t.Helper()
	result, err := running.CallTool(context.Background(), name, args)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

// asJSON is a result as Hermes receives it.
func asJSON(t *testing.T, value any) string {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func refusal(message string) map[string]any {
	return map[string]any{"ok": false, "error": map[string]any{"code": "slack22grokbot_error", "message": message}}
}

func TestTheServiceIsTheMCPServerTheTypeScriptExtensionServed(t *testing.T) {
	service := Service()
	mustEqual(t, service.Name(), "slack22grokbot")
	server := service.Server()
	mustEqual(t, server.Name, "slack22grokbot")
	mustEqual(t, server.Version, "1.7.1")
	mustMatch(t, server.Instructions, `^This server reaches Leon's Grok Bot bots`)
	var names []string
	for _, tool := range server.Tools {
		names = append(names, tool.Name)
		if tool.Description == "" || !json.Valid(tool.InputSchema) || !json.Valid(tool.Annotations) {
			t.Errorf("%s is incomplete", tool.Name)
		}
	}
	if want := []string{"grok_bots", "grok_bot_send", "grok_task_complete", "grok_bot_read"}; !reflect.DeepEqual(names, want) {
		t.Errorf("tools = %v, want %v", names, want)
	}
	// Nothing of tools.json is lost on the way to Hermes: the server says exactly what the file says.
	var written, served any
	if err := json.Unmarshal(serverJSON, &written); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(asJSON(t, server)), &served); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(served, written) {
		t.Error("the served description differs from tools.json")
	}
}

func TestWithNothingConfiguredTheRelayStillListsAndReadsAndRefusesHandoffs(t *testing.T) {
	h := newFakeHost(t)
	running := start(t, testService(t.TempDir(), &scriptedHTTP{}, boxDeps{}), h)
	defer running.Stop()
	wantStatus := map[string]any{"running": false, "problem": "no settings file", "grokBox": map[string]any{"configured": false}}
	if status := running.Status(); !reflect.DeepEqual(status, wantStatus) {
		t.Errorf("status = %v, want %v", status, wantStatus)
	}
	mustEqual(t, len(h.logs), 0, "a missing settings file is not worth a log line")

	mustEqual(t,
		asJSON(t, mustCall(t, running, "grok_bots", nil)),
		`{"bots":[{"name":"Grok Bot","chatID":"!parent:beeper.local","lastActivity":null},{"name":"Task Bot","chatID":"!task:beeper.local","lastActivity":null}],"ok":true}`,
	)
	mustEqual(t,
		asJSON(t, mustCall(t, running, "grok_bot_read", map[string]any{"bot": "task"})),
		`{"bot":"Task Bot","cursor":null,"messages":[],"ok":true}`,
	)
	handoffArgs := task(map[string]any{"bot": "Task Bot", "text": "do it"})
	for name, want := range map[string]map[string]any{
		"grok_bot_send":      refusal("slack22grokbot is unavailable on this Beeper inbox"),
		"grok_task_complete": refusal("slack22grokbot is unavailable on this Beeper inbox"),
		"grok_bot_delete":    refusal("Unknown tool grok_bot_delete"),
	} {
		if got := mustCall(t, running, name, handoffArgs); !reflect.DeepEqual(got, want) {
			t.Errorf("%s = %v, want %v", name, got, want)
		}
	}
	mustEqual(t,
		asJSON(t, mustCall(t, running, "grok_bot_read", map[string]any{"bot": "Nope"})),
		`{"error":{"code":"slack22grokbot_error","message":"No Grok bot called \"Nope\". Available: Grok Bot, Task Bot"},"ok":false}`,
	)
	mustEqual(t, len(h.sends()), 0)
}

func TestSettingsThatAreIncompleteAreAProblemInTheStatusAndTheLog(t *testing.T) {
	h := newFakeHost(t)
	h.writeSettings(t, strings.Replace(fullSettings, "GROK_BOT_ROSTER_MCP_TOKEN=admin-token\n", "", 1))
	running := start(t, testService(t.TempDir(), &scriptedHTTP{}, boxDeps{}), h)
	defer running.Stop()
	status := running.Status()
	mustEqual(t, status["running"], any(false))
	mustEqual(t, status["problem"], any("slack22grokbot needs GROK_BOT_ROSTER_MCP_TOKEN"))
	entry := h.logged("slack22grokbot_config_error")
	if entry == nil {
		t.Fatal("the config error was not logged")
	}
	// Events that end in _error are warnings; the rest is information.
	mustEqual(t, entry.level, "warn")
	mustEqual(t, entry.fields["message"], any("slack22grokbot needs GROK_BOT_ROSTER_MCP_TOKEN"))
}

func TestTheBoxSettingsAreNotReadFromTheRelaysOwnSettingsFile(t *testing.T) {
	h := newFakeHost(t)
	h.writeSettings(t, "GROK_BOX_BROWSER_TOKEN=tok\nGROK_BOX_TS_OAUTH_CLIENT_ID=cid\n")
	hermesHome := t.TempDir()
	running := start(t, testService(hermesHome, &scriptedHTTP{}, boxDeps{}), h)
	defer running.Stop()
	mustEqual(t, running.Status()["grokBox"].(map[string]any)["configured"], any(false))
	// Hermes's own .env is where the plugin and the keeper both look. It is read again each time.
	if err := os.WriteFile(filepath.Join(hermesHome, ".env"), []byte("GROK_BOX_BROWSER_TOKEN=tok\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	mustEqual(t, running.Status()["grokBox"].(map[string]any)["configured"], any(true))
}

// bridgeHTTP is slack-puppet and the Grok Bot admin service, in memory: every thread exists, and the
// roster is what the test says.
func bridgeHTTP(roster func() []rosterBot) *scriptedHTTP {
	client := &scriptedHTTP{}
	client.answer = func(request scriptedRequest) (int, string) {
		var asked map[string]any
		_ = json.Unmarshal([]byte(request.body), &asked)
		switch {
		case strings.HasSuffix(request.url, "/slack22grokbot/thread"):
			cursor, _ := asked["after"].(string)
			if cursor == "" {
				cursor = asked["threadTs"].(string)
			}
			return 200, `{"channel":"C0TASKS001","cursor":"` + cursor + `","replies":[]}`
		case strings.HasSuffix(request.url, "/slack22grokbot/message"):
			return 200, `{"ts":"1795280002.123000"}`
		case strings.Contains(request.body, "grok_bots_list"):
			inner, _ := json.Marshal(map[string]any{"ok": true, "bots": append([]rosterBot{}, roster()...)})
			envelope, _ := json.Marshal(map[string]any{"result": map[string]any{"content": []any{map[string]any{"text": string(inner)}}}})
			return 200, string(envelope)
		}
		return 500, `{"error":"unexpected request"}`
	}
	return client
}

func (h *scriptedHTTP) asked(suffix string) []scriptedRequest {
	h.mu.Lock()
	defer h.mu.Unlock()
	var found []scriptedRequest
	for _, request := range h.requests {
		if strings.HasSuffix(request.url, suffix) {
			found = append(found, request)
		}
	}
	return found
}

func TestTheStartedRelayHandsOffWaitsThroughTheJournalMirrorsToSlackAndStops(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newFakeHost(t)
		h.writeSettings(t, fullSettings)
		taskRoom := "!worker:beeper.local"
		var mu sync.Mutex
		var roster []rosterBot
		client := bridgeHTTP(func() []rosterBot {
			mu.Lock()
			defer mu.Unlock()
			return slices.Clone(roster)
		})
		running := start(t, testService(t.TempDir(), client, boxDeps{}), h)

		// The bot answers two seconds after the handoff, and says no more.
		time.AfterFunc(2*time.Second, func() {
			h.journal.add("!task:beeper.local", "$reply", "Task slack:C0TASKS001/1795280000.123456", false)
		})
		started := time.Now()
		result := mustCall(t, running, "grok_bot_send", map[string]any{
			"bot":             "Task Bot",
			"text":            " open the dashboard and export the report ",
			"slack_channel":   "#leon-42-fix",
			"slack_thread_ts": "1795280000.123456",
		})
		// The reply came through the journal at once, and 20 s of quiet ended the 90 s wait.
		if waited := time.Since(started); waited < 22*time.Second || waited > 23*time.Second {
			t.Errorf("waited %v, want 2 s for the reply and 20 s of quiet", waited)
		}
		var answer struct {
			OK   bool   `json:"ok"`
			Bot  string `json:"bot"`
			Sent struct {
				MessageID string  `json:"messageID"`
				SentAs    string  `json:"sentAs"`
				Label     *string `json:"label"`
			} `json:"sent"`
			SlackIdentifier string          `json:"slack_identifier"`
			TaskBot         string          `json:"task_bot"`
			Replies         []shapedMessage `json:"replies"`
			Cursor          string          `json:"cursor"`
			Budget          budgetUse       `json:"budget"`
			Note            string          `json:"note"`
		}
		decoder := json.NewDecoder(strings.NewReader(asJSON(t, result)))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&answer); err != nil {
			t.Fatal(err)
		}
		mustEqual(t, answer.OK, true)
		mustEqual(t, answer.Bot, "Task Bot")
		mustEqual(t, answer.Sent.SentAs, "Leon")
		mustEqual(t, answer.SlackIdentifier, "slack:C0TASKS001/1795280000.123456")
		mustEqual(t, answer.TaskBot, taskBotName)
		mustEqual(t, len(answer.Replies), 1)
		mustEqual(t, answer.Replies[0].From, "Task Bot")
		mustEqual(t, answer.Cursor, answer.Replies[0].SortKey)
		mustEqual(t, answer.Budget, budgetUse{Used: 1, Limit: 25})
		mustEqual(t, answer.Note, "The bot may still send more. Call grok_bot_read with this cursor to check later.")

		// It went out through the inbox's send_message, with the handoff after Hermes's text, and
		// nothing that says who is calling.
		sends := h.sends()
		mustEqual(t, len(sends), 1)
		mustEqual(t, sends[0]["room_id"], any("!task:beeper.local"))
		mustEqual(t, sends[0]["text"], any("open the dashboard and export the report\n\n"+taskBlock))
		mustMatch(t, sends[0]["idempotency_key"].(string), `^send-`)
		mustEqual(t, len(sends[0]), 3)
		// Slack was asked whether the thread exists, with the channel as Hermes named it.
		mustEqual(t, client.asked("/slack22grokbot/thread")[0].body, `{"channel":"#leon-42-fix","threadTs":"1795280000.123456"}`)

		// The parent bot makes the task bot, and the next cycle copies what it says to Slack.
		h.mu.Lock()
		h.rooms[taskRoom] = taskBotName
		h.mu.Unlock()
		mu.Lock()
		roster = []rosterBot{{ID: "7", Name: taskBotName}}
		mu.Unlock()
		time.Sleep(cycleEvery + time.Second)
		h.journal.add(taskRoom, "$progress", "Opened the dashboard.", false)
		time.Sleep(cycleEvery + time.Second)
		copies := client.asked("/slack22grokbot/message")
		mustEqual(t, len(copies), 1)
		mustEqual(t, copies[0].body, `{"channel":"C0TASKS001","threadTs":"1795280000.123456","bot":"Task slack:C0TASKS001/1795280000.123456","eventId":"$progress","text":"Opened the dashboard."}`)
		status := running.Status()
		mustEqual(t, status["running"], any(true))
		mustEqual(t, status["active"], any(1))
		mustEqual(t, len(status["errors"].(map[string]string)), 0)
		if _, problem := status["problem"]; problem {
			t.Errorf("problem = %v", status["problem"])
		}

		// Once the task bot has gone quiet, a message for its thread goes to the task bot itself.
		time.Sleep(2 * time.Minute)
		followUp := mustCall(t, running, "grok_bot_send", task(map[string]any{"bot": "Task Bot", "text": "also the CSV", "wait_seconds": 0.0}))
		mustEqual(t, followUp["redirected_from"], any("Task Bot"))
		sends = h.sends()
		mustEqual(t, sends[len(sends)-1]["room_id"], any(taskRoom))
		mustEqual(t, sends[len(sends)-1]["text"], any("also the CSV\n\n"+handoff.GrokFollowUpBlock(taskThread)))

		// A wait that is still open ends with the service. Stop returns once every loop has ended:
		// this test would not return otherwise.
		waiting := make(chan map[string]any, 1)
		go func() {
			waiting <- mustCall(t, running, "grok_bot_send", task(map[string]any{"bot": "Grok Bot", "text": "one for the parent", "wait_seconds": 150.0}))
		}()
		time.Sleep(time.Second)
		stopped := time.Now()
		running.Stop()
		mustEqual(t, (<-waiting)["ok"], any(true))
		if took := time.Since(stopped); took > time.Second {
			t.Errorf("the open wait took %v to end after Stop", took)
		}
	})
}

func TestWhileTheBoxIsDownTheServicePutsTheSetupBeforeATaskAndRepairsOnRequest(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newFakeHost(t)
		h.writeSettings(t, fullSettings)
		hermesHome := t.TempDir()
		if err := os.WriteFile(filepath.Join(hermesHome, ".env"), []byte("GROK_BOX_BROWSER_TOKEN=tok\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		pluginBox := filepath.Join(hermesHome, "plugins/leon/grok_box_browser/box")
		box := boxDeps{
			exec: func(_ context.Context, file string, _ []string) (string, error) {
				if file == "git" {
					return boxCommit + "\n", nil
				}
				return `{"Peer":{"k":{"HostName":"grok-box","Online":true}}}`, nil
			},
			// The broker is down.
			nc: func(context.Context, *boxSettings, string, time.Duration) string { return "" },
			readFile: func(path string) ([]byte, error) {
				if filepath.Dir(path) == pluginBox {
					return []byte(filepath.Base(path)), nil
				}
				return os.ReadFile(path)
			},
		}
		running := start(t, testService(hermesHome, bridgeHTTP(func() []rosterBot { return nil }), box), h)
		defer running.Stop()

		mustCall(t, running, "grok_bot_send", task(map[string]any{"bot": "Task Bot", "text": "export the report", "wait_seconds": 0.0}))
		setup := setupCommand(release{commit: boxCommit, up: sha("up.sh"), broker: sha("broker.mjs")}, "tok", "")
		mustEqual(t, h.sends()[0]["text"], any(upkeepBlock(setup)+"\n\nexport the report\n\n"+taskBlock))

		// The plugin asks for a repair in Hermes's shared folder; within a minute the parent bot gets
		// the setup as a message of its own, and the plugin can read how it went.
		shared := filepath.Join(hermesHome, "grok-box-browser")
		if err := os.MkdirAll(shared, 0o755); err != nil {
			t.Fatal(err)
		}
		request, _ := json.Marshal(map[string]any{"at": time.Now().UnixMilli()})
		if err := os.WriteFile(filepath.Join(shared, "repair-request.json"), request, 0o644); err != nil {
			t.Fatal(err)
		}
		time.Sleep(boxEvery + time.Second)
		sends := h.sends()
		mustEqual(t, len(sends), 2)
		mustEqual(t, sends[1]["room_id"], any("!parent:beeper.local"))
		mustEqual(t, sends[1]["text"], any(repairMessage(setup)))
		mustMatch(t, sends[1]["idempotency_key"].(string), `^direct-`)
		var status map[string]any
		data, err := os.ReadFile(filepath.Join(shared, "repair-status.json"))
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(data, &status); err != nil {
			t.Fatal(err)
		}
		mustEqual(t, status["result"], any("sent"))
		mustEqual(t, running.Status()["grokBox"].(map[string]any)["result"], any("sent"))
		if h.logged("grok_box_repair_sent") == nil || h.logged("grok_box_upkeep") == nil {
			t.Error("the upkeep and the repair were not logged")
		}
	})
}

func TestALogLineNeverCarriesMessageText(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newFakeHost(t)
		h.writeSettings(t, fullSettings)
		running := start(t, testService(t.TempDir(), bridgeHTTP(func() []rosterBot { return nil }), boxDeps{}), h)
		defer running.Stop()
		secret := "the launch code is swordfish"
		time.AfterFunc(time.Second, func() { h.journal.add("!task:beeper.local", "$reply", "noted: "+secret, false) })
		mustCall(t, running, "grok_bot_send", task(map[string]any{"bot": "Task Bot", "text": secret}))
		mustCall(t, running, "grok_bot_send", task(map[string]any{"bot": "Task Bot", "text": secret + " again"}))
		h.mu.Lock()
		defer h.mu.Unlock()
		var events []string
		for _, entry := range h.logs {
			events = append(events, entry.message)
			if line := asJSON(t, entry); strings.Contains(line, "swordfish") {
				t.Errorf("%s carries message text: %s", entry.message, line)
			}
			mustEqual(t, entry.level, "info", entry.message)
		}
		if want := []string{"grok_send", "grok_reply", "grok_queued"}; !reflect.DeepEqual(events, want) {
			t.Errorf("logged %v, want %v", events, want)
		}
		want := map[string]any{"bot": "Task Bot", "chars": 28}
		if !reflect.DeepEqual(h.logs[0].fields, want) {
			t.Errorf("grok_send fields = %v, want %v", h.logs[0].fields, want)
		}
	})
}

func TestAQueuedMessageGoesOutByItselfOnceTheBotIsQuiet(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newFakeHost(t)
		h.writeSettings(t, fullSettings)
		running := start(t, testService(t.TempDir(), bridgeHTTP(func() []rosterBot { return nil }), boxDeps{}), h)
		defer running.Stop()
		h.journal.add("!task:beeper.local", "$busy", "Here is the first half of the answer, more is coming.", false)
		for _, text := range []string{"also the CSV", "and the totals"} {
			queued := mustCall(t, running, "grok_bot_send", task(map[string]any{"bot": "Task Bot", "text": text}))
			mustEqual(t, queued["queued"], any(true))
		}
		mustEqual(t, len(h.sends()), 0)
		// The flusher looks every ten seconds; the bot counts as quiet a minute after its last message.
		time.Sleep(55 * time.Second)
		mustEqual(t, len(h.sends()), 0)
		time.Sleep(20 * time.Second)
		sends := h.sends()
		mustEqual(t, len(sends), 1)
		mustEqual(t, sends[0]["text"], any("a few more things, in order:\n\n1. also the CSV\n\n2. and the totals\n\n"+taskBlock))
		mustMatch(t, sends[0]["idempotency_key"].(string), `^flush-[0-9a-f]{40}$`)
		flushed := h.logged("grok_flush")
		if flushed == nil {
			t.Fatal("the flush was not logged")
		}
		mustEqual(t, flushed.fields["count"], any(2))
		mustEqual(t, flushed.fields["left"], any(0))
	})
}

func TestStartFailsOnlyWhenTheRelayCannotRunAtAll(t *testing.T) {
	// A state file that can't be read keeps the bridge off, and says so, but the relay still starts.
	h := newFakeHost(t)
	h.writeSettings(t, fullSettings)
	if err := os.WriteFile(filepath.Join(h.home, "slack22grokbot.json"), []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	running := start(t, testService(t.TempDir(), &scriptedHTTP{}, boxDeps{}), h)
	defer running.Stop()
	status := running.Status()
	mustEqual(t, status["running"], any(false))
	if problem, _ := status["problem"].(string); problem == "" || problem == "no settings file" {
		t.Errorf("problem = %q", problem)
	}
	if h.logged("slack22grokbot_config_error") == nil {
		t.Error("the unreadable state file was not logged")
	}
	if _, err := running.CallTool(context.Background(), "grok_bots", nil); err != nil {
		t.Error(errors.Join(errors.New("grok_bots failed"), err))
	}
}
