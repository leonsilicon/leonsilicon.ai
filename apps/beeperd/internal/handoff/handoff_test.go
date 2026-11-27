package handoff

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"
)

var (
	t1 = SlackThread{Channel: "C0TASKS001", ThreadTS: "1795280000.123456"}
	t2 = SlackThread{Channel: "#leon-42-fix-the-thing", ThreadTS: "1795280001.000001"}
)

func mustMatch(t *testing.T, text, pattern string) {
	t.Helper()
	if !regexp.MustCompile(pattern).MatchString(text) {
		t.Errorf("%q does not match %s", text, pattern)
	}
}

func TestTheThreadIsCheckedAndBecomesTheIdentifierAndTheTaskBotsName(t *testing.T) {
	for _, valid := range []struct {
		channel, ts any
		want        SlackThread
	}{
		{" C0TASKS001 ", "1795280000.123456", t1},
		{"#leon-42-fix-the-thing", "1795280001.000001", t2},
	} {
		got, err := ParseThread(valid.channel, valid.ts)
		if err != nil || got != valid.want {
			t.Errorf("ParseThread(%v, %v) = %v, %v; want %v", valid.channel, valid.ts, got, err, valid.want)
		}
	}
	if got := Identifier(t1); got != "slack:C0TASKS001/1795280000.123456" {
		t.Errorf("Identifier = %q", got)
	}
	if got := TaskName(t1); got != "Task slack:C0TASKS001/1795280000.123456" {
		t.Errorf("TaskName = %q", got)
	}
	for _, refused := range []struct {
		channel, ts any
		pattern     string
	}{
		{nil, nil, `are required`},
		{"C0TASKS001", "", `are required`},
		{"D0LEONDM01", "1795280000.123456", `not a DM`},
		{"@Leon", "1795280000.123456", `not a DM`},
		{"general", "1795280000.123456", `channel ID`},
		{"C0TASKS001", "yesterday", `Slack ts`},
		{42.0, "1795280000.123456", `are required`},
	} {
		_, err := ParseThread(refused.channel, refused.ts)
		if err == nil {
			t.Errorf("ParseThread(%v, %v) was accepted", refused.channel, refused.ts)
			continue
		}
		mustMatch(t, err.Error(), refused.pattern)
	}
}

func TestTheBlockTellsTheBotToSpawnTheTaskBotAndHowItTalksToLeon(t *testing.T) {
	block := GrokBlock(t1, nil)
	mustMatch(t, block, `^---\nSlack thread for this task: slack:C0TASKS001/1795280000\.123456`)
	mustMatch(t, block, `named exactly "Task slack:C0TASKS001/1795280000\.123456"`)
	mustMatch(t, block, `Beeper copies each reply to Slack thread slack:C0TASKS001/1795280000\.123456`)
	mustMatch(t, block, `mine as my own messages, anyone else's starting with their name`)
	mustMatch(t, block, `I retire the task bot`)
	// Hermes writes to the bot as Leon (his rule, 2026-11-27): the block doesn't name it.
	if strings.Contains(block, "Hermes") || strings.Contains(GrokFollowUpBlock(t1), "Hermes") {
		t.Error("a Grok block names Hermes")
	}
}

func TestATaskBotsNameDecodesToItsThread(t *testing.T) {
	if got, ok := ParseTaskName(TaskName(t1)); !ok || got != t1 {
		t.Errorf("ParseTaskName(%q) = %v, %v", TaskName(t1), got, ok)
	}
	for _, name := range []string{
		"Task Bot",
		"Task slack:unknown/1795280099.000001",
		// A task bot's name always holds the channel ID: a #name is not a route.
		TaskName(t2),
		"Task slack:C0TASKS001/yesterday",
		"Task slack:C0TASKS001/1795280000.123456/more",
	} {
		if got, ok := ParseTaskName(name); ok {
			t.Errorf("ParseTaskName(%q) = %v, want none", name, got)
		}
	}
}

func TestDotNetworks(t *testing.T) {
	if !IsDotNetwork("chatgpt") || IsDotNetwork("grok") || IsDotNetwork("") {
		t.Error("only chatgpt chats are Silicon Dot's")
	}
}

func TestTrimSpaceTrimsWhatJavaScriptTrims(t *testing.T) {
	if got := TrimSpace("\ufeff\u00a0 \t\r\n do it \u2028\u3000"); got != "do it" {
		t.Errorf("TrimSpace = %q", got)
	}
	// U+0085 is white space to Go's unicode package but not to JavaScript.
	if got := TrimSpace("\u0085x\u0085"); got != "\u0085x\u0085" {
		t.Errorf("TrimSpace = %q", got)
	}
}

// The blocks go to Grok Bot and ChatGPT in Leon's name, so they must stay byte for byte what the
// TypeScript daemon sent. testdata/blocks.json holds them as slack22grokbot/handoff.ts and
// slack22chatgpt/handoff.ts wrote them at commit 296f66e.
func TestTheBlocksAreByteIdenticalToTheTypeScriptOnes(t *testing.T) {
	data, err := os.ReadFile("testdata/blocks.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Block  string      `json:"block"`
		Thread SlackThread `json:"thread"`
		Items  []int       `json:"items"`
		Text   string      `json:"text"`
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) != 10 {
		t.Fatalf("%d cases, want 10", len(cases))
	}
	for _, c := range cases {
		var got string
		switch c.Block {
		case "codex":
			got = CodexBlock(c.Thread)
		case "grok":
			got = GrokBlock(c.Thread, c.Items)
		case "follow-up":
			got = GrokFollowUpBlock(c.Thread)
		default:
			t.Fatalf("unknown block %q", c.Block)
		}
		if got != c.Text {
			t.Errorf("%s block for %v, items %v:\n got %q\nwant %q", c.Block, c.Thread, c.Items, got, c.Text)
		}
	}
}
