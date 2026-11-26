package journal

import (
	"context"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/host"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/sqlitedb"
)

const t0 int64 = 1795000000000

func open(t *testing.T, path string, now int64) *MessageJournal {
	t.Helper()
	db, err := sqlitedb.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	journal, err := New(db, now)
	if err != nil {
		t.Fatal(err)
	}
	return journal
}

func must[T any](value T, err error) func(t *testing.T) T {
	return func(t *testing.T) T {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
}

func check(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func equal(t *testing.T, got, want any, message string) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s: got %#v, want %#v", message, got, want)
	}
}

func eventIDs(entries []host.JournalEntry) []string {
	ids := []string{}
	for _, entry := range entries {
		ids = append(ids, entry.EventID)
	}
	return ids
}

type page struct {
	entries []host.JournalEntry
	cursor  int64
}

func changes(t *testing.T, journal *MessageJournal, options host.ChangesOptions) page {
	t.Helper()
	entries, cursor, err := journal.Changes(context.Background(), options)
	check(t, err)
	return page{entries, cursor}
}

// waitFor starts a waiting Changes call and returns once it listens, as the TypeScript caller is
// listening by the time changesWhenAny has returned its promise.
func waitFor(t *testing.T, journal *MessageJournal, ctx context.Context, options host.ChangesOptions) <-chan page {
	t.Helper()
	journal.mu.Lock()
	before := len(journal.listeners)
	journal.mu.Unlock()
	done := make(chan page, 1)
	go func() {
		entries, cursor, err := journal.Changes(ctx, options)
		if err != nil {
			t.Error(err)
		}
		done <- page{entries, cursor}
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		journal.mu.Lock()
		listening := len(journal.listeners) > before
		journal.mu.Unlock()
		if listening {
			return done
		}
		if time.Now().After(deadline) {
			t.Fatal("the waiting call never started listening")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestPositionsOnlyGrowEditsKeepTheirPlaceWaitsWakeOnTheRightRoom(t *testing.T) {
	journal := open(t, ":memory:", t0)
	say := func(eventID, text string, extra func(*Message)) *host.JournalEntry {
		t.Helper()
		message := Message{RoomID: "!a:x", EventID: eventID, Sender: "@bot:x", Type: "m.text", Text: text, TS: t0}
		if extra != nil {
			extra(&message)
		}
		return must(journal.Record(message, t0))(t)
	}
	equal(t, must(journal.Head())(t), int64(0), "head of a new journal")
	equal(t, must(journal.CoveredSince())(t), t0, "a new journal vouches from its start")
	equal(t,
		[]int64{say("$1", "one", nil).Seq, say("$2", "two", func(m *Message) { m.TS = t0 + 5 }).Seq},
		[]int64{1, 2}, "positions")
	if say("$1", "one again", nil) != nil {
		t.Fatal("a repeat is ignored")
	}
	edit := say("$e", "* uno", func(m *Message) { m.Replaces = "$1" })
	equal(t,
		[]any{edit.EventID, edit.Text, edit.Seq, edit.Rev, edit.Edited},
		[]any{"$1", "* uno", int64(1), int64(3), true}, "an edit")
	equal(t, eventIDs(changes(t, journal, host.ChangesOptions{After: 2}).entries), []string{"$1"},
		"only what changed after the position")
	equal(t, eventIDs(must(journal.Since("!a:x", t0))(t)), []string{"$1", "$2"}, "by time sent, not by change")
	// A message from before the journal began can be delivered late; it isn't one of "the latest".
	say("$ancient", "from last week", func(m *Message) { m.TS = t0 - 7*24*3600_000 })
	equal(t, eventIDs(must(journal.Latest("!a:x", 10))(t)), []string{"$1", "$2"}, "the latest")
	// An edit of a message from before the journal still shows up, under the message's ID.
	equal(t, say("$e2", "rewritten", func(m *Message) { m.Replaces = "$old" }).EventID, "$old", "an edit of an unknown message")

	// Waiting: another room's message doesn't wake it; this room's does; a timeout returns nothing.
	head := must(journal.Head())(t)
	started := time.Now()
	waiting := waitFor(t, journal, context.Background(), host.ChangesOptions{After: head, RoomID: "!a:x", Wait: 2 * time.Second})
	must(journal.Record(Message{RoomID: "!b:x", EventID: "$other", Sender: "@c:x", Type: "m.text", Text: "x", TS: t0}, t0))(t)
	select {
	case <-waiting:
		t.Fatal("another room's message woke the wait")
	case <-time.After(15 * time.Millisecond):
	}
	say("$3", "three", nil)
	equal(t, eventIDs((<-waiting).entries), []string{"$3"}, "this room's message ends the wait")
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("the wait ended after %v, not when the message arrived", elapsed)
	}
	head = must(journal.Head())(t)
	quiet := changes(t, journal, host.ChangesOptions{After: head, RoomID: "!a:x", Wait: 20 * time.Millisecond})
	equal(t, []any{len(quiet.entries), quiet.cursor}, []any{0, head}, "a timeout returns nothing")

	// Late keys: held back, retried with a growing delay, five times at most.
	check(t, journal.Pending("!a:x", "$late", "@bot:x", t0))
	equal(t, must(journal.Stats())(t).Pending, 1, "waiting for keys")
	equal(t, len(must(journal.PendingDue(t0+10_000, 0))(t)), 0, "not yet")
	equal(t, must(journal.PendingDue(t0+31_000, 0))(t), []PendingEvent{{RoomID: "!a:x", EventID: "$late"}}, "due")
	equal(t, len(must(journal.PendingDue(t0+31_000, 0))(t)), 0, "the next try is later")
	for range 6 {
		must(journal.PendingDue(t0+3_600_000, 0))(t)
	}
	equal(t, len(must(journal.PendingDue(t0+7_200_000, 0))(t)), 0, "it gives up")
	equal(t, say("$late", "arrived", nil).Text, "arrived", "a late decryption")
	equal(t, must(journal.Stats())(t).Pending, 0, "nothing left waiting")

	// Coverage restarts after an absence; old messages are dropped.
	check(t, journal.Alive(t0+GapMS-1))
	equal(t, must(journal.CoveredSince())(t), t0, "a short absence")
	check(t, journal.Alive(t0+3*GapMS))
	equal(t, must(journal.CoveredSince())(t), t0+3*GapMS, "a long absence")
	check(t, journal.Prune(t0+RetentionMS+1))
	equal(t, must(journal.Stats())(t).Entries, 0, "old messages are dropped")
	if head := must(journal.Head())(t); head < 8 {
		t.Fatalf("positions are never reused: head is %d", head)
	}
}

// The journal as the inbox drives it from sync: messages are written down once; edits, late keys and
// deletions update them.
func TestSyncMessagesAreWrittenDownOnce(t *testing.T) {
	const room = "!chat:beeper.local"
	journal := open(t, ":memory:", time.Now().UnixMilli())
	wakes := 0
	unsubscribe := journal.Subscribe(func() { wakes++ })
	message := func(eventID, text string) Message {
		return Message{
			RoomID: room, EventID: eventID, Sender: "@sam:beeper.local", Type: "m.text", Text: text,
			TS: time.Now().UnixMilli(),
		}
	}
	record := func(message Message) {
		t.Helper()
		must(journal.Record(message, time.Now().UnixMilli()))(t)
	}

	head := must(journal.Head())(t)
	if age := time.Now().UnixMilli() - must(journal.CoveredSince())(t); age >= 60_000 {
		t.Fatalf("a new journal vouches from now, not from %d ms ago", age)
	}
	waiting := waitFor(t, journal, context.Background(), host.ChangesOptions{After: head, RoomID: room, Wait: 5 * time.Second})
	time.AfterFunc(20*time.Millisecond, func() {
		if _, err := journal.Record(message("$m1", "hi"), time.Now().UnixMilli()); err != nil {
			t.Error(err)
		}
	})
	first := <-waiting
	equal(t, len(first.entries), 1, "the first message")
	equal(t,
		[]any{first.entries[0].EventID, first.entries[0].Text, first.entries[0].IsMe, first.entries[0].Edited},
		[]any{"$m1", "hi", false, false}, "the first message")
	record(message("$m1", "hi"))
	equal(t, len(changes(t, journal, host.ChangesOptions{After: first.cursor}).entries), 0, "seen before")

	// An edit changes the message it replaces.
	edit := message("$m2", "hello")
	edit.Replaces = "$m1"
	record(edit)
	edited := changes(t, journal, host.ChangesOptions{After: first.cursor, RoomID: room})
	equal(t, len(edited.entries), 1, "the edit")
	equal(t,
		[]any{edited.entries[0].EventID, edited.entries[0].Text, edited.entries[0].Edited, edited.entries[0].Seq},
		[]any{"$m1", "hello", true, first.entries[0].Seq}, "the edit")
	if edited.entries[0].Rev <= first.entries[0].Rev {
		t.Fatal("an edit moves the message to a later position")
	}

	// An event without its keys yet is held back until it can be read.
	check(t, journal.Pending(room, "$m3", "@sam:beeper.local", time.Now().UnixMilli()))
	equal(t, len(changes(t, journal, host.ChangesOptions{After: edited.cursor}).entries), 0, "held back")
	equal(t, must(journal.Stats())(t).Pending, 1, "waiting for keys")
	record(message("$m3", "now readable"))
	late := changes(t, journal, host.ChangesOptions{After: edited.cursor})
	equal(t, len(late.entries), 1, "the late decryption")
	equal(t, []any{late.entries[0].EventID, late.entries[0].Text}, []any{"$m3", "now readable"}, "the late decryption")

	must(journal.Redact("$m3"))(t)
	gone := changes(t, journal, host.ChangesOptions{After: late.cursor})
	equal(t, len(gone.entries), 1, "the deletion")
	equal(t,
		[]any{gone.entries[0].EventID, gone.entries[0].Text, gone.entries[0].Redacted},
		[]any{"$m3", "", true}, "the deletion")
	equal(t, eventIDs(must(journal.Latest(room, 5))(t)), []string{"$m1", "$m3"}, "the latest")
	equal(t, eventIDs(must(journal.Recent(0, 0))(t)), []string{"$m1", "$m3"}, "every room's messages since a time")

	equal(t, wakes, 4, "new messages, edits, late decryptions and redactions wake subscribers")
	unsubscribe()
	record(message("$m5", "after unsubscribe"))
	equal(t, wakes, 4, "an unsubscribed listener is left alone")
}

func TestOptionalFieldsAndWhatAnEditKeeps(t *testing.T) {
	journal := open(t, ":memory:", t0)
	html := "<b>one</b>"
	first := must(journal.Record(Message{
		RoomID: "!a:x", EventID: "$1", Sender: "@a:x", IsMe: true, Type: "m.text", Text: "one", HTML: &html,
		TS: t0 + 1, ReplyTo: "$0", Attachments: 2,
	}, t0+9))(t)
	equal(t, *first, host.JournalEntry{
		Seq: 1, Rev: 1, RoomID: "!a:x", EventID: "$1", Sender: "@a:x", IsMe: true, Type: "m.text", Text: "one",
		HTML: &html, TS: t0 + 1, ReceivedAt: t0 + 9, ReplyTo: &[]string{"$0"}[0], Attachments: 2,
	}, "every field is written down")

	// An edit brings its own text, type, sender and attachments; the message keeps its place, the time
	// it was sent and what it answers.
	edit := must(journal.Record(Message{
		RoomID: "!a:x", EventID: "$2", Sender: "@b:x", Type: "m.notice", Text: "uno", TS: t0 + 500, Replaces: "$1",
	}, t0+900))(t)
	equal(t, *edit, host.JournalEntry{
		Seq: 1, Rev: 2, RoomID: "!a:x", EventID: "$1", Sender: "@b:x", Type: "m.notice", Text: "uno",
		TS: t0 + 1, ReceivedAt: t0 + 9, Edited: true, ReplyTo: &[]string{"$0"}[0],
	}, "an edit")

	// A message that waited for its keys takes the time it was really sent.
	check(t, journal.Pending("!a:x", "$3", "@a:x", t0+10))
	late := must(journal.Record(Message{RoomID: "!a:x", EventID: "$3", Sender: "@a:x", Type: "m.text", Text: "three", TS: t0 + 3}, t0+99))(t)
	equal(t, []int64{late.Seq, late.Rev, late.TS, late.ReceivedAt}, []int64{3, 4, t0 + 3, t0 + 10}, "a late decryption")

	// A deletion of something unknown, or already deleted, changes nothing.
	if must(journal.Redact("$unknown"))(t) != nil {
		t.Fatal("an unknown message can't be deleted")
	}
	equal(t, must(journal.Redact("$1"))(t).HTML, (*string)(nil), "a deleted message loses its formatted text")
	if must(journal.Redact("$1"))(t) != nil {
		t.Fatal("a message is deleted once")
	}
	equal(t, must(journal.Head())(t), int64(5), "only real changes take a position")
}

func TestLimits(t *testing.T) {
	journal := open(t, ":memory:", t0)
	for i := range 205 {
		must(journal.Record(Message{RoomID: "!a:x", EventID: "$" + string(rune('A'+i/26)) + string(rune('a'+i%26)), Sender: "@a:x", Type: "m.text", TS: t0 + int64(i)}, t0))(t)
	}
	all := changes(t, journal, host.ChangesOptions{})
	equal(t, []any{len(all.entries), all.cursor}, []any{200, int64(200)}, "200 changes unless asked otherwise")
	equal(t, len(changes(t, journal, host.ChangesOptions{After: all.cursor}).entries), 5, "the cursor continues the page")
	equal(t, len(changes(t, journal, host.ChangesOptions{Limit: -3}).entries), 1, "at least one")
	equal(t, len(changes(t, journal, host.ChangesOptions{Limit: 5000}).entries), 205, "1000 at most")
	equal(t, len(must(journal.Latest("!a:x", 0))(t)), 1, "at least one of the latest")
	equal(t, eventIDs(must(journal.Latest("!a:x", 2))(t)), []string{"$Hv", "$Hw"}, "the latest, oldest first")
	equal(t, len(must(journal.Recent(t0+200, 0))(t)), 5, "since a time")
	equal(t, len(must(journal.Recent(0, 3))(t)), 3, "the oldest, up to the limit")
}

func TestWaitEndsWithTheContext(t *testing.T) {
	journal := open(t, ":memory:", t0)
	ctx, cancel := context.WithCancel(context.Background())
	started := time.Now()
	waiting := waitFor(t, journal, ctx, host.ChangesOptions{After: 0, Wait: time.Minute})
	cancel()
	got := <-waiting
	equal(t, []any{len(got.entries), got.cursor}, []any{0, int64(0)}, "nothing arrived")
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("the wait outlived its context by %v", elapsed)
	}
	journal.mu.Lock()
	defer journal.mu.Unlock()
	equal(t, len(journal.listeners), 0, "a finished wait stops listening")
}

func TestAListenersFailureIsItsOwn(t *testing.T) {
	journal := open(t, ":memory:", t0)
	heard := 0
	journal.SubscribeEntries(func(host.JournalEntry) { panic("listener bug") })
	journal.SubscribeEntries(func(entry host.JournalEntry) {
		heard++
		// A listener can read the journal: the change is committed and no lock is held.
		if head, err := journal.Head(); err != nil || head != entry.Rev {
			t.Errorf("head is %d (%v) while hearing of position %d", head, err, entry.Rev)
		}
	})
	entry := must(journal.Record(Message{RoomID: "!a:x", EventID: "$1", Sender: "@a:x", Type: "m.text", TS: t0}, t0))(t)
	equal(t, []any{entry.Seq, heard}, []any{int64(1), 1}, "the message is written down and the other listener hears of it")
}

func TestSeveralWritersAndWaiters(t *testing.T) {
	journal := open(t, filepath.Join(t.TempDir(), "inbox.db"), t0)
	const writers, each = 8, 25
	var waiters sync.WaitGroup
	for range 4 {
		waiters.Add(1)
		go func() {
			defer waiters.Done()
			var after int64
			seen := 0
			for seen < writers*each {
				entries, cursor, err := journal.Changes(context.Background(), host.ChangesOptions{After: after, Wait: 10 * time.Second})
				if err != nil {
					t.Error(err)
					return
				}
				if len(entries) == 0 {
					t.Error("a wait ended with nothing while messages were still coming")
					return
				}
				seen += len(entries)
				after = cursor
			}
		}()
	}
	var writing sync.WaitGroup
	for writer := range writers {
		writing.Add(1)
		go func() {
			defer writing.Done()
			for i := range each {
				eventID := "$" + string(rune('a'+writer)) + string(rune('a'+i))
				if _, err := journal.Record(Message{RoomID: "!a:x", EventID: eventID, Sender: "@a:x", Type: "m.text", TS: t0}, t0); err != nil {
					t.Error(err)
				}
			}
		}()
	}
	writing.Wait()
	waiters.Wait()
	all := changes(t, journal, host.ChangesOptions{Limit: 1000})
	equal(t, len(all.entries), writers*each, "every message is written down")
	for index, entry := range all.entries {
		if entry.Seq != int64(index+1) || entry.Rev != entry.Seq {
			t.Fatalf("entry %d has position %d/%d", index, entry.Seq, entry.Rev)
		}
	}
}

func TestTheJournalSurvivesARestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "inbox.db")
	db, err := sqlitedb.Open(path)
	check(t, err)
	journal, err := New(db, t0)
	check(t, err)
	must(journal.Record(Message{RoomID: "!a:x", EventID: "$1", Sender: "@a:x", Type: "m.text", Text: "one", TS: t0}, t0))(t)
	check(t, db.Close())

	// Back within the gap: the journal still vouches for everything since its start.
	journal = open(t, path, t0+GapMS-1)
	equal(t, must(journal.CoveredSince())(t), t0, "coverage after a short absence")
	equal(t, eventIDs(must(journal.Latest("!a:x", 5))(t)), []string{"$1"}, "what was written down is still there")
	equal(t, must(journal.Record(Message{RoomID: "!a:x", EventID: "$2", Sender: "@a:x", Type: "m.text", TS: t0}, t0))(t).Seq, int64(2), "positions continue")
}
