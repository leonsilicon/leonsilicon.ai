package feeds

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/host"
)

// testNow is 2026-11-21T21:00:00Z.
var testNow = time.Date(2026, 11, 21, 21, 0, 0, 0, time.UTC).UnixMilli()

var feedNetworks = []string{"discord", "instagram", "linkedin", "reddit", "wechat", "whatsapp", "x"}

func equal[T any](t *testing.T, got, want T, about ...string) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s\n got %#v\nwant %#v", strings.Join(about, " "), got, want)
	}
}

func never() bool { return false }

// fakeClock is time that moves only when a test says so, for both the feed's clock and the timers
// it waits on.
type fakeClock struct {
	mu      sync.Mutex
	time    int64
	elapsed int64
	timers  []fakeTimer
}

type fakeTimer struct {
	at   int64
	fire chan time.Time
}

func (c *fakeClock) now() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.time
}

func (c *fakeClock) after(wait time.Duration) <-chan time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	fire := make(chan time.Time, 1)
	c.timers = append(c.timers, fakeTimer{at: c.elapsed + wait.Milliseconds(), fire: fire})
	return fire
}

// advance moves the clock and the timers together.
func (c *fakeClock) advance(ms int64) {
	c.mu.Lock()
	c.time += ms
	c.mu.Unlock()
	c.runTimers(ms)
}

// runTimers lets time pass for the timers only. A timer set for "now" still needs it, which is
// how a test sees the feed between two passes.
func (c *fakeClock) runTimers(ms int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.elapsed += ms
	c.timers = slices.DeleteFunc(c.timers, func(timer fakeTimer) bool {
		if timer.at > c.elapsed {
			return false
		}
		timer.fire <- time.Time{}
		return true
	})
}

// fakeJournal keeps messages the way the inbox journal does: a message gets a position when it
// arrives and a new one whenever it changes.
type fakeJournal struct {
	mu        sync.Mutex
	head      int64
	entries   []host.JournalEntry
	listeners map[int]func()
	listener  int
	reads     int
	// asked is what every read asked for.
	asked []host.ChangesOptions
	// afterRead runs once, after the next page is read: a change that lands during a pass.
	afterRead func()
}

type journalMessage struct {
	eventID     string
	roomID      string
	sender      string
	isMe        bool
	kind        string
	text        string
	ts          int64
	attachments int
	html        *string
	replyTo     *string
	// replaces makes this an edit of another message.
	replaces string
}

func (j *fakeJournal) record(message journalMessage, now int64) {
	j.mu.Lock()
	target := message.eventID
	if message.replaces != "" {
		target = message.replaces
	}
	index := slices.IndexFunc(j.entries, func(entry host.JournalEntry) bool { return entry.EventID == target })
	if index >= 0 && message.replaces == "" {
		j.mu.Unlock()
		return
	}
	j.head++
	if index >= 0 {
		entry := &j.entries[index]
		entry.Rev, entry.Edited = j.head, true
		entry.Sender, entry.IsMe, entry.Type, entry.Text, entry.Attachments = message.sender, message.isMe, message.kind, message.text, message.attachments
		entry.HTML = message.html
		if message.replyTo != nil {
			entry.ReplyTo = message.replyTo
		}
	} else {
		j.entries = append(j.entries, host.JournalEntry{
			Seq: j.head, Rev: j.head, RoomID: message.roomID, EventID: target, Sender: message.sender,
			IsMe: message.isMe, Type: message.kind, Text: message.text, TS: message.ts, ReceivedAt: now,
			Edited: message.replaces != "", HTML: message.html, ReplyTo: message.replyTo, Attachments: message.attachments,
		})
	}
	j.changed()
}

// redact takes a message's text away and keeps its place.
func (j *fakeJournal) redact(eventID string) {
	j.mu.Lock()
	index := slices.IndexFunc(j.entries, func(entry host.JournalEntry) bool { return entry.EventID == eventID })
	if index < 0 || j.entries[index].Redacted {
		j.mu.Unlock()
		return
	}
	j.head++
	entry := &j.entries[index]
	entry.Rev, entry.Text, entry.Redacted = j.head, "", true
	j.changed()
}

// changed wakes the listeners. It is called with the lock held and gives it up first.
func (j *fakeJournal) changed() {
	listeners := make([]func(), 0, len(j.listeners))
	for _, listener := range j.listeners {
		listeners = append(listeners, listener)
	}
	j.mu.Unlock()
	for _, wake := range listeners {
		wake()
	}
}

func (j *fakeJournal) readCount() int {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.reads
}

func (j *fakeJournal) Head() (int64, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.head, nil
}

func (j *fakeJournal) Changes(_ context.Context, options host.ChangesOptions) ([]host.JournalEntry, int64, error) {
	j.mu.Lock()
	j.reads++
	j.asked = append(j.asked, options)
	var page []host.JournalEntry
	for _, entry := range j.entries {
		if entry.Rev > options.After {
			page = append(page, entry)
		}
	}
	slices.SortFunc(page, func(a, b host.JournalEntry) int { return int(a.Rev - b.Rev) })
	if len(page) > options.Limit {
		page = page[:options.Limit]
	}
	cursor := options.After
	if len(page) > 0 {
		cursor = page[len(page)-1].Rev
	}
	afterRead := j.afterRead
	j.afterRead = nil
	j.mu.Unlock()
	if afterRead != nil {
		afterRead()
	}
	return page, cursor, nil
}

func (j *fakeJournal) Subscribe(wake func()) func() {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.listeners == nil {
		j.listeners = map[int]func(){}
	}
	j.listener++
	id := j.listener
	j.listeners[id] = wake
	return func() {
		j.mu.Lock()
		defer j.mu.Unlock()
		delete(j.listeners, id)
	}
}

var errUnused = errors.New("the feeds don't use this")

func (j *fakeJournal) CoveredSince() (int64, error)                     { return 0, errUnused }
func (j *fakeJournal) Latest(string, int) ([]host.JournalEntry, error)  { return nil, errUnused }
func (j *fakeJournal) Since(string, int64) ([]host.JournalEntry, error) { return nil, errUnused }
func (j *fakeJournal) Recent(int64, int) ([]host.JournalEntry, error)   { return nil, errUnused }

type slackPost struct{ channel, text string }

type slackDestination struct {
	channel string
	create  bool
}

type logLine struct {
	level, message string
	fields         map[string]any
}

// harness is a fake daemon, Slack and screener around the feeds of one test.
type harness struct {
	t       *testing.T
	home    string
	clock   *fakeClock
	journal *fakeJournal

	mu           sync.Mutex
	posts        []slackPost
	destinations []slackDestination
	screened     []string
	failures     map[string]bool
	directory    map[string]host.RoomInfo
	refreshes    int
	lookups      int
	recorded     []string
	logs         []logLine
	// directoryDown makes room lookups fail, and with them the whole pass. refreshDown and
	// screenerDown fail the directory refresh and the screener.
	directoryDown bool
	refreshDown   bool
	screenerDown  bool
	// hold, when set, keeps every Slack post in flight until it is closed.
	hold chan struct{}
	// postContexts is the state of the context each Slack post was made with, at the time it was made.
	postContexts []error
}

func testRooms() []host.RoomInfo {
	var rooms []host.RoomInfo
	for _, id := range slices.Concat(feedNetworks, []string{"slack", "beeper", "telegram", "other-group"}) {
		name := id + " contact"
		room := host.RoomInfo{RoomID: "!" + id + ":example.test", Network: id, Name: &name, IsDirect: true}
		if id == "other-group" {
			room.Network = "whatsapp"
		}
		if id == "slack" {
			protocol := "slackgo"
			room.ProtocolID = &protocol
		}
		rooms = append(rooms, room)
	}
	return rooms
}

func setup(t *testing.T) *harness {
	h := &harness{
		t:         t,
		home:      t.TempDir(),
		clock:     &fakeClock{time: testNow},
		journal:   &fakeJournal{},
		failures:  map[string]bool{},
		directory: map[string]host.RoomInfo{},
	}
	for _, room := range testRooms() {
		h.directory[room.RoomID] = room
	}
	// Nothing a contact wrote may reach the log.
	t.Cleanup(func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		logged, err := json.Marshal(h.logLines())
		if err != nil {
			t.Fatal(err)
		}
		for _, text := range h.recorded {
			if strings.Contains(string(logged), text) {
				t.Errorf("the log holds message text %q: %s", text, logged)
			}
		}
	})
	return h
}

// logLines is the log as JSON-ready values. The caller holds the lock.
func (h *harness) logLines() []map[string]any {
	lines := make([]map[string]any, len(h.logs))
	for i, line := range h.logs {
		lines[i] = map[string]any{"level": line.level, "message": line.message, "fields": line.fields}
	}
	return lines
}

// make opens a feed on the harness. Feeds of the same network share a state file, as a feed and
// its restart do.
func (h *harness) make(network string, roomIDs ...string) *feed {
	h.t.Helper()
	options := feedOptions{
		network:        network,
		host:           h,
		slack:          h,
		screener:       h,
		flaggedChannel: "feed-flagged",
		spamChannel:    "feed-spam",
		stateFile:      filepath.Join(h.home, network+".json"),
		now:            h.clock.now,
		after:          h.clock.after,
	}
	if len(roomIDs) > 0 {
		options.roomIDs = map[string]bool{}
		for _, id := range roomIDs {
			options.roomIDs[id] = true
		}
	}
	feed, err := newFeed(options)
	if err != nil {
		h.t.Fatal(err)
	}
	return feed
}

// tick runs one pass of a feed that isn't started.
func (h *harness) tick(feed *feed) {
	h.t.Helper()
	if _, _, err := feed.tick(context.Background(), never); err != nil {
		h.t.Fatal(err)
	}
}

// wait runs one pass and returns how long the feed then waits before its next one.
func (h *harness) wait(feed *feed) int64 {
	h.t.Helper()
	nextAt, due, err := feed.tick(context.Background(), never)
	if err != nil || !due {
		h.t.Fatalf("the pass ended with %v, and a next pass due is %v", err, due)
	}
	return nextAt - h.clock.now()
}

type recordOption func(*journalMessage)

func inRoom(room string) recordOption {
	return func(message *journalMessage) { message.roomID = "!" + room + ":example.test" }
}

func sentAt(ts int64) recordOption { return func(message *journalMessage) { message.ts = ts } }

func mine(message *journalMessage) { message.isMe = true }

func replacing(eventID string) recordOption {
	return func(message *journalMessage) { message.replaces = eventID }
}

// record writes a message from Alice into the journal: in the WhatsApp chat and sent now, unless
// the options say otherwise.
func (h *harness) record(id, text string, options ...recordOption) {
	now := h.clock.now()
	message := journalMessage{eventID: "$" + id, roomID: "!whatsapp:example.test", sender: "@alice:example.test", kind: "m.text", text: text, ts: now}
	for _, option := range options {
		option(&message)
	}
	h.mu.Lock()
	h.recorded = append(h.recorded, text)
	h.mu.Unlock()
	h.journal.record(message, now)
}

func (h *harness) set(change func()) {
	h.mu.Lock()
	defer h.mu.Unlock()
	change()
}

func (h *harness) logged() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	var messages []string
	for _, line := range h.logs {
		messages = append(messages, line.level+": "+line.message)
	}
	return messages
}

func (h *harness) forget(roomID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.directory, roomID)
}

func (h *harness) fail(channel string, failing bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if failing {
		h.failures[channel] = true
	} else {
		delete(h.failures, channel)
	}
}

func (h *harness) sent() []slackPost {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.posts)
}

func (h *harness) channels() []string {
	var channels []string
	for _, post := range h.sent() {
		channels = append(channels, post.channel)
	}
	return channels
}

func (h *harness) screenedTexts() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.screened)
}

func (h *harness) refreshCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.refreshes
}

// The daemon, as the feeds see it.

func (h *harness) Journal() host.Journal { return h.journal }
func (h *harness) Home() string          { return h.home }

func (h *harness) Log() host.Logger {
	return func(level, message string, fields map[string]any) {
		h.mu.Lock()
		defer h.mu.Unlock()
		h.logs = append(h.logs, logLine{level, message, fields})
	}
}

func (h *harness) Rooms(_ context.Context, roomIDs []string) ([]host.RoomInfo, error) {
	if roomIDs == nil {
		h.t.Error("rooms were looked up with no list at all, where the TypeScript feed gave an empty one")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.lookups++
	if h.directoryDown {
		return nil, errors.New("the directory is down")
	}
	var rooms []host.RoomInfo
	for _, id := range roomIDs {
		if room, known := h.directory[id]; known {
			rooms = append(rooms, room)
		}
	}
	return rooms, nil
}

func (h *harness) SenderNames(context.Context, []string) (map[string]string, error) {
	return map[string]string{"@alice:example.test": "Alice"}, nil
}

// Tool is the directory refresh, the only inbox tool the feeds call.
func (h *harness) Tool(_ context.Context, name string, args map[string]any) (map[string]any, error) {
	if name != "list_conversations" || !reflect.DeepEqual(args, map[string]any{"refresh": true, "limit": 1}) {
		h.t.Errorf("unexpected tool call %s %v", name, args)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.refreshes++
	if h.refreshDown {
		return nil, errors.New("the refresh failed")
	}
	for _, room := range testRooms() {
		h.directory[room.RoomID] = room
	}
	return map[string]any{}, nil
}

func (h *harness) Connections(context.Context) ([]host.Connection, error) { return nil, errUnused }
func (h *harness) PublishLinearIssue(context.Context, string, map[string]any) error {
	return errUnused
}
func (h *harness) PublishProjectAppearance(context.Context, string, map[string]any) error {
	return errUnused
}
func (h *harness) PublishProjectVisibility(context.Context, map[string]any) error {
	return errUnused
}

// Slack.

func (h *harness) ensureChannel(_ context.Context, channel string, options channelOptions) (string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.destinations = append(h.destinations, slackDestination{channel, options.create})
	return channel, nil
}

func (h *harness) post(ctx context.Context, channel, text string) error {
	h.mu.Lock()
	hold := h.hold
	h.mu.Unlock()
	if hold != nil {
		<-hold
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.postContexts = append(h.postContexts, ctx.Err())
	if h.failures[channel] {
		return errors.New("temporary Slack failure")
	}
	h.posts = append(h.posts, slackPost{channel, text})
	return nil
}

// The screener: a message that starts with "spam:" or "unsafe:" is routed that way.

func (h *harness) screen(_ context.Context, input screenInput) (verdict, error) {
	text := input.messages[0].text
	h.mu.Lock()
	h.screened = append(h.screened, text)
	down := h.screenerDown
	h.mu.Unlock()
	if down {
		return verdict{}, errors.New("the screener is down")
	}
	switch leading, _, _ := strings.Cut(text, ":"); leading {
	case "spam":
		return verdict{Route: routeSpam, Reason: "promotion", By: "model", Wake: true}, nil
	case "unsafe":
		return verdict{Route: routeUnsafe, Reason: "prompt_injection", By: "model", Wake: true}, nil
	}
	return verdict{Route: routeSafe, Reason: "ok", By: "model", Wake: true}, nil
}
