package grokrelay

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/handoff"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/host"
)

// rosterBot is a bot as the Grok Bot admin service lists it.
type rosterBot struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	CreatedAt *string `json:"created_at"`
}

// slackReply is one reply in a task's Slack thread, as slack-puppet hands it over.
type slackReply struct {
	TS     string   `json:"ts"`
	From   string   `json:"from"`
	Author string   `json:"author"`
	UserID string   `json:"userId"`
	Text   string   `json:"text"`
	Files  []string `json:"files"`
}

type slackThreadPage struct {
	Channel string       `json:"channel"`
	Cursor  string       `json:"cursor"`
	Replies []slackReply `json:"replies"`
}

// mirrorPost is one Grok message to copy into a Slack thread.
type mirrorPost struct {
	Bot     string
	EventID string
	Text    string
	// RetrySince is set when an earlier try may have posted it: Slack is searched from that ts first.
	RetrySince string
	// SlackTS is set when the message is already in Slack and its text changed.
	SlackTS string
}

// slackService is the two calls the bridge makes to slack-puppet.
type slackService interface {
	// thread reads a thread's replies after a ts. With no ts it only checks that the thread exists
	// and returns its channel ID.
	thread(ctx context.Context, thread handoff.SlackThread, after string) (slackThreadPage, error)
	// mirror posts or edits a Grok message in the thread and returns its Slack ts.
	mirror(ctx context.Context, thread handoff.SlackThread, post mirrorPost) (ts string, err error)
}

// rosterService is the two calls the bridge makes to the Grok Bot admin service.
type rosterService interface {
	list(ctx context.Context) ([]rosterBot, error)
	remove(ctx context.Context, id string) error
}

type bridgeServices struct {
	slack  slackService
	roster rosterService
}

// mirrorState is how far one Grok message got on its way to Slack.
type mirrorState struct {
	Started string `json:"started"`
	TS      string `json:"ts,omitempty"`
	Digest  string `json:"digest,omitempty"`
}

// route ties one task bot's Beeper chat to its Slack thread, with a cursor for each direction.
type route struct {
	Name         string                  `json:"name"`
	ChatID       string                  `json:"chatID"`
	Thread       handoff.SlackThread     `json:"thread"`
	FromMS       int64                   `json:"fromMs"`
	BeeperCursor int64                   `json:"beeperCursor"`
	SlackCursor  string                  `json:"slackCursor"`
	Mirrors      map[string]*mirrorState `json:"mirrors"`
	Closing      bool                    `json:"closing,omitempty"`
}

// bridgeState is slack22grokbot.json: the routes by roster ID, and the chats of retired task bots.
type bridgeState struct {
	Started      int64             `json:"started"`
	JournalStart int64             `json:"journalStart"`
	Routes       map[string]*route `json:"routes"`
	Retired      []string          `json:"retired"`
}

type bridgeOptions struct {
	backend      backend
	journal      host.Journal
	services     bridgeServices
	stateFile    string
	hermesUserID string
	log          logFunc
	now          func() int64
}

// slackBridge is the single writer inside the daemon. The official Grok Bot connector delivers into
// the journal. Each active roster bot has independent cursors, so one broken thread cannot stall the
// others.
type slackBridge struct {
	bridgeOptions

	// work is held by the one cycle or completion that runs at a time.
	work                 sync.Mutex
	lastDirectoryRefresh int64

	// mu guards the fields below, and the routes they hold. It is never held across a call to
	// Slack, the admin service, Beeper or the journal.
	mu     sync.Mutex
	state  *bridgeState
	errors map[string]string
}

// slackTS writes a time in Unix milliseconds as a Slack ts.
func slackTS(ms int64) string {
	return strconv.FormatFloat(float64(ms)/1000, 'f', 6, 64)
}

func hash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

// messageText is what Slack shows for a Grok message: its text, or a line saying what it was.
func messageText(entry host.JournalEntry) string {
	if text := handoff.TrimSpace(entry.Text); text != "" {
		return text
	}
	if entry.Attachments != 0 {
		return "Sent an attachment in Grok Bot."
	}
	return "Sent a " + entry.Type + " message in Grok Bot."
}

// newBridge reads the saved routes. A missing state file is a first start; any other failure to
// read it is an error, so that progress is never silently thrown away.
func newBridge(options bridgeOptions) (*slackBridge, error) {
	b := &slackBridge{bridgeOptions: options, errors: map[string]string{}}
	data, err := os.ReadFile(options.stateFile)
	if errors.Is(err, os.ErrNotExist) {
		return b, nil
	}
	if err != nil {
		return nil, err
	}
	var state bridgeState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, err
	}
	if state.Routes == nil {
		state.Routes = map[string]*route{}
	}
	if state.Retired == nil {
		state.Retired = []string{}
	}
	for _, saved := range state.Routes {
		if saved.Mirrors == nil {
			saved.Mirrors = map[string]*mirrorState{}
		}
	}
	b.state = &state
	return b, nil
}

// update changes the state under the lock and saves it.
func (b *slackBridge) update(change func()) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	change()
	return host.WriteJSONAtomic(b.stateFile, b.state)
}

func (b *slackBridge) status() map[string]any {
	b.mu.Lock()
	defer b.mu.Unlock()
	active := 0
	if b.state != nil {
		active = len(b.state.Routes)
	}
	return map[string]any{"active": active, "errors": maps.Clone(b.errors)}
}

// hasNews reports whether the journal holds something from a task bot's chat that has not been
// copied to its Slack thread yet.
func (b *slackBridge) hasNews(ctx context.Context) bool {
	type position struct {
		chatID string
		after  int64
	}
	b.mu.Lock()
	var positions []position
	if b.state != nil {
		for _, served := range b.state.Routes {
			positions = append(positions, position{served.ChatID, served.BeeperCursor})
		}
	}
	b.mu.Unlock()
	for _, at := range positions {
		entries, _, err := b.journal.Changes(ctx, host.ChangesOptions{RoomID: at.chatID, After: at.after, Limit: 1})
		if err == nil && len(entries) > 0 {
			return true
		}
	}
	return false
}

func (b *slackBridge) retired(chatID string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.state != nil && slices.Contains(b.state.Retired, chatID)
}

// validate checks with Slack that the thread exists, and returns it with the channel's ID.
func (b *slackBridge) validate(ctx context.Context, thread handoff.SlackThread) (handoff.SlackThread, error) {
	root, err := b.services.slack.thread(ctx, thread, "")
	if err != nil {
		return handoff.SlackThread{}, err
	}
	thread.Channel = root.Channel
	return thread, nil
}

// initialize makes the state on the first start: routes begin from now, not from old messages.
func (b *slackBridge) initialize() error {
	b.mu.Lock()
	initialized := b.state != nil
	b.mu.Unlock()
	if initialized {
		return nil
	}
	head, err := b.journal.Head()
	if err != nil {
		return err
	}
	return b.update(func() {
		b.state = &bridgeState{Started: b.now(), JournalStart: head, Routes: map[string]*route{}, Retired: []string{}}
	})
}

// tick runs one cycle: it copies every route's new Grok messages to Slack and its new Slack replies
// to Grok, starts routes for new task bots, and retires routes whose bot is gone.
func (b *slackBridge) tick(ctx context.Context) error {
	b.work.Lock()
	defer b.work.Unlock()
	if err := b.initialize(); err != nil {
		return err
	}
	var (
		roster              []rosterBot
		rooms               []bot
		rosterErr, roomsErr error
		lists, running      sync.WaitGroup
	)
	lists.Go(func() { roster, rosterErr = b.services.roster.list(ctx) })
	lists.Go(func() { rooms, roomsErr = b.backend.bots(ctx, false) })
	lists.Wait()
	if rosterErr != nil {
		return rosterErr
	}
	if roomsErr != nil {
		return roomsErr
	}

	b.mu.Lock()
	previous := b.errors
	b.mu.Unlock()
	failures := map[string]string{}
	var failuresMu sync.Mutex
	record := func(name string, err error) {
		failuresMu.Lock()
		defer failuresMu.Unlock()
		failures[name] = err.Error()
		// A daemon that is stopping fails every call it had open; that is not news.
		if previous[name] != err.Error() && ctx.Err() == nil {
			b.log("slack22grokbot_route_error", map[string]any{"bot": name, "message": err.Error()})
		}
	}

	present := map[string]bool{}
	sameName := map[string]int{}
	var active []rosterBot
	gone := map[string]*route{}
	b.mu.Lock()
	for _, listed := range roster {
		present[listed.ID] = true
		if _, named := handoff.ParseTaskName(listed.Name); named || b.state.Routes[listed.ID] != nil {
			active = append(active, listed)
			sameName[listed.Name]++
		}
	}
	for id, saved := range b.state.Routes {
		if !present[id] {
			gone[id] = saved
		}
	}
	b.mu.Unlock()

	now := b.now()
	unlisted := slices.ContainsFunc(active, func(listed rosterBot) bool {
		return !slices.ContainsFunc(rooms, func(room bot) bool { return room.Name == listed.Name })
	})
	if unlisted && now-b.lastDirectoryRefresh >= 60_000 {
		b.lastDirectoryRefresh = now
		refreshed, err := b.backend.bots(ctx, true)
		if err != nil {
			return err
		}
		rooms = refreshed
	}
	roomsByName := map[string][]bot{}
	for _, room := range rooms {
		roomsByName[room.Name] = append(roomsByName[room.Name], room)
	}

	// Keep progress for every route when one endpoint is unavailable.
	for id, saved := range gone {
		running.Go(func() {
			more, err := b.mirror(ctx, saved)
			if err == nil && !more {
				err = b.update(func() {
					b.state.Retired = append(b.state.Retired, saved.ChatID)
					delete(b.state.Routes, id)
				})
			}
			if err != nil {
				record(saved.Name, err)
			}
		})
	}
	for _, listed := range active {
		running.Go(func() {
			if err := b.serve(ctx, listed, roomsByName[listed.Name], sameName[listed.Name]); err != nil {
				record(listed.Name, err)
			}
		})
	}
	running.Wait()
	b.mu.Lock()
	b.errors = failures
	b.mu.Unlock()
	return nil
}

// serve handles one task bot of the roster for a cycle. rooms are the Beeper chats with its name,
// and sameName is how many task bots carry it.
func (b *slackBridge) serve(ctx context.Context, listed rosterBot, rooms []bot, sameName int) error {
	b.mu.Lock()
	existing := b.state.Routes[listed.ID]
	closing := existing != nil && existing.Closing
	b.mu.Unlock()
	if closing {
		return b.close(ctx, listed, existing)
	}
	if len(rooms) > 1 || sameName != 1 {
		return errors.New("Multiple Grok bots or Beeper conversations use this task name")
	}
	if len(rooms) == 0 {
		if existing != nil {
			return errors.New("The Grok conversation is missing from Beeper")
		}
		return nil
	}
	if existing != nil && (existing.ChatID != rooms[0].ChatID || existing.Name != listed.Name) {
		return errors.New("The Grok task bot or its Beeper room changed after routing was established")
	}
	served := existing
	if served == nil {
		registered, err := b.register(ctx, listed, rooms[0].ChatID)
		if err != nil {
			return err
		}
		served = registered
	}
	// Each direction keeps going when the other fails.
	var (
		mirrorErr, forwardErr error
		directions            sync.WaitGroup
	)
	directions.Go(func() { _, mirrorErr = b.mirror(ctx, served) })
	directions.Go(func() { forwardErr = b.forward(ctx, served) })
	directions.Wait()
	if mirrorErr != nil {
		return mirrorErr
	}
	return forwardErr
}

func (b *slackBridge) register(ctx context.Context, listed rosterBot, chatID string) (*route, error) {
	named, ok := handoff.ParseTaskName(listed.Name)
	if !ok {
		return nil, errors.New("The Grok bot does not name a Slack task thread")
	}
	thread, err := b.validate(ctx, named)
	if err != nil {
		return nil, err
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, other := range b.state.Routes {
		if other.Thread == thread {
			return nil, errors.New("Another Grok bot already routes to this Slack thread")
		}
	}
	// Nothing from before the bridge started, or from before the bot existed, is copied.
	fromMS := b.state.Started
	if listed.CreatedAt != nil {
		if created := parseTime(*listed.CreatedAt); created > float64(fromMS) {
			fromMS = int64(created)
		}
	}
	registered := &route{
		Name:         listed.Name,
		ChatID:       chatID,
		Thread:       thread,
		FromMS:       fromMS,
		BeeperCursor: b.state.JournalStart,
		SlackCursor:  max(slackTS(fromMS), thread.ThreadTS),
		Mirrors:      map[string]*mirrorState{},
	}
	b.state.Routes[listed.ID] = registered
	if err := host.WriteJSONAtomic(b.stateFile, b.state); err != nil {
		return nil, err
	}
	return registered, nil
}

// mirror copies a route's new and edited Grok messages to its Slack thread. more is true when the
// journal may hold more of them than this page.
func (b *slackBridge) mirror(ctx context.Context, served *route) (more bool, err error) {
	const page = 50
	b.mu.Lock()
	after := served.BeeperCursor
	b.mu.Unlock()
	entries, _, err := b.journal.Changes(ctx, host.ChangesOptions{RoomID: served.ChatID, After: after, Limit: page})
	if err != nil {
		return false, err
	}
	for _, entry := range entries {
		if !entry.IsMe && !entry.Redacted && entry.TS >= served.FromMS {
			if err := b.copyToSlack(ctx, served, entry); err != nil {
				return false, err
			}
		}
		if err := b.update(func() { served.BeeperCursor = entry.Rev }); err != nil {
			return false, err
		}
	}
	return len(entries) == page, nil
}

// copyToSlack posts one Grok message in the thread, or edits its copy when its text changed. The
// try is written down before it is made, so one whose answer was lost is found again in Slack
// instead of being posted twice.
func (b *slackBridge) copyToSlack(ctx context.Context, served *route, entry host.JournalEntry) error {
	text := messageText(entry)
	digest := hash(text)
	post := mirrorPost{Bot: served.Name, EventID: entry.EventID, Text: text}
	b.mu.Lock()
	delivery := served.Mirrors[entry.EventID]
	switch {
	case delivery == nil:
		delivery = &mirrorState{Started: slackTS(b.now() - 60_000)}
		served.Mirrors[entry.EventID] = delivery
	case delivery.Digest == digest:
		b.mu.Unlock()
		return nil
	case delivery.TS != "":
		post.SlackTS = delivery.TS
	default:
		post.RetrySince = delivery.Started
	}
	err := host.WriteJSONAtomic(b.stateFile, b.state)
	b.mu.Unlock()
	if err != nil {
		return err
	}
	ts, err := b.services.slack.mirror(ctx, served.Thread, post)
	if err != nil {
		return err
	}
	// Saved with the cursor, right after this.
	b.mu.Lock()
	delivery.TS, delivery.Digest = ts, digest
	b.mu.Unlock()
	return nil
}

// grokAddress is how Hermes and the peers address the task bot in the shared thread ("To Grok Bot:",
// the prefix hermes22muse routes to the thread).
const grokAddress = "to grok bot:"

// withoutGrokAddress drops a leading "To Grok Bot:": in the bot's own chat it addresses no one new.
func withoutGrokAddress(text string) string {
	rest := strings.TrimLeftFunc(text, handoff.IsSpace)
	if len(rest) < len(grokAddress) || !strings.EqualFold(rest[:len(grokAddress)], grokAddress) {
		return text
	}
	return strings.TrimLeftFunc(rest[len(grokAddress):], handoff.IsSpace)
}

// forward sends a route's new Slack replies to the task bot's chat. Hermes writes to the bot for
// Leon (his rule, 2026-11-27), so its replies go out like Leon's own: as his messages, with no label
// and no "To Grok Bot:". Everyone else's start with their name, so the bot can tell peer input from
// Leon's directions.
func (b *slackBridge) forward(ctx context.Context, served *route) error {
	b.mu.Lock()
	after := served.SlackCursor
	b.mu.Unlock()
	page, err := b.services.slack.thread(ctx, served.Thread, after)
	if err != nil {
		return err
	}
	for _, reply := range page.Replies {
		var label string
		text := reply.Text
		switch {
		case reply.From == "hermes" || (b.hermesUserID != "" && reply.UserID == b.hermesUserID), reply.From == "leon":
			text = withoutGrokAddress(text)
		case reply.From == "codex":
			label = "Slack reply from Codex (collaborator):\n"
		default:
			label = "Slack reply from " + strings.Join(strings.FieldsFunc(reply.Author, handoff.IsSpace), " ") + " (other Slack participant):\n"
		}
		lines := []string{}
		if text != "" {
			lines = append(lines, text)
		}
		for _, file := range reply.Files {
			lines = append(lines, "Slack attachment: "+file)
		}
		if text := strings.Join(lines, "\n"); handoff.TrimSpace(text) != "" {
			key := hash(served.Thread.Channel + "/" + reply.TS)[:40]
			// The matrix send ledger deduplicates the same Slack message after a timeout or restart.
			const size = 8000
			for index, part := range chunks(text, size) {
				sendKey := fmt.Sprintf("slack22grokbot-%s-%d", key, index*size)
				if _, err := b.backend.send(ctx, served.ChatID, label+part, sendKey); err != nil {
					return err
				}
			}
		}
		if err := b.update(func() { served.SlackCursor = reply.TS }); err != nil {
			return err
		}
	}
	return b.update(func() { served.SlackCursor = page.Cursor })
}

// close delivers what Grok still has for Slack, then deletes the task bot and retires its chat.
func (b *slackBridge) close(ctx context.Context, listed rosterBot, served *route) error {
	if served.Name != listed.Name {
		return errors.New("The Grok task bot was renamed before cleanup")
	}
	if _, err := b.mirror(ctx, served); err != nil {
		return err
	}
	b.mu.Lock()
	after := served.BeeperCursor
	b.mu.Unlock()
	pending, _, err := b.journal.Changes(ctx, host.ChangesOptions{RoomID: served.ChatID, After: after, Limit: 1})
	if err != nil {
		return err
	}
	if len(pending) > 0 {
		return errors.New("Still copying Grok messages to Slack before cleanup")
	}
	if err := b.services.roster.remove(ctx, listed.ID); err != nil {
		return err
	}
	err = b.update(func() {
		b.state.Retired = append(b.state.Retired, served.ChatID)
		delete(b.state.Routes, listed.ID)
	})
	if err != nil {
		return err
	}
	b.log("slack22grokbot_task_closed", map[string]any{"bot": listed.Name, "id": listed.ID})
	return nil
}

// complete retires the task bot of a Slack thread, once Hermes has reviewed its final result.
func (b *slackBridge) complete(ctx context.Context, thread handoff.SlackThread) (map[string]any, error) {
	b.work.Lock()
	defer b.work.Unlock()
	if err := b.initialize(); err != nil {
		return nil, err
	}
	target, err := b.validate(ctx, thread)
	if err != nil {
		return nil, err
	}
	roster, err := b.services.roster.list(ctx)
	if err != nil {
		return nil, err
	}
	var matches []rosterBot
	b.mu.Lock()
	for _, listed := range roster {
		saved := b.state.Routes[listed.ID]
		if listed.Name == handoff.TaskName(target) || (saved != nil && saved.Thread == target) {
			matches = append(matches, listed)
		}
	}
	b.mu.Unlock()
	if len(matches) == 0 {
		return map[string]any{"ok": true, "already_closed": true}, nil
	}
	if len(matches) > 1 {
		return nil, errors.New("More than one Grok bot names this Slack thread")
	}
	listed := matches[0]
	b.mu.Lock()
	served := b.state.Routes[listed.ID]
	b.mu.Unlock()
	if served == nil {
		rooms, err := b.backend.bots(ctx, true)
		if err != nil {
			return nil, err
		}
		rooms = slices.DeleteFunc(rooms, func(room bot) bool { return room.Name != listed.Name })
		if len(rooms) != 1 {
			return nil, errors.New("Cannot find the Grok task's unique Beeper conversation")
		}
		if served, err = b.register(ctx, listed, rooms[0].ChatID); err != nil {
			return nil, err
		}
	}
	if err := b.update(func() { served.Closing = true }); err != nil {
		return nil, err
	}
	if err := b.close(ctx, listed, served); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "deleted": listed.Name}, nil
}
