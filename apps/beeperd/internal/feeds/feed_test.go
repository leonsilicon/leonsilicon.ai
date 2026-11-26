package feeds

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"testing"
	"testing/synctest"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/host"
)

// A started feed runs in its own goroutine, so these tests run in a synctest bubble: Wait returns
// once the feed is waiting again, for the journal or for a timer of the fake clock.

func TestSleepsWhileIdleWakesOnAJournalWriteAndRetriesWithoutAnotherWrite(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := setup(t)
		running := h.make("whatsapp").start(t.Context(), "whatsapp2slack")
		t.Cleanup(running.Stop)
		advance := func(ms int64) {
			h.clock.advance(ms)
			synctest.Wait()
		}

		synctest.Wait()
		equal(t, h.journal.readCount(), 1)
		advance(60_000)
		equal(t, h.journal.readCount(), 1, "idle feeds do not read the journal")

		h.fail("feed-whatsapp", true)
		h.record("retry", "retry me")
		synctest.Wait()
		equal[any](t, running.Status()["pending"], 1)
		equal(t, h.screenedTexts(), []string{"retry me"})
		h.fail("feed-whatsapp", false)
		advance(29_999)
		equal(t, h.journal.readCount(), 2)
		equal(t, len(h.sent()), 0)
		advance(1)
		equal(t, len(h.sent()), 1)
		equal(t, h.screenedTexts(), []string{"retry me"}, "the persisted verdict survives the retry")
		advance(60_000)
		equal(t, h.journal.readCount(), 3)

		running.Stop()
		h.record("stopped", "do not send")
		advance(60_000)
		equal(t, h.journal.readCount(), 3, "stopping removes the journal subscription")
	})
}

func TestDrainsASavedBacklogAndProcessesJournalChangesThatArriveDuringAPass(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := setup(t)
		h.tick(h.make("whatsapp"))
		for index := range 100 {
			h.record(fmt.Sprintf("ignored-%d", index), "ignored network", inRoom("telegram"))
		}
		h.record("backlog", "queued while stopped")
		// These arrive after the pass has read its journal page, as in the TypeScript test, where
		// starting a feed read the page before the next line of the test ran.
		h.journal.afterRead = func() { h.record("during-pass", "new during startup") }
		running := h.make("whatsapp").start(t.Context(), "whatsapp2slack")
		t.Cleanup(running.Stop)

		synctest.Wait()
		equal(t, len(h.sent()), 0, "one pass reads at most one journal page")
		h.clock.runTimers(1)
		synctest.Wait()
		equal(t, h.screenedTexts(), []string{"queued while stopped", "new during startup"})

		h.journal.afterRead = func() { h.record("second-live", "new during delivery") }
		h.record("live", "new while idle")
		synctest.Wait()
		equal(t, len(h.sent()), 3)
		h.clock.runTimers(1)
		synctest.Wait()
		equal(t, h.screenedTexts(), []string{
			"queued while stopped",
			"new during startup",
			"new while idle",
			"new during delivery",
		})
	})
}

func TestKeepsFeedDeliveryAndScreeningWithinTheSelectedNetwork(t *testing.T) {
	h := setup(t)
	h.record("old", "already in the journal")
	whatsapp := h.make("whatsapp")
	instagram := h.make("instagram")
	h.tick(whatsapp)
	h.tick(instagram)
	h.record("backfill", "older history", sentAt(testNow-1))
	h.record("new", "hello <!channel> and <@U123>")
	h.record("own", "my message", inRoom("instagram"), mine)
	h.record("spam", "spam: sale", inRoom("instagram"))
	h.record("unsafe", "unsafe: scam", inRoom("instagram"))
	h.record("slack", "already on Slack", inRoom("slack"))
	h.record("beeper", "Beeper message", inRoom("beeper"))
	h.record("telegram", "Telegram message", inRoom("telegram"))

	h.tick(whatsapp)
	h.tick(instagram)
	h.tick(whatsapp)
	h.tick(instagram)

	equal(t, h.channels(), []string{"feed-whatsapp", "feed-instagram", "feed-spam", "feed-flagged"})
	var created []bool
	for _, destination := range h.destinations {
		created = append(created, destination.create)
	}
	equal(t, created, []bool{true, true, false, false})
	posts := h.sent()
	for _, part := range []string{"whatsapp contact · whatsapp · Alice", "&lt;!channel&gt; and &lt;@U123&gt;"} {
		if !strings.Contains(posts[0].text, part) {
			t.Errorf("%q lacks %q", posts[0].text, part)
		}
	}
	if regexp.MustCompile(`<[@!]`).MatchString(posts[0].text) {
		t.Errorf("%q can mention someone", posts[0].text)
	}
	if !strings.Contains(posts[1].text, "instagram · Leon") {
		t.Errorf("%q lacks Leon's name", posts[1].text)
	}
	equal(t, h.screenedTexts(), []string{
		"hello <!channel> and <@U123>",
		"my message",
		"spam: sale",
		"unsafe: scam",
	})
	equal[any](t, whatsapp.status()["posted"], int64(1))
	equal[any](t, instagram.status()["posted"], int64(3))
}

func TestAllConfiguredNetworksUseTheirOwnChannelsAndIgnoreMessagesFromOtherNetworks(t *testing.T) {
	h := setup(t)
	var feeds []*feed
	for _, network := range feedNetworks {
		feeds = append(feeds, h.make(network))
	}
	for _, feed := range feeds {
		h.tick(feed)
	}
	for _, network := range append(append([]string{}, feedNetworks...), "slack", "beeper", "telegram") {
		h.record(network, network+" message", inRoom(network))
	}
	for _, feed := range feeds {
		h.tick(feed)
		equal[any](t, feed.status()["posted"], int64(1))
		equal[any](t, feed.status()["pending"], 0)
	}
	var messages, channels []string
	for _, network := range feedNetworks {
		messages = append(messages, network+" message")
		channels = append(channels, "feed-"+network)
	}
	equal(t, h.screenedTexts(), messages)
	equal(t, h.channels(), channels)
	for index, post := range h.sent() {
		if !strings.Contains(post.text, messages[index]) {
			t.Errorf("%q lacks %q", post.text, messages[index])
		}
	}
}

func TestRestrictsAFeedToConfiguredRoomsAndRechecksQueuedMessagesOnRestart(t *testing.T) {
	h := setup(t)
	feed := h.make("whatsapp", "!whatsapp:example.test", "!instagram:example.test")
	h.tick(feed)
	h.fail("feed-whatsapp", true)
	h.record("selected", "selected WhatsApp chat")
	h.record("other-chat", "unselected WhatsApp chat", inRoom("other-group"))
	h.record("other-network", "Instagram chat on the WhatsApp allowlist", inRoom("instagram"))
	h.tick(feed)
	equal(t, h.screenedTexts(), []string{"selected WhatsApp chat"})
	equal[any](t, feed.status()["pending"], 1)
	equal(t, len(h.sent()), 0)

	h.fail("feed-whatsapp", false)
	h.clock.advance(31_000)
	narrowed := h.make("whatsapp", "!other-group:example.test")
	h.tick(narrowed)
	equal[any](t, narrowed.status()["pending"], 0)
	equal(t, len(h.sent()), 0)
	h.record("new-selected", "new in selected group", inRoom("other-group"))
	h.tick(narrowed)
	equal(t, len(h.sent()), 1)
	if !strings.Contains(h.sent()[0].text, "new in selected group") {
		t.Errorf("%q is not the selected group's message", h.sent()[0].text)
	}
}

func TestRestartsRetrySlackWithTheSavedVerdictAndApplyEditsAndRedactionsToPendingCopies(t *testing.T) {
	h := setup(t)
	h.tick(h.make("whatsapp"))
	h.fail("feed-whatsapp", true)
	h.record("retry", "retry once")
	h.record("edit", "text before editing")
	h.record("remove", "text before deletion")
	h.tick(h.make("whatsapp"))
	equal(t, len(h.sent()), 0)

	h.fail("feed-whatsapp", false)
	h.clock.advance(31_000)
	h.record("change", "edited text", replacing("$edit"))
	h.journal.redact("$remove")
	h.tick(h.make("whatsapp"))
	equal(t, h.screenedTexts(), []string{
		"retry once",
		"text before editing",
		"text before deletion",
		"edited text",
	})
	posts := h.sent()
	equal(t, len(posts), 2)
	if !strings.Contains(posts[1].text, "edited text") {
		t.Errorf("%q is not the edited message", posts[1].text)
	}
	for _, post := range posts {
		if strings.Contains(post.text, "before editing") || strings.Contains(post.text, "before deletion") {
			t.Errorf("%q is a copy from before the change", post.text)
		}
	}

	h.record("later", "edited after delivery", replacing("$retry"))
	h.tick(h.make("whatsapp"))
	equal(t, len(h.sent()), 2)
}

func TestNewlyJoinedRoomsAreResolvedBeforeMessagesAreRouted(t *testing.T) {
	h := setup(t)
	h.forget("!whatsapp:example.test")
	h.forget("!slack:example.test")
	feed := h.make("whatsapp")
	h.tick(feed)
	h.record("new-chat", "hello")
	h.record("new-slack-chat", "already on Slack", inRoom("slack"))
	h.tick(feed)
	equal(t, h.refreshCount(), 1)
	equal(t, h.channels(), []string{"feed-whatsapp"})
}

func TestSlackFeedsScreenForSafetyAndExposeNoTools(t *testing.T) {
	request := screenRequest(
		screenInput{chat: screenChat{title: "Beeper", network: "beeper", kind: "direct"}},
		"gpt-6-luna",
		screenPrompt{context: "Classify the message", maxText: 3_800},
	)
	var names []string
	for _, question := range request.Questions {
		names = append(names, question.Name)
	}
	equal(t, names, []string{"safety"})

	// The TypeScript test also asked the daemon's command line for the feed's tools. That command
	// line isn't part of this package; here a feed has no server to list and refuses any tool call.
	h := setup(t)
	for _, service := range Services() {
		if service.Server() != nil {
			t.Errorf("%s has an MCP server", service.Name())
		}
		running, err := service.Start(context.Background(), h)
		if err != nil {
			t.Fatal(err)
		}
		_, err = running.CallTool(context.Background(), "register", nil)
		var refusal *host.ToolError
		if !errors.As(err, &refusal) || refusal.Code != "bad_method" {
			t.Errorf("%s answered a tool call with %v", service.Name(), err)
		}
		running.Stop()
	}
}
