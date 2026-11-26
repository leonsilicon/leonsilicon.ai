package grokrelay

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/envfile"
)

// What the relay sends to Grok and tells Hermes must stay what the TypeScript relay wrote, byte for
// byte. testdata/text.json holds the output of policy.ts, grok-box.ts and inbox-backend.ts at commit
// 296f66e for the inputs it lists, and testdata/parse-env.json what Node's util.parseEnv (v26) makes
// of some settings files: the relay's own, and Hermes's .env.

func readTestdata(t *testing.T, name string, into any) {
	t.Helper()
	data, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, into); err != nil {
		t.Fatal(err)
	}
}

func TestTheRelaysTextIsByteIdenticalToTheTypeScriptRelays(t *testing.T) {
	var golden struct {
		Compose []struct {
			Items []queuedItem `json:"items"`
			Text  string       `json:"text"`
		} `json:"compose"`
		Box struct {
			Release      struct{ Commit, Up, Broker string } `json:"release"`
			Setup        string                              `json:"setup"`
			SetupWithKey string                              `json:"setupWithKey"`
			Upkeep       string                              `json:"upkeep"`
			Repair       string                              `json:"repair"`
		} `json:"box"`
		Budget struct {
			Status  struct{ Used, Limit, Remaining, UrgentOver, ResetsInMinutes int } `json:"status"`
			Message string                                                            `json:"message"`
		} `json:"budget"`
		Guard  string `json:"guard"`
		Extend string `json:"extend"`
		Busy   []struct {
			Messages []message `json:"messages"`
			Now      int64     `json:"now"`
			Windowed bool      `json:"windowed"`
			Result   struct {
				Busy   bool   `json:"busy"`
				Reason string `json:"reason"`
			} `json:"result"`
		} `json:"busy"`
		Acks []struct {
			Text string `json:"text"`
			Ack  bool   `json:"ack"`
		} `json:"acks"`
		Plain []struct {
			HTML string `json:"html"`
			Text string `json:"text"`
		} `json:"plain"`
		SortKeys []struct {
			TS  int64  `json:"ts"`
			ID  string `json:"id"`
			Key string `json:"key"`
		} `json:"sortKeys"`
		ISO []struct {
			MS      int64  `json:"ms"`
			ISO     string `json:"iso"`
			SlackTS string `json:"slackTs"`
		} `json:"iso"`
	}
	readTestdata(t, "text.json", &golden)

	if len(golden.Compose) != 9 || len(golden.Busy) != 14 || len(golden.Acks) != 12 || len(golden.Plain) != 4 {
		t.Fatal("testdata/text.json is not the file this test was written for")
	}
	for _, c := range golden.Compose {
		mustEqual(t, compose(c.Items), c.Text, "compose")
	}

	pinned := release{commit: golden.Box.Release.Commit, up: golden.Box.Release.Up, broker: golden.Box.Release.Broker}
	mustEqual(t, setupCommand(pinned, "tok-123", ""), golden.Box.Setup, "setup")
	mustEqual(t, setupCommand(pinned, "tok-123", "tskey-auth-abc"), golden.Box.SetupWithKey, "setup with a join key")
	mustEqual(t, upkeepBlock(golden.Box.Setup), golden.Box.Upkeep, "upkeep block")
	mustEqual(t, repairMessage(golden.Box.SetupWithKey), golden.Box.Repair, "repair message")

	var state budgetState
	for i := range int64(hourlyBudget) {
		state = recordSend(state, t0+i*1000, false)
	}
	status := budgetStatus(state, t0+30_000)
	want := golden.Budget.Status
	mustEqual(t, status, budgetReport{want.Used, want.Limit, want.Remaining, want.UrgentOver, want.ResetsInMinutes}, "budget status")
	mustEqual(t, budgetExceededMessage(status, "Task Bot", "  do x "+strings.Repeat("y", 400)+" 🙂 "), golden.Budget.Message, "budget message")
	_, err := guardBot("Linear Bot", "because")
	mustEqual(t, err.Error(), golden.Guard, "guard")
	_, _, err = extendBudget(state, "ok", t0)
	mustEqual(t, err.Error(), golden.Extend, "extension")

	for index, c := range golden.Busy {
		got := busy(c.Messages, c.Now, c.Windowed)
		if got.busy != c.Result.Busy || got.reason != c.Result.Reason {
			t.Errorf("busy case %d: got %v %q, want %v %q", index, got.busy, got.reason, c.Result.Busy, c.Result.Reason)
		}
	}
	for _, c := range golden.Acks {
		mustEqual(t, isAck(c.Text), c.Ack, "isAck", c.Text)
	}
	for _, c := range golden.Plain {
		mustEqual(t, plain(c.HTML), c.Text, "plain", c.HTML)
	}
	for _, c := range golden.SortKeys {
		mustEqual(t, sortKeyOf(c.TS, c.ID), c.Key, "sort key")
	}
	for _, c := range golden.ISO {
		mustEqual(t, isoTime(c.MS), c.ISO, "ISO time")
		mustEqual(t, slackTS(c.MS), c.SlackTS, "Slack ts")
		mustEqual(t, parseTime(c.ISO), float64(c.MS), "parsed time")
	}
}

func TestSettingsFilesAreReadTheWayNodeReadThem(t *testing.T) {
	var cases []struct {
		Input  string            `json:"input"`
		Output map[string]string `json:"output"`
	}
	readTestdata(t, "parse-env.json", &cases)
	if len(cases) != 37 {
		t.Fatalf("%d cases, want 37", len(cases))
	}
	for _, c := range cases {
		if got := envfile.Parse(c.Input); !reflect.DeepEqual(got, c.Output) {
			t.Errorf("envfile.Parse(%q) = %q, want %q", c.Input, got, c.Output)
		}
	}
}

func TestLengthsAndCutsCountAsJavaScriptDoes(t *testing.T) {
	mustEqual(t, utf16Len("aé🙂"), 4)
	mustEqual(t, utf16Prefix("aé🙂b", 2), "aé")
	// A cut inside an emoji leaves the emoji out.
	mustEqual(t, utf16Prefix("aé🙂b", 3), "aé")
	mustEqual(t, utf16Prefix("aé🙂b", 4), "aé🙂")
	mustEqual(t, utf16Prefix("ab", 9), "ab")
	mustEqual(t, strings.Join(chunks("a🙂bcd", 2), "|"), "a🙂|bc|d")
	mustEqual(t, formatNumber(jsNumber("0.2")), "0.2")
	mustEqual(t, formatNumber(jsNumber(" 9400 ")), "9400")
	mustEqual(t, formatNumber(jsNumber("soon")), "NaN")
	mustEqual(t, jsNumber(nil), 0)
	mustEqual(t, jsNumber(true), 1)
	mustEqual(t, jsRound(-0.5), 0)
	mustEqual(t, jsRound(2.5), 3)
	mustMatch(t, newUUID(), `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
}
