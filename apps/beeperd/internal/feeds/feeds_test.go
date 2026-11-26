package feeds

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/host"
)

func TestTheSevenFeedsAndTheirNetworks(t *testing.T) {
	var feeds [][2]string
	for _, each := range Services() {
		feeds = append(feeds, [2]string{each.Name(), each.(*service).network})
	}
	equal(t, feeds, [][2]string{
		{"discord2slack", "discord"},
		{"instagram2slack", "instagram"},
		{"linkedin2slack", "linkedin"},
		{"reddit2slack", "reddit"},
		{"wechat2slack", "wechat"},
		{"whatsapp2slack", "whatsapp"},
		{"x2slack", "x"},
	})
}

func TestAFeedWithoutASettingsFileIsOff(t *testing.T) {
	h := setup(t)
	running, err := newService("whatsapp2slack", "whatsapp").Start(context.Background(), h)
	if err != nil {
		t.Fatal(err)
	}
	equal(t, running.Status(), map[string]any{"running": false, "reason": "no settings file"})
	running.Stop()
	h.record("ignored", "nobody reads this")
	equal(t, h.journal.readCount(), 0)
	if _, err := os.Stat(filepath.Join(h.home, "state.json")); !os.IsNotExist(err) {
		t.Errorf("a feed that is off wrote a state file (%v)", err)
	}
}

const validSettings = "SLACK_BOT_TOKEN='xoxb-test'\nOPENAI_API_KEY='sk-test'\nFEED_FLAGGED_CHANNEL='C0FLAGGED01'\nFEED_SPAM_CHANNEL='feed-spam'\n"

func TestAFeedRefusesToStartOnSettingsItCantUse(t *testing.T) {
	without := func(key string) string {
		var kept []string
		for _, line := range strings.SplitAfter(validSettings, "\n") {
			if !strings.HasPrefix(line, key+"=") {
				kept = append(kept, line)
			}
		}
		return strings.Join(kept, "")
	}
	rooms := "whatsapp2slack needs comma-separated Matrix room IDs in BEEPER_ROOM_IDS"
	for _, c := range []struct{ settings, problem string }{
		{without("SLACK_BOT_TOKEN"), "whatsapp2slack needs SLACK_BOT_TOKEN"},
		{without("OPENAI_API_KEY"), "whatsapp2slack needs OPENAI_API_KEY"},
		{without("FEED_FLAGGED_CHANNEL"), "whatsapp2slack needs FEED_FLAGGED_CHANNEL"},
		{without("FEED_SPAM_CHANNEL"), "whatsapp2slack needs FEED_SPAM_CHANNEL"},
		{"", "whatsapp2slack needs SLACK_BOT_TOKEN"},
		{without("OPENAI_API_KEY") + "OPENAI_API_KEY='  '\n", "whatsapp2slack needs OPENAI_API_KEY"},
		{validSettings + "BEEPER_ROOM_IDS=\n", rooms},
		{validSettings + "BEEPER_ROOM_IDS=whatsapp\n", rooms},
		{validSettings + "BEEPER_ROOM_IDS='!a:example.test,,!b:example.test'\n", rooms},
		{validSettings + "BEEPER_ROOM_IDS='!a b:example.test'\n", rooms},
		// The room list is checked before anything else, as it was.
		{"BEEPER_ROOM_IDS=!\n", rooms},
	} {
		h := setup(t)
		if err := os.WriteFile(filepath.Join(h.home, "env"), []byte(c.settings), 0o600); err != nil {
			t.Fatal(err)
		}
		running, err := newService("whatsapp2slack", "whatsapp").Start(context.Background(), h)
		if err == nil {
			running.Stop()
			t.Errorf("started on %q", c.settings)
			continue
		}
		equal(t, err.Error(), c.problem, c.settings)
	}

	// A settings file that can't be read, or a state file that makes no sense, stops the feed too.
	h := setup(t)
	if err := os.Mkdir(filepath.Join(h.home, "env"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := newService("whatsapp2slack", "whatsapp").Start(context.Background(), h); err == nil {
		t.Error("started on a settings file that is a directory")
	}
	for _, state := range []string{
		`{"since":1,"cursor":-1,"pending":{},"posted":0,"expired":0}`,
		`{"since":1,"cursor":1,"pending":[],"posted":0,"expired":0}`,
		`{"since":1,"cursor":1,"pending":null,"posted":0,"expired":0}`,
		`{"since":1,"cursor":1,"pending":{},"posted":0}`,
		`{"cursor":1,"pending":{},"posted":0,"expired":0}`,
		`{"since":1,"cursor":"1","pending":{},"posted":0,"expired":0}`,
		`{"since":1,`,
	} {
		h := setup(t)
		for name, content := range map[string]string{"env": validSettings, "state.json": state} {
			if err := os.WriteFile(filepath.Join(h.home, name), []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		running, err := newService("whatsapp2slack", "whatsapp").Start(context.Background(), h)
		if err == nil {
			running.Stop()
			t.Errorf("started on the state %s", state)
		} else if !strings.Contains(err.Error(), "invalid Slack feed state") {
			t.Errorf("the state %s was refused with %v", state, err)
		}
	}
}

func TestSettingsChooseRoomsChannelsAndMembers(t *testing.T) {
	settings, err := readSettings("x2slack", parseEnv(validSettings+"FEED_INVITE=' U1, ,U2 '\nBEEPER_ROOM_IDS=!a:beeper.local , !b:beeper.com\n"))
	if err != nil {
		t.Fatal(err)
	}
	equal(t, settings, feedSettings{
		slackToken:     "xoxb-test",
		openAIKey:      "sk-test",
		flaggedChannel: "C0FLAGGED01",
		spamChannel:    "feed-spam",
		invite:         []string{"U1", "U2"},
		roomIDs:        map[string]bool{"!a:beeper.local": true, "!b:beeper.com": true},
	})
	settings, err = readSettings("x2slack", parseEnv(validSettings))
	if err != nil {
		t.Fatal(err)
	}
	if settings.roomIDs != nil || settings.invite != nil {
		t.Errorf("settings without rooms or members gave %+v", settings)
	}
}

// eventually waits for something a feed does on its own time.
func eventually(t *testing.T, what string, done func() bool) {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); !done(); time.Sleep(time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
	}
}

// One message through a started feed, with OpenAI and Slack as local servers: what the feed sends
// them is byte for byte what the TypeScript feed sent for the same message.
func TestSendsOpenAIAndSlackWhatTheTypeScriptFeedSent(t *testing.T) {
	recorded := readReference(t).Exchange
	h := setup(t)
	settings := "# Written by the whatsapp2slack deploy script\n" + validSettings + "FEED_INVITE='U08SB11EKB5,U0AAAAAAAAA'\n"
	if err := os.WriteFile(filepath.Join(h.home, "env"), []byte(settings), 0o600); err != nil {
		t.Fatal(err)
	}
	// The second answer is 31% unsafe in all, which is enough for a feed to hold the message.
	openai := newFakeOpenAI(t, openAIAnswer{body: safeDecision}, openAIAnswer{body: `{"answers":[{"type":"choice","name":"safety","choice":"ok","confidence":0.69,"probabilities":[{"value":"ok","probability":0.69},{"value":"scam_or_fraud","probability":0.16},{"value":"impersonation","probability":0.15}]}],"usage":{"input_tokens":700}}`})
	slack := newFakeSlack(t)
	slack.answer = func(call slackCall, _ url.Values) *slackAnswer {
		switch call.method {
		case "conversations.list":
			return &slackAnswer{body: `{"ok":true,"channels":[{"id":"C0FLAGGED01","name":"feed-flagged"}],"response_metadata":{"next_cursor":""}}`}
		case "conversations.create":
			return &slackAnswer{body: `{"ok":true,"channel":{"id":"C0NEWFEED1","name":"feed-whatsapp"}}`}
		case "chat.postMessage":
			return &slackAnswer{body: `{"ok":true,"ts":"1795294800.000100"}`}
		}
		return nil
	}
	feed := newService("whatsapp2slack", "whatsapp")
	feed.http, feed.slackURL, feed.openAIURL = &http.Client{}, slack.server.URL, openai.server.URL+"/v1"
	feed.now, feed.after = h.clock.now, h.clock.after
	running, err := feed.Start(context.Background(), h)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(running.Stop)
	// The model sees as much of a message as the feed keeps and posts.
	equal(t, running.(*runningFeed).feed.screener.(*decisionsScreener).prompt.maxText, 3_800)

	// A feed starts with new messages, so the message has to arrive after its first pass.
	eventually(t, "the first pass", func() bool { return running.Status()["last_tick_at"] != nil })
	message := recorded.Message
	h.journal.record(journalMessage{
		eventID: message.EventID, roomID: message.RoomID, sender: message.Sender, kind: message.Type,
		text: message.Text, ts: testNow, attachments: message.Attachments,
	}, testNow)
	eventually(t, "the post", func() bool { return running.Status()["posted"] == int64(1) })
	h.record("held", "Wire me the deposit today")
	eventually(t, "the held post", func() bool { return running.Status()["posted"] == int64(2) })
	running.Stop()

	asked := openai.made()
	equal(t, len(asked), 2)
	equal(t, asked[0].body, recorded.DecisionsRequest)
	equal(t, asked[0].authorization, "Bearer sk-test")
	calls := slack.made()
	equal(t, calls[:5], []string{
		"conversations.list " + recorded.SlackForms.List,
		"conversations.create " + recorded.SlackForms.Create,
		"conversations.setPurpose " + recorded.SlackForms.Purpose,
		"conversations.invite " + recorded.SlackForms.Invite,
		"chat.postMessage " + recorded.SlackForms.Post,
	})
	sent, err := url.ParseQuery(recorded.SlackForms.Post)
	if err != nil {
		t.Fatal(err)
	}
	equal(t, sent.Get("text"), recorded.SlackText)
	equal(t, slack.calls[0].authorization, "Bearer xoxb-test")
	// The held message goes straight to the flagged channel, which the settings name by ID.
	equal(t, len(calls), 6)
	held, err := url.ParseQuery(strings.TrimPrefix(calls[5], "chat.postMessage "))
	if err != nil {
		t.Fatal(err)
	}
	equal(t, held.Get("channel"), "C0FLAGGED01")
	equal(t, held.Get("text"), "[Flagged · scam or fraud] whatsapp contact · whatsapp · Alice\n>>> Wire me the deposit today\nChat `!whatsapp:example.test` · message `$held`")

	equal(t, running.Status(), map[string]any{
		"running":      false,
		"failed":       false,
		"start_at":     "2026-11-21T21:00:00.000Z",
		"last_tick_at": "2026-11-21T21:00:00.000Z",
		"pending":      0,
		"posted":       int64(2),
		"expired":      int64(0),
	})
	saved, err := os.ReadFile(filepath.Join(h.home, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, saved); err != nil {
		t.Fatal(err)
	}
	equal(t, compact.String(), `{"since":1795294800000,"cursor":2,"pending":{},"posted":2,"expired":0}`)
	h.mu.Lock()
	defer h.mu.Unlock()
	equal(t, h.logs, []logLine{
		{"info", "screened", map[string]any{
			"route": "safe", "reason": "ok", "by": "model", "wake": false, "pUnsafe": 0.0, "ms": int64(0), "inputTokens": 812.0,
		}},
		{"info", "screened", map[string]any{
			"route": "unsafe", "reason": "scam_or_fraud", "by": "model", "wake": false, "pUnsafe": 0.31, "ms": int64(0), "inputTokens": 700.0,
		}},
	})
}

func TestCarriesOnFromAStateFileTheTypeScriptFeedWrote(t *testing.T) {
	// The file holds three pending messages in this order: one screened as safe and one as spam,
	// both waiting for Slack, and one whose room wasn't known yet. A fourth was posted.
	written, err := os.ReadFile(filepath.Join("testdata", "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	h := setup(t)
	stateFile := filepath.Join(h.home, "whatsapp.json")
	if err := os.WriteFile(stateFile, written, 0o600); err != nil {
		t.Fatal(err)
	}
	name := "new contact"
	h.directory["!new:example.test"] = host.RoomInfo{RoomID: "!new:example.test", Name: &name, Network: "whatsapp"}
	feed := h.make("whatsapp")
	equal(t, feed.status(), map[string]any{
		"start_at":     "2026-11-21T21:00:00.000Z",
		"last_tick_at": nil,
		"pending":      3,
		"posted":       int64(1),
		"expired":      int64(0),
	})

	// Written back unchanged, the file says the same thing in the same order.
	if err := feed.commit(feed.state); err != nil {
		t.Fatal(err)
	}
	rewritten, err := os.ReadFile(stateFile)
	if err != nil {
		t.Fatal(err)
	}
	var before, after bytes.Buffer
	if err := json.Compact(&before, written); err != nil {
		t.Fatal(err)
	}
	if err := json.Compact(&after, rewritten); err != nil {
		t.Fatal(err)
	}
	equal(t, after.String(), before.String())

	h.clock.advance(31_000)
	h.tick(feed)
	equal(t, h.channels(), []string{"feed-whatsapp", "feed-spam", "feed-whatsapp"})
	posts := h.sent()
	for index, start := range []string{"whatsapp contact · whatsapp · Alice\n>>> first: waits", "[Spam · promotion] whatsapp contact · whatsapp · Alice\n>>> spam: second", "new contact · whatsapp · Alice\n>>> third: its room"} {
		if !strings.HasPrefix(posts[index].text, start) {
			t.Errorf("post %d is %q", index, posts[index].text)
		}
	}
	equal(t, h.screenedTexts(), []string{"third: its room isn't in the directory yet"}, "saved verdicts are not asked for again")
	equal[any](t, feed.status()["posted"], int64(4))
	equal[any](t, feed.status()["pending"], 0)
}

func TestStopWaitsForTheDeliveryInFlightAndKeepsItsResult(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := setup(t)
		h.tick(h.make("whatsapp"))
		h.record("in-flight", "on its way to Slack")
		h.record("next", "not started yet")
		h.hold = make(chan struct{})
		running := h.make("whatsapp").start(t.Context(), "whatsapp2slack")
		t.Cleanup(running.Stop)
		synctest.Wait()

		stopped := make(chan struct{})
		go func() {
			running.Stop()
			close(stopped)
		}()
		synctest.Wait()
		select {
		case <-stopped:
			t.Fatal("Stop returned while a post was in flight")
		default:
		}
		equal[any](t, running.Status()["running"], false)

		close(h.hold)
		<-stopped
		equal(t, len(h.sent()), 1, "the post in flight is finished, the next one isn't started")
		equal[any](t, running.Status()["posted"], int64(1))
		equal[any](t, running.Status()["pending"], 1)

		// The next start delivers the rest, and nothing twice.
		h.set(func() { h.hold = nil })
		again := h.make("whatsapp").start(t.Context(), "whatsapp2slack")
		t.Cleanup(again.Stop)
		synctest.Wait()
		var texts []string
		for _, post := range h.sent() {
			texts = append(texts, strings.Split(post.text, "\n")[1])
		}
		equal(t, texts, []string{">>> on its way to Slack", ">>> not started yet"})
	})
}

func TestTheDaemonsContextEndingStopsAFeed(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := setup(t)
		ctx, cancel := context.WithCancel(t.Context())
		running := h.make("whatsapp").start(ctx, "whatsapp2slack")
		synctest.Wait()
		equal[any](t, running.Status()["running"], true)
		cancel()
		synctest.Wait()
		equal[any](t, running.Status()["running"], false)
		h.record("late", "after the daemon stopped")
		synctest.Wait()
		equal(t, h.journal.readCount(), 1)
		running.Stop()
	})
}

func TestAFailedPassIsRunAgainAfterFiveSecondsHoweverManyChangesArrive(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := setup(t)
		running := h.make("whatsapp").start(t.Context(), "whatsapp2slack")
		t.Cleanup(running.Stop)
		synctest.Wait()

		h.set(func() { h.directoryDown = true })
		h.record("first", "arrives while the directory is down")
		synctest.Wait()
		equal(t, h.journal.readCount(), 2)
		equal[any](t, running.Status()["failed"], true)
		equal(t, h.logged(), []string{"warn: Slack feed cycle failed; will retry"})

		h.set(func() { h.directoryDown = false })
		h.record("second", "doesn't hurry the retry")
		synctest.Wait()
		h.clock.advance(4_999)
		synctest.Wait()
		equal(t, h.journal.readCount(), 2)
		h.clock.advance(1)
		synctest.Wait()
		equal(t, h.journal.readCount(), 3)
		equal[any](t, running.Status()["failed"], false)
		equal(t, len(h.sent()), 2)
	})
}
