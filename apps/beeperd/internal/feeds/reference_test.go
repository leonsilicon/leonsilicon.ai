package feeds

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/host"
)

// testdata/typescript.json holds answers of the TypeScript feeds, recorded from their own code:
// what Node read from settings files, the Slack copy of messages, the fixed rules and the request
// for chats, and the verdict for Decisions answers. The Go port has to give the same ones.

type reference struct {
	Env []struct {
		Input  string
		Output map[string]string
	}
	Mirror []struct {
		Message host.JournalEntry
		Room    host.RoomInfo
		Sender  string
		Verdict verdict
		Output  string
	}
	Screen []struct {
		Input struct {
			Chat     struct{ Title, Network, Type string }
			Messages []struct {
				From  string
				Owner bool
				Text  string
				Type  string
			}
		}
		Prompt struct {
			Context string
			Wake    string
			MaxText int
		}
		Rule *verdict
		// Request is the whole request; most cases keep only Data, the chat as the model gets it,
		// and the number of questions.
		Request   string
		Data      string
		Questions int
	}
	// Rules is one text each, and whether a fixed rule caught it. Where says which part of a chat
	// held the text: a contact's message ("text") or name ("from"), the chat's title, or a message
	// of the owner's.
	Rules []struct {
		Where string
		Text  string
		Hit   bool
	}
	Verdicts []struct {
		Decision   map[string]any
		Thresholds struct{ Unsafe, Wake float64 }
		Result     *verdict
		Error      *string
	}
	Exchange struct {
		Message          host.JournalEntry
		DecisionsRequest string
		SlackText        string
		SlackForms       struct{ List, Create, Purpose, Invite, Post string }
	}
}

func readReference(t *testing.T) reference {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "typescript.json"))
	if err != nil {
		t.Fatal(err)
	}
	var recorded reference
	if err := json.Unmarshal(data, &recorded); err != nil {
		t.Fatal(err)
	}
	return recorded
}

// sameJSON compares JSON written by Go with JSON written by JavaScript. They are the same bytes,
// except that Go escapes the two Unicode line separators, and that half a character pair left by a
// cut is \ud83d in JavaScript and U+FFFD here.
func sameJSON(t *testing.T, got []byte, want string) bool {
	t.Helper()
	if string(got) == want {
		return true
	}
	if !strings.ContainsAny(want, "\u2028\u2029") && !strings.Contains(want, `\ud8`) {
		return false
	}
	var gotValue, wantValue any
	if err := json.Unmarshal(got, &gotValue); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(want), &wantValue); err != nil {
		t.Fatal(err)
	}
	return reflect.DeepEqual(gotValue, wantValue)
}

func TestReadsSettingsFilesAsNodeDid(t *testing.T) {
	for _, c := range readReference(t).Env {
		if got := parseEnv(c.Input); !reflect.DeepEqual(got, c.Output) {
			t.Errorf("parseEnv(%q)\n got %q\nwant %q", c.Input, got, c.Output)
		}
	}
}

func TestWritesTheSlackCopyAsTheTypeScriptFeedDid(t *testing.T) {
	for _, c := range readReference(t).Mirror {
		if got := mirrorText(c.Message, c.Room, c.Sender, c.Verdict); got != c.Output {
			t.Errorf("mirrorText of %.80q from %.40q in %+v\n got %q\nwant %q", c.Message.Text, c.Sender, c.Room, got, c.Output)
		}
	}
}

func TestScreensChatsAsTheTypeScriptScreenerDid(t *testing.T) {
	for _, c := range readReference(t).Screen {
		input := screenInput{chat: screenChat{title: c.Input.Chat.Title, network: c.Input.Chat.Network, kind: c.Input.Chat.Type}}
		for _, message := range c.Input.Messages {
			input.messages = append(input.messages, screenMessage{from: message.From, owner: message.Owner, text: message.Text, kind: message.Type})
		}
		ruled, matched := ruleVerdict(input)
		if matched != (c.Rule != nil) || matched && !reflect.DeepEqual(ruled, *c.Rule) {
			t.Errorf("ruleVerdict(%+v) = %+v, %v; want %+v", input, ruled, matched, c.Rule)
		}
		request := screenRequest(input, screenModel, screenPrompt{context: c.Prompt.Context, wake: c.Prompt.Wake, maxText: c.Prompt.MaxText})
		if c.Request != "" {
			if got, err := jsJSON(request); err != nil || !sameJSON(t, got, c.Request) {
				t.Errorf("the request for %+v (%v)\n got %s\nwant %s", input, err, got, c.Request)
			}
			continue
		}
		data := request.Input[1].Content.([]jsonPart)[0].Data
		if got, err := jsJSON(data); err != nil || !sameJSON(t, got, c.Data) {
			t.Errorf("the chat data for %+v (%v)\n got %s\nwant %s", input, err, got, c.Data)
		}
		equal(t, len(request.Questions), c.Questions)
	}
}

func TestTheFixedRulesCatchWhatTheTypeScriptRulesCaught(t *testing.T) {
	hits := 0
	for _, c := range readReference(t).Rules {
		input := screenInput{chat: screenChat{title: "Family", network: "whatsapp", kind: "direct"}, messages: []screenMessage{{from: "Alice", text: "hi", kind: "m.text"}}}
		switch c.Where {
		case "text":
			input.messages[0].text = c.Text
		case "from":
			input.messages[0].from = c.Text
		case "title":
			input.chat.title = c.Text
		case "owner":
			input.messages[0].text, input.messages[0].owner = c.Text, true
		default:
			t.Fatalf("unknown place %q", c.Where)
		}
		if _, matched := ruleVerdict(input); matched != c.Hit {
			t.Errorf("a rule catching %q as %s: %v, want %v", c.Text, c.Where, matched, c.Hit)
		}
		if c.Hit {
			hits++
		}
	}
	if hits < 60 {
		t.Errorf("only %d recorded texts are caught by a rule", hits)
	}
}

func TestJudgesAnswersAsTheTypeScriptScreenerDid(t *testing.T) {
	for _, c := range readReference(t).Verdicts {
		got, err := verdictFrom(c.Decision, thresholds{unsafe: c.Thresholds.Unsafe, wake: c.Thresholds.Wake})
		switch {
		case c.Error != nil:
			if err == nil || err.Error() != *c.Error {
				t.Errorf("verdictFrom(%v) failed with %v, want %q", c.Decision, err, *c.Error)
			}
		case err != nil || !reflect.DeepEqual(got, *c.Result):
			gotJSON, _ := json.Marshal(got)
			wantJSON, _ := json.Marshal(c.Result)
			t.Errorf("verdictFrom(%v) = %s (%v), want %s", c.Decision, gotJSON, err, wantJSON)
		}
	}
}
