package feeds

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/host"
)

const (
	// A message the screener can't check is tried again for this long, then held as flagged.
	screenRetryMS = 15 * 60_000
	// A pass that failed is run again after this long.
	cycleRetryMS = 5_000
	// A delivery is retried after 30 seconds, then twice as long each time, up to this.
	maxRetryMS = 10 * 60_000
	// A message that still isn't delivered after this long is dropped and counted as expired.
	retryLifetimeMS = 7 * 24 * 60 * 60_000
	// One pass reads at most this many journal changes and delivers at most this many messages.
	batchSize    = 100
	postsPerTick = 10
	// Unknown rooms cause at most one directory refresh in this long.
	directoryRefreshMS = 60_000
)

type feedOptions struct {
	// network is the Beeper network whose chats the feed copies: whatsapp, instagram…
	network string
	// roomIDs limits the feed to these rooms; nil copies every chat of the network.
	roomIDs  map[string]bool
	host     host.Host
	slack    slackPoster
	screener screener
	// flaggedChannel and spamChannel hold what the screener doesn't pass.
	flaggedChannel string
	spamChannel    string
	// invite is the Slack users added to the network's channel when the feed creates it.
	invite    []string
	stateFile string
	// now is the time in Unix milliseconds.
	now func() int64
	// after is time.After, the wait for the next pass. Tests step it by hand.
	after func(time.Duration) <-chan time.Time
}

// feed is a one-way consumer of the inbox journal. The cursor and pending messages commit together.
type feed struct {
	feedOptions
	log         host.Logger
	destination string
	// channels is the Slack channel IDs already looked up, forgotten when a delivery fails.
	channels             map[string]string
	nextDirectoryRefresh int64

	// mu guards what Status reads while a pass runs. Only passes write, one at a time.
	mu       sync.Mutex
	state    *state
	lastTick *int64
}

// newFeed opens a feed on its saved state. A feed without a state file starts at the journal head
// on its first pass.
func newFeed(options feedOptions) (*feed, error) {
	saved, err := loadState(options.stateFile)
	if err != nil {
		return nil, err
	}
	return &feed{
		feedOptions: options,
		log:         options.host.Log(),
		destination: "feed-" + options.network,
		channels:    map[string]string{},
		state:       saved,
	}, nil
}

// runningFeed is a started feed: a goroutine that runs passes until it is stopped.
type runningFeed struct {
	feed   *feed
	name   string
	failed atomic.Bool
	// quit is closed by Stop, ended when the daemon's context ends, done when the goroutine is gone.
	quit  chan struct{}
	ended <-chan struct{}
	done  chan struct{}
	once  sync.Once
}

// start runs a pass now, one after every journal change, and one whenever a retry comes due. The
// feed stays idle in between.
func (f *feed) start(ctx context.Context, name string) *runningFeed {
	running := &runningFeed{feed: f, name: name, quit: make(chan struct{}), ended: ctx.Done(), done: make(chan struct{})}
	wake := make(chan struct{}, 1)
	unsubscribe := f.host.Journal().Subscribe(func() {
		select {
		case wake <- struct{}{}:
		default:
		}
	})
	go func() {
		defer close(running.done)
		defer unsubscribe()
		// Stopping lets the delivery in flight finish instead of cutting it off, so a post Slack
		// has accepted is always recorded and never sent again after a restart.
		running.run(context.WithoutCancel(ctx), wake)
	}()
	return running
}

func (r *runningFeed) run(ctx context.Context, wake <-chan struct{}) {
	f := r.feed
	for !r.stopped() {
		// A change from before this pass is read by it.
		woken(wake)
		nextAt, due, err := f.tick(ctx, r.stopped)
		r.failed.Store(err != nil)
		changes := wake
		if err != nil {
			f.log("warn", "Slack feed cycle failed; will retry", nil)
			// A failed pass is run again by its timer only, however many changes arrive meanwhile.
			nextAt, due, changes = f.now()+cycleRetryMS, true, nil
		} else if woken(wake) {
			// A change can land while the journal page is being screened or posted.
			nextAt, due = f.now(), true
		}
		if r.stopped() {
			return
		}
		var timer <-chan time.Time
		if due {
			timer = f.after(time.Duration(max(0, nextAt-f.now())) * time.Millisecond)
		}
		select {
		case <-r.quit:
		case <-r.ended:
		case <-changes:
		case <-timer:
		}
	}
}

// woken reports whether a journal change arrived, and forgets it.
func woken(wake <-chan struct{}) bool {
	select {
	case <-wake:
		return true
	default:
		return false
	}
}

func (r *runningFeed) stopped() bool {
	select {
	case <-r.quit:
		return true
	case <-r.ended:
		return true
	default:
		return false
	}
}

func (r *runningFeed) Status() map[string]any {
	status := r.feed.status()
	status["running"] = !r.stopped()
	status["failed"] = r.failed.Load()
	return status
}

func (r *runningFeed) Stop() {
	r.once.Do(func() { close(r.quit) })
	<-r.done
}

func (r *runningFeed) CallTool(context.Context, string, map[string]any) (map[string]any, error) {
	return nil, noTools(r.name)
}

func (f *feed) status() map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	status := map[string]any{"start_at": nil, "last_tick_at": nil, "pending": 0, "posted": int64(0), "expired": int64(0)}
	if f.state != nil {
		status["start_at"] = isoTime(f.state.Since)
		status["pending"] = len(f.state.Pending.order)
		status["posted"] = f.state.Posted
		status["expired"] = f.state.Expired
	}
	if f.lastTick != nil {
		status["last_tick_at"] = isoTime(*f.lastTick)
	}
	return status
}

// isoTime writes a time the way JavaScript's toISOString does.
func isoTime(ms int64) string {
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z")
}

// tick runs one pass: it reads one page of journal changes into the pending messages, then screens
// and posts the pending messages that are due. It returns when the next pass is due (Unix ms);
// due is false when the feed can stay idle until the journal changes.
func (f *feed) tick(ctx context.Context, stopped func() bool) (nextAt int64, due bool, err error) {
	fullPage, err := f.collect(ctx)
	if err != nil {
		return 0, false, err
	}
	if err := f.deliver(ctx, stopped); err != nil {
		return 0, false, err
	}
	finished := f.now()
	f.mu.Lock()
	f.lastTick = &finished
	f.mu.Unlock()
	// A full page means there may be more to read.
	nextAt, due = finished, fullPage
	for _, item := range f.state.Pending.list() {
		if !due || item.RetryAt < nextAt {
			nextAt, due = item.RetryAt, true
		}
	}
	return nextAt, due, nil
}

// collect reads the next page of journal changes and queues the new messages of the feed's
// network. fullPage says the page was full, so more changes may be waiting.
func (f *feed) collect(ctx context.Context) (fullPage bool, err error) {
	journal := f.host.Journal()
	if f.state == nil {
		// A feed starts with new messages the first time it runs.
		since := f.now()
		cursor, err := journal.Head()
		if err != nil {
			return false, err
		}
		if err := f.commit(&state{Since: since, Cursor: cursor}); err != nil {
			return false, err
		}
	}
	current := f.state
	entries, cursor, err := journal.Changes(ctx, host.ChangesOptions{After: current.Cursor, Limit: batchSize})
	if err != nil {
		return false, err
	}
	fullPage = len(entries) == batchSize
	if cursor <= current.Cursor {
		return fullPage, nil
	}
	pending := current.Pending.clone()
	var candidates []host.JournalEntry
	for _, message := range entries {
		_, queued := pending.get(message.EventID)
		if message.Redacted {
			pending.remove(message.EventID)
			continue
		}
		// An edit is taken when its message is still pending, or is new itself. An edit of an older
		// message isn't: that message was posted, or passed over, when it arrived.
		if f.includesRoom(message.RoomID) && message.TS >= current.Since &&
			(queued || !message.Edited || message.Seq > current.Cursor) {
			candidates = append(candidates, message)
		}
	}
	rooms := map[string]host.RoomInfo{}
	if ids := roomIDs(candidates); len(ids) > 0 {
		known, err := f.host.Rooms(ctx, ids)
		if err != nil {
			return false, err
		}
		rooms = byRoomID(known)
	}
	for _, message := range candidates {
		// Keep unresolved rooms pending until their bridge metadata can be checked.
		if room, known := rooms[message.RoomID]; known && room.Network != f.network {
			continue
		}
		queuedAt := f.now()
		if previous, queued := pending.get(message.EventID); queued {
			queuedAt = previous.QueuedAt
		}
		message.Text = cut(message.Text, maxText)
		message.HTML = nil
		// Keep the current revision until it's posted. A newly decrypted event can have an older seq.
		pending.put(pendingMessage{Message: message, QueuedAt: queuedAt})
	}
	next := *current
	next.Cursor, next.Pending = cursor, pending
	return fullPage, f.commit(&next)
}

// deliver screens and posts the pending messages that are due, oldest first and at most
// postsPerTick of them. A message that can't be delivered yet stays pending with a later retry.
func (f *feed) deliver(ctx context.Context, stopped func() bool) error {
	now := f.now()
	var ready []pendingMessage
	for _, item := range f.state.Pending.list() {
		if item.RetryAt <= now && len(ready) < postsPerTick {
			ready = append(ready, item)
		}
	}
	if len(ready) == 0 || stopped() {
		return nil
	}
	var included []host.JournalEntry
	for _, item := range ready {
		if f.includesRoom(item.Message.RoomID) {
			included = append(included, item.Message)
		}
	}
	rooms, err := f.rooms(ctx, roomIDs(included))
	if err != nil {
		return err
	}
	var senderIDs []string
	for _, item := range ready {
		if room, known := rooms[item.Message.RoomID]; !item.Message.IsMe && known && room.Network == f.network {
			senderIDs = append(senderIDs, item.Message.Sender)
		}
	}
	senders := map[string]string{}
	if len(senderIDs) > 0 {
		if senders, err = f.host.SenderNames(ctx, senderIDs); err != nil {
			return err
		}
	}
	for _, item := range ready {
		if stopped() {
			break
		}
		message := item.Message
		room, known := rooms[message.RoomID]
		switch {
		case !f.includesRoom(message.RoomID) || (known && room.Network != f.network):
			// The settings no longer cover the room, or the room turned out to be another network's.
			err = f.finish(item, nil)
		case now-item.QueuedAt >= retryLifetimeMS:
			if err = f.finish(item, func(next *state) { next.Expired++ }); err == nil {
				f.log("warn", "message expired before Slack delivery", nil)
			}
		case !known:
			err = f.retry(item)
		default:
			sender := "Leon"
			if !message.IsMe {
				if sender = senders[message.Sender]; sender == "" {
					sender = message.Sender
				}
			}
			err = f.post(ctx, item, room, sender)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func (f *feed) includesRoom(id string) bool {
	return f.roomIDs == nil || f.roomIDs[id]
}

// roomIDs lists each room of the messages once, in the order they first appear.
func roomIDs(messages []host.JournalEntry) []string {
	ids := []string{}
	seen := map[string]bool{}
	for _, message := range messages {
		if !seen[message.RoomID] {
			seen[message.RoomID] = true
			ids = append(ids, message.RoomID)
		}
	}
	return ids
}

func byRoomID(rooms []host.RoomInfo) map[string]host.RoomInfo {
	byID := make(map[string]host.RoomInfo, len(rooms))
	for _, room := range rooms {
		byID[room.RoomID] = room
	}
	return byID
}

// rooms looks rooms up for delivery. When the inbox doesn't know one yet, such as a chat that has
// just begun, its directory is refreshed first, at most once a minute.
func (f *feed) rooms(ctx context.Context, ids []string) (map[string]host.RoomInfo, error) {
	rooms, err := f.host.Rooms(ctx, ids)
	if err != nil {
		return nil, err
	}
	if now := f.now(); len(rooms) < len(ids) && now >= f.nextDirectoryRefresh {
		f.nextDirectoryRefresh = now + directoryRefreshMS
		if refreshed, err := f.refreshedRooms(ctx, ids); err != nil {
			f.log("warn", "room directory refresh will retry", nil)
		} else {
			rooms = refreshed
		}
	}
	return byRoomID(rooms), nil
}

func (f *feed) refreshedRooms(ctx context.Context, ids []string) ([]host.RoomInfo, error) {
	if _, err := f.host.Tool(ctx, "list_conversations", map[string]any{"refresh": true, "limit": 1}); err != nil {
		return nil, err
	}
	return f.host.Rooms(ctx, ids)
}

// post screens a message unless it already has a verdict, then delivers it to the channel the
// verdict chooses.
func (f *feed) post(ctx context.Context, item pendingMessage, room host.RoomInfo, sender string) error {
	message := item.Message
	if item.Verdict == nil {
		kind := "room"
		if room.IsDirect {
			kind = "direct"
		}
		decided, err := f.screener.screen(ctx, screenInput{
			chat:     screenChat{title: roomName(room), network: room.Network, kind: kind},
			messages: []screenMessage{{from: sender, text: message.Text, kind: message.Type}},
		})
		if err != nil {
			if f.now()-item.QueuedAt < screenRetryMS {
				if err := f.retry(item); err != nil {
					return err
				}
				f.log("warn", "message screening will retry", nil)
				return nil
			}
			decided = failClosed
		}
		item.Verdict, item.Attempts, item.RetryAt = &decided, 0, 0
		if err := f.store(item); err != nil {
			return err
		}
	}

	decided := *item.Verdict
	destination, create := f.flaggedChannel, false
	switch decided.Route {
	case routeSafe:
		destination, create = f.destination, true
	case routeSpam:
		destination = f.spamChannel
	}
	if err := f.send(ctx, destination, create, room.Network, mirrorText(message, room, sender, decided)); err != nil {
		// The channel may be gone or renamed, so it is looked up again next time.
		delete(f.channels, destination)
		if err := f.retry(item); err != nil {
			return err
		}
		f.log("warn", "Slack delivery will retry", map[string]any{"route": decided.Route})
		return nil
	}
	return f.finish(item, func(next *state) { next.Posted++ })
}

// send posts text to a channel named by ID or name. Only a network's own channel is created when
// it is missing; the flagged and spam channels have to exist.
func (f *feed) send(ctx context.Context, destination string, create bool, network, text string) error {
	channel := f.channels[destination]
	if channel == "" {
		options := channelOptions{}
		if create {
			options = channelOptions{create: true, purpose: "Screened messages from Beeper · " + network, invite: f.invite}
		}
		id, err := f.slack.ensureChannel(ctx, destination, options)
		if err != nil {
			return err
		}
		channel = id
		f.channels[destination] = id
	}
	return f.slack.post(ctx, channel, text)
}

// retry leaves a message pending and sets when to try it again.
func (f *feed) retry(item pendingMessage) error {
	// 30 seconds, doubling with each attempt; the sixth is already past the longest wait.
	delay := min(maxRetryMS, int64(30_000)<<min(max(item.Attempts, 0), 5))
	item.Attempts++
	item.RetryAt = f.now() + delay
	return f.store(item)
}

func (f *feed) store(item pendingMessage) error {
	next := *f.state
	next.Pending = f.state.Pending.clone()
	next.Pending.put(item)
	return f.commit(&next)
}

// finish takes a message out of the pending ones; count, when given, adds it to a total.
func (f *feed) finish(item pendingMessage, count func(*state)) error {
	next := *f.state
	next.Pending = f.state.Pending.clone()
	next.Pending.remove(item.Message.EventID)
	if count != nil {
		count(&next)
	}
	return f.commit(&next)
}

// commit writes the state file first, so the feed never believes something the file doesn't hold.
func (f *feed) commit(next *state) error {
	if err := host.WriteJSONAtomic(f.stateFile, next); err != nil {
		return err
	}
	f.mu.Lock()
	f.state = next
	f.mu.Unlock()
	return nil
}
