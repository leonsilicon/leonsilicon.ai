package feeds

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/host"
)

// testdata/scenarios.json holds scenarios that were run through the TypeScript feed, with what it
// did at every pass: messages arriving, edited and deleted, Slack, the screener and the room
// directory failing and recovering, time passing up to the seven-day expiry, and restarts. The Go
// feed has to do the same at every pass, down to its state file.

type scenarioStep struct {
	Op          string
	ID          string
	Room        string
	Sender      string
	IsMe        bool
	Type        string
	Text        string
	TSOffset    int64
	Attachments int
	ReplyTo     *string
	HTML        *string
	Target      string
	MS          int64
	Channel     string
	Failing     bool
	Known       bool
	RoomIDs     []string
	Result      *scenarioResult
}

type scenarioResult struct {
	Next         *int64
	Failed       bool
	Status       map[string]any
	Posts        []map[string]any
	Destinations []map[string]any
	Screened     []string
	Logs         []map[string]any
	Refreshes    int
	// State is the state file after the pass. The biggest ones were left out of the recording.
	State        *string
	StateOmitted bool
}

// scenarioWorld is the daemon, Slack and the screener of a scenario.
type scenarioWorld struct {
	home    string
	clock   *fakeClock
	journal *fakeJournal
	known   map[string]bool

	slackFailures  map[string]bool
	screenerFails  bool
	directoryFails bool
	namesFail      bool
	refreshFails   bool

	posts        []map[string]any
	destinations []map[string]any
	screened     []string
	logs         []map[string]any
	refreshes    int
}

var scenarioRooms = []string{"whatsapp", "family", "instagram", "telegram", "late"}

func scenarioRoom(id string) host.RoomInfo {
	room := host.RoomInfo{RoomID: "!" + id + ":example.test", Network: "whatsapp", IsDirect: id != "family"}
	if id == "instagram" || id == "telegram" {
		room.Network = id
	}
	if id != "family" {
		name := id + " contact"
		room.Name = &name
	}
	return room
}

func (w *scenarioWorld) Journal() host.Journal { return w.journal }
func (w *scenarioWorld) Home() string          { return w.home }

func (w *scenarioWorld) Log() host.Logger {
	return func(level, message string, fields map[string]any) {
		line := map[string]any{"level": level, "message": message, "fields": nil}
		if fields != nil {
			line["fields"] = fields
		}
		w.logs = append(w.logs, line)
	}
}

func (w *scenarioWorld) Rooms(_ context.Context, roomIDs []string) ([]host.RoomInfo, error) {
	if w.directoryFails {
		return nil, errors.New("directory down")
	}
	var rooms []host.RoomInfo
	for _, id := range scenarioRooms {
		if room := scenarioRoom(id); w.known[id] && slices.Contains(roomIDs, room.RoomID) {
			rooms = append(rooms, room)
		}
	}
	return rooms, nil
}

func (w *scenarioWorld) SenderNames(context.Context, []string) (map[string]string, error) {
	if w.namesFail {
		return nil, errors.New("names down")
	}
	return map[string]string{"@alice:example.test": "Alice", "@bob:example.test": "Bob"}, nil
}

func (w *scenarioWorld) Tool(context.Context, string, map[string]any) (map[string]any, error) {
	w.refreshes++
	if w.refreshFails {
		return nil, errors.New("refresh down")
	}
	for _, id := range scenarioRooms {
		w.known[id] = true
	}
	return map[string]any{}, nil
}

func (w *scenarioWorld) Connections(context.Context) ([]host.Connection, error) {
	return nil, errUnused
}
func (w *scenarioWorld) PublishLinearIssue(context.Context, string, map[string]any) error {
	return errUnused
}
func (w *scenarioWorld) PublishProjectAppearance(context.Context, string, map[string]any) error {
	return errUnused
}
func (w *scenarioWorld) PublishProjectVisibility(context.Context, map[string]any) error {
	return errUnused
}

func (w *scenarioWorld) ensureChannel(_ context.Context, channel string, options channelOptions) (string, error) {
	invite := []any{}
	for _, user := range options.invite {
		invite = append(invite, user)
	}
	w.destinations = append(w.destinations, map[string]any{"channel": channel, "create": options.create, "purpose": options.purpose, "invite": invite})
	return "id-" + channel, nil
}

func (w *scenarioWorld) post(_ context.Context, channel, text string) error {
	if w.slackFailures[channel] {
		return errors.New("temporary Slack failure")
	}
	w.posts = append(w.posts, map[string]any{"channel": channel, "text": text})
	return nil
}

func (w *scenarioWorld) screen(_ context.Context, input screenInput) (verdict, error) {
	type message struct {
		From  string `json:"from"`
		Owner bool   `json:"owner"`
		Text  string `json:"text"`
		Type  string `json:"type"`
	}
	asked := struct {
		Chat struct {
			Title   string `json:"title"`
			Network string `json:"network"`
			Type    string `json:"type"`
		} `json:"chat"`
		Messages []message `json:"messages"`
	}{}
	asked.Chat.Title, asked.Chat.Network, asked.Chat.Type = input.chat.title, input.chat.network, input.chat.kind
	for _, m := range input.messages {
		asked.Messages = append(asked.Messages, message{m.from, m.owner, m.text, m.kind})
	}
	encoded, err := json.Marshal(asked)
	if err != nil {
		return verdict{}, err
	}
	w.screened = append(w.screened, string(encoded))
	if w.screenerFails {
		return verdict{}, errors.New("screener down")
	}
	switch leading, _, _ := strings.Cut(input.messages[0].text, ":"); leading {
	case "spam":
		return verdict{Route: routeSpam, Reason: "promotion", By: "model", PUnsafe: number(0.05)}, nil
	case "unsafe":
		return verdict{Route: routeUnsafe, Reason: "scam_or_fraud", By: "model", PUnsafe: number(0.35)}, nil
	case "rule":
		return verdict{Route: routeUnsafe, Reason: "prompt_injection", By: "rules"}, nil
	}
	return verdict{Route: routeSafe, Reason: "ok", By: "model", PUnsafe: number(0.125)}, nil
}

func (w *scenarioWorld) feed(t *testing.T, roomIDs []string) *feed {
	t.Helper()
	options := feedOptions{
		network:        "whatsapp",
		host:           w,
		slack:          w,
		screener:       w,
		flaggedChannel: "feed-flagged",
		spamChannel:    "C0SPAM0001",
		invite:         []string{"U1", "U2"},
		stateFile:      filepath.Join(w.home, "state.json"),
		now:            w.clock.now,
		after:          w.clock.after,
	}
	if roomIDs != nil {
		options.roomIDs = map[string]bool{}
		for _, id := range roomIDs {
			options.roomIDs[id] = true
		}
	}
	feed, err := newFeed(options)
	if err != nil {
		t.Fatal(err)
	}
	return feed
}

// plain turns a value into what its JSON says, so that two values written differently compare as
// what they mean.
func plain(t *testing.T, value any) any {
	t.Helper()
	encoded, ok := value.(string)
	if !ok {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		encoded = string(data)
	}
	var decoded any
	if err := json.Unmarshal([]byte(encoded), &decoded); err != nil {
		t.Fatalf("%v in %s", err, encoded)
	}
	return decoded
}

func pendingOrder(t *testing.T, stateJSON string) []string {
	t.Helper()
	var saved struct{ Pending queue }
	if err := json.Unmarshal([]byte(stateJSON), &saved); err != nil {
		t.Fatal(err)
	}
	return saved.Pending.order
}

func TestDoesWhatTheTypeScriptFeedDidInRecordedScenarios(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "scenarios.json"))
	if err != nil {
		t.Fatal(err)
	}
	var scenarios [][]scenarioStep
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&scenarios); err != nil {
		t.Fatal(err)
	}
	passes := 0
	for number, steps := range scenarios {
		world := &scenarioWorld{
			home:          t.TempDir(),
			clock:         &fakeClock{time: testNow},
			journal:       &fakeJournal{},
			known:         map[string]bool{"whatsapp": true, "family": true, "instagram": true, "telegram": true},
			slackFailures: map[string]bool{},
		}
		feed := world.feed(t, nil)
		for index, step := range steps {
			now := world.clock.now()
			switch step.Op {
			case "record":
				world.journal.record(journalMessage{
					eventID: "$" + step.ID, roomID: "!" + step.Room + ":example.test", sender: step.Sender, isMe: step.IsMe,
					kind: step.Type, text: step.Text, ts: now + step.TSOffset, attachments: step.Attachments, replyTo: step.ReplyTo, html: step.HTML,
				}, now)
			case "edit":
				world.journal.record(journalMessage{
					eventID: "$" + step.ID, roomID: "!" + step.Room + ":example.test", sender: step.Sender,
					kind: "m.text", text: step.Text, ts: now, replaces: "$" + step.Target,
				}, now)
			case "redact":
				world.journal.redact("$" + step.Target)
			case "advance":
				world.clock.advance(step.MS)
			case "slack":
				world.slackFailures[step.Channel] = step.Failing
			case "screener":
				world.screenerFails = step.Failing
			case "directory":
				world.directoryFails = step.Failing
			case "names":
				world.namesFail = step.Failing
			case "refresh":
				world.refreshFails = step.Failing
			case "room":
				world.known[step.Room] = step.Known
			case "restart":
				feed = world.feed(t, step.RoomIDs)
			case "tick":
				passes++
				want := step.Result
				nextAt, due, err := feed.tick(context.Background(), never)
				check := func(what string, got, wanted any) {
					t.Helper()
					if got, wanted := plain(t, got), plain(t, wanted); !reflect.DeepEqual(got, wanted) {
						t.Fatalf("scenario %d, step %d: %s\n got %v\nwant %v", number, index, what, got, wanted)
					}
				}
				var next *int64
				if due {
					next = &nextAt
				}
				check("the pass failed", err != nil, want.Failed)
				if err == nil {
					check("the next pass", next, want.Next)
				}
				check("status", feed.status(), want.Status)
				check("posts", append([]map[string]any{}, world.posts...), want.Posts)
				check("channels looked up", append([]map[string]any{}, world.destinations...), want.Destinations)
				check("messages screened", len(world.screened), len(want.Screened))
				for i := range world.screened {
					check("a screened message", world.screened[i], want.Screened[i])
				}
				check("the log", append([]map[string]any{}, world.logs...), want.Logs)
				check("directory refreshes", world.refreshes, want.Refreshes)
				saved, err := os.ReadFile(filepath.Join(world.home, "state.json"))
				switch {
				case want.StateOmitted:
				case want.State == nil:
					check("a state file exists", err == nil, false)
				case err != nil:
					t.Fatalf("scenario %d, step %d: %v", number, index, err)
				default:
					check("the state file", string(saved), *want.State)
					check("the order of the pending messages", pendingOrder(t, string(saved)), pendingOrder(t, *want.State))
				}
				world.posts, world.destinations, world.screened, world.logs = nil, nil, nil, nil
			default:
				t.Fatalf("unknown step %q", step.Op)
			}
		}
	}
	t.Logf("%d scenarios, %d passes", len(scenarios), passes)
}
