package feeds

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/synctest"
)

// The feed's waits and limits. The TypeScript tests didn't cover these; every expectation here is
// what the TypeScript feed did when it was taken through the same steps.

const (
	minute = int64(60_000)
	day    = 24 * 60 * minute
)

func TestRetriesADeliveryWithWaitsThatDoubleUpToTenMinutes(t *testing.T) {
	h := setup(t)
	feed := h.make("whatsapp")
	h.tick(feed)
	h.fail("feed-whatsapp", true)
	h.record("stuck", "Slack is down")
	var waits []int64
	for range 7 {
		wait := h.wait(feed)
		waits = append(waits, wait)
		h.clock.advance(wait)
	}
	equal(t, waits, []int64{30_000, minute, 2 * minute, 4 * minute, 8 * minute, 10 * minute, 10 * minute})
	equal(t, h.screenedTexts(), []string{"Slack is down"}, "the message is screened once")

	h.fail("feed-whatsapp", false)
	h.tick(feed)
	equal(t, h.channels(), []string{"feed-whatsapp"})
}

func TestTheWaitStartsOverOnceAMessageIsScreened(t *testing.T) {
	h := setup(t)
	feed := h.make("whatsapp")
	h.tick(feed)
	h.set(func() { h.screenerDown = true })
	h.record("late", "screened on the third try")
	equal(t, h.wait(feed), 30_000)
	h.clock.advance(30_000)
	equal(t, h.wait(feed), minute)
	h.clock.advance(minute)

	h.set(func() { h.screenerDown = false })
	h.fail("feed-whatsapp", true)
	equal(t, h.wait(feed), 30_000)
	equal(t, h.logged(), []string{
		"warn: message screening will retry",
		"warn: message screening will retry",
		"warn: Slack delivery will retry",
	})
}

func TestHoldsAMessageTheScreenerCantCheckForFifteenMinutes(t *testing.T) {
	h := setup(t)
	feed := h.make("whatsapp")
	h.tick(feed)
	h.set(func() { h.screenerDown = true })
	h.record("unchecked", "first words")
	h.tick(feed)

	// An edit makes the message due at once and keeps the time it was first queued.
	h.clock.advance(15*minute - 1)
	h.record("edit-1", "second words", replacing("$unchecked"))
	h.tick(feed)
	equal(t, len(h.sent()), 0)
	equal[any](t, feed.status()["pending"], 1)

	h.clock.advance(1)
	h.record("edit-2", "last words", replacing("$unchecked"))
	h.tick(feed)
	equal(t, h.sent(), []slackPost{{
		channel: "feed-flagged",
		text:    "[Flagged · the screener couldn't check it, so it's held to be safe] whatsapp contact · whatsapp · Alice\n>>> last words\nChat `!whatsapp:example.test` · message `$unchecked`",
	}})
	equal(t, h.destinations, []slackDestination{{channel: "feed-flagged", create: false}})
	equal(t, h.logged(), []string{"warn: message screening will retry", "warn: message screening will retry"})
}

func TestDropsAMessageThatCantBeDeliveredForSevenDays(t *testing.T) {
	h := setup(t)
	feed := h.make("whatsapp")
	h.tick(feed)
	h.fail("feed-whatsapp", true)
	h.record("undelivered", "first words")
	h.tick(feed)

	h.clock.advance(7*day - 1)
	h.record("edit-1", "second words", replacing("$undelivered"))
	h.tick(feed)
	equal[any](t, feed.status()["pending"], 1)
	equal[any](t, feed.status()["expired"], int64(0))

	h.clock.advance(1)
	h.fail("feed-whatsapp", false)
	h.record("edit-2", "last words", replacing("$undelivered"))
	h.tick(feed)
	equal[any](t, feed.status()["pending"], 0)
	equal[any](t, feed.status()["expired"], int64(1))
	equal[any](t, feed.status()["posted"], int64(0))
	equal(t, len(h.sent()), 0)
	equal(t, h.logged(), []string{
		"warn: Slack delivery will retry",
		"warn: Slack delivery will retry",
		"warn: message expired before Slack delivery",
	})
}

func TestRefreshesTheDirectoryForAnUnknownRoomAtMostOnceAMinute(t *testing.T) {
	h := setup(t)
	feed := h.make("whatsapp")
	h.tick(feed)
	// No refresh makes this room known, so the message stays pending.
	h.record("stranger", "first words", inRoom("stranger"))
	h.tick(feed)
	equal(t, h.refreshCount(), 1)
	equal[any](t, feed.status()["pending"], 1)

	h.clock.advance(minute - 1)
	h.record("edit-1", "second words", replacing("$stranger"))
	h.tick(feed)
	equal(t, h.refreshCount(), 1)

	h.clock.advance(1)
	h.set(func() { h.refreshDown = true })
	h.record("edit-2", "last words", replacing("$stranger"))
	h.tick(feed)
	equal(t, h.refreshCount(), 2)
	equal[any](t, feed.status()["pending"], 1)
	equal(t, h.logged(), []string{"warn: room directory refresh will retry"})
	equal(t, len(h.screenedTexts()), 0, "nothing is screened before its room is known")
}

func TestReadsTheJournalAHundredChangesAtATimeFromItsCursor(t *testing.T) {
	h := setup(t)
	h.record("before", "in the journal before the feed first ran")
	feed := h.make("whatsapp")
	h.tick(feed)
	h.record("one", "first")
	h.record("two", "second")
	h.tick(feed)
	h.tick(feed)
	var after []int64
	for _, asked := range h.journal.asked {
		equal(t, asked.Limit, 100)
		equal(t, asked.RoomID, "")
		equal(t, asked.Wait, 0)
		after = append(after, asked.After)
	}
	equal(t, after, []int64{1, 1, 3})
	equal(t, len(h.sent()), 2)
}

func TestAPassWithNothingNewLeavesTheStateFileAlone(t *testing.T) {
	h := setup(t)
	feed := h.make("whatsapp")
	h.tick(feed)
	// The feed doesn't read its file again, so a mark in it shows whether a pass wrote it.
	stateFile := filepath.Join(h.home, "whatsapp.json")
	if err := os.WriteFile(stateFile, []byte("untouched"), 0o600); err != nil {
		t.Fatal(err)
	}
	h.tick(feed)
	saved, err := os.ReadFile(stateFile)
	if err != nil {
		t.Fatal(err)
	}
	equal(t, string(saved), "untouched")
}

func TestTheDaemonsContextEndingLetsTheDeliveryInFlightFinish(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := setup(t)
		h.tick(h.make("whatsapp"))
		h.record("in-flight", "on its way to Slack")
		h.hold = make(chan struct{})
		ctx, cancel := context.WithCancel(t.Context())
		running := h.make("whatsapp").start(ctx, "whatsapp2slack")
		synctest.Wait()
		cancel()
		synctest.Wait()
		close(h.hold)
		running.Stop()
		equal(t, len(h.sent()), 1)
		equal(t, h.postContexts, []error{nil}, "the post is not cut off")
		equal[any](t, running.Status()["posted"], int64(1))
		if !strings.Contains(h.sent()[0].text, "on its way to Slack") {
			t.Errorf("posted %q", h.sent()[0].text)
		}
	})
}

func TestAFeedThatIsStoppingStartsNoDelivery(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := setup(t)
		h.tick(h.make("whatsapp"))
		h.record("waiting", "read but not delivered")
		ctx, cancel := context.WithCancel(t.Context())
		// The daemon stops while the pass is reading the journal.
		h.journal.afterRead = cancel
		running := h.make("whatsapp").start(ctx, "whatsapp2slack")
		synctest.Wait()
		running.Stop()
		equal[any](t, running.Status()["pending"], 1)
		equal(t, len(h.screenedTexts()), 0)
		equal(t, len(h.sent()), 0)
		equal(t, h.lookups, 1, "the room is looked up when the message is read, and not again to deliver it")
	})
}
