package grokrelay

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/handoff"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/host"
)

// The relay queues handoffs for busy Grok bots and applies Hermes's hourly send budget.

const (
	// keepSent is how many message IDs are remembered as Hermes's.
	keepSent = 2000
	maxText  = 8000
	// maxWaitSeconds stays under Hermes Cloud's 180 s MCP timeout.
	maxWaitSeconds = 150
	// quietAfterReply: after a reply, wait this long for follow-up messages.
	quietAfterReply = 20 * time.Second
	flushEvery      = 10 * time.Second
	// clockSlackMS is how far the homeserver's clock may run behind this machine's when telling a
	// reply from the past.
	clockSlackMS = 60_000
	pollEvery    = 3 * time.Second
	// busyHistory is how much history busy reads while the journal is too young to answer.
	busyHistory = 10
	queuedNote  = "Queued: it will go out merged with any other queued messages as one message when the bot finishes its current reply. Read replies later with grok_bot_read. Do not resend."
	unavailable = "slack22grokbot is unavailable on this Beeper inbox"
)

// A cursor is a sort key: at least 13 digits of time, a colon, and an event ID on one line.
var cursorPattern = regexp.MustCompile(`^\d{13,}:[^\n\r\x{2028}\x{2029}]+$`)

// logFunc records one event of the relay: bot names, counts and reasons, never message text.
type logFunc func(event string, fields map[string]any)

// taskBridge is what the relay needs of the Slack bridge (bridge.go).
type taskBridge interface {
	validate(ctx context.Context, thread handoff.SlackThread) (handoff.SlackThread, error)
	complete(ctx context.Context, thread handoff.SlackThread) (map[string]any, error)
	retired(chatID string) bool
}

type relayOptions struct {
	// stateDir holds hermes-sent.json, outbox.json and budget.json; one process at a time.
	stateDir string
	backend  backend
	log      logFunc
	// poll is the time between checks while waiting for a reply, for a backend with no journal
	// (default 3 s).
	poll time.Duration
	// quiet is how long after a reply to keep waiting for more of it (default 20 s).
	quiet time.Duration
	// bridge is nil while the Slack bridge has no settings: reads still work, handoffs are refused.
	bridge taskBridge
	// upkeep returns text to put before each outgoing message, e.g. the Grok box setup while the box
	// is down (box.go).
	upkeep func(ctx context.Context) (string, error)
	// now is the clock, in Unix milliseconds (default: the system's).
	now func() int64
}

type sentEntry struct {
	ChatID string `json:"chatID"`
	ID     string `json:"id"`
	At     string `json:"at"`
}

// queueBox is the messages waiting for one busy bot.
type queueBox struct {
	Bot   string       `json:"bot"`
	Items []queuedItem `json:"items"`
}

type relay struct {
	relayOptions
	sentFile   string
	outboxFile string
	budgetFile string

	// mu guards the fields below. It is never held across a call to Beeper, Slack or the journal.
	mu sync.Mutex
	// sentLog is the chat and message ID of everything Hermes sent, so reads can tell Hermes from
	// Leon.
	sentLog []sentEntry
	sentIDs map[string]bool
	// outbox is the messages waiting for busy bots, sent merged by the flusher.
	outbox map[string]*queueBox
	budget budgetState

	// flushing is held by the one flush that runs at a time.
	flushing    sync.Mutex
	flusher     sync.WaitGroup
	stopFlusher context.CancelFunc
}

// readJSON reads a state file, or returns fallback when it is missing or unreadable.
func readJSON[T any](path string, fallback T) T {
	data, err := os.ReadFile(path)
	if err != nil {
		return fallback
	}
	var value T
	if err := json.Unmarshal(data, &value); err != nil {
		return fallback
	}
	return value
}

func newRelay(options relayOptions) *relay {
	if options.poll == 0 {
		options.poll = pollEvery
	}
	if options.quiet == 0 {
		options.quiet = quietAfterReply
	}
	if options.now == nil {
		options.now = func() int64 { return time.Now().UnixMilli() }
	}
	r := &relay{
		relayOptions: options,
		sentFile:     filepath.Join(options.stateDir, "hermes-sent.json"),
		outboxFile:   filepath.Join(options.stateDir, "outbox.json"),
		budgetFile:   filepath.Join(options.stateDir, "budget.json"),
		sentIDs:      map[string]bool{},
	}
	r.sentLog = readJSON(r.sentFile, []sentEntry{})
	for _, entry := range r.sentLog {
		r.sentIDs[entry.ChatID+" "+entry.ID] = true
	}
	r.outbox = readJSON(r.outboxFile, map[string]*queueBox{})
	if r.outbox == nil {
		r.outbox = map[string]*queueBox{}
	}
	// An item from before tasks carried their Slack thread can't be handed off.
	for chatID, box := range r.outbox {
		if box != nil {
			box.Items = slices.DeleteFunc(box.Items, func(item queuedItem) bool {
				return item.Thread.Channel == "" || item.Thread.ThreadTS == ""
			})
		}
		if box == nil || len(box.Items) == 0 {
			delete(r.outbox, chatID)
		}
	}
	r.budget = pruneBudget(readJSON(r.budgetFile, budgetState{}), r.now())
	return r
}

// startFlusher runs the background flusher until ctx ends or stop is called: when a bot with queued
// messages goes idle, or the queue is 20 minutes old, it sends them as one.
func (r *relay) startFlusher(ctx context.Context) {
	ctx, r.stopFlusher = context.WithCancel(ctx)
	r.flusher.Go(func() {
		ticker := time.NewTicker(flushEvery)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				r.mu.Lock()
				waiting := len(r.outbox) > 0
				r.mu.Unlock()
				if waiting {
					r.flushOnce(ctx, nil)
				}
			}
		}
	})
}

// stop ends the flusher and waits for it.
func (r *relay) stop() {
	if r.stopFlusher != nil {
		r.stopFlusher()
	}
	r.flusher.Wait()
}

// remember notes a message ID as Hermes's. The caller holds mu.
func (r *relay) remember(chatID, id, at string) error {
	key := chatID + " " + id
	if r.sentIDs[key] {
		return nil
	}
	r.sentIDs[key] = true
	r.sentLog = append(r.sentLog, sentEntry{ChatID: chatID, ID: id, At: at})
	if len(r.sentLog) > keepSent {
		r.sentLog = slices.Clone(r.sentLog[len(r.sentLog)-keepSent:])
	}
	return host.WriteJSONAtomic(r.sentFile, r.sentLog)
}

// listedBot is a bot as grok_bots lists it, with how many messages wait for it.
type listedBot struct {
	bot
	Queued int `json:"queued,omitempty"`
}

func (r *relay) bots(ctx context.Context, refresh bool) ([]listedBot, error) {
	all, err := r.backend.bots(ctx, refresh)
	if err != nil {
		return nil, err
	}
	listed := []listedBot{}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, found := range all {
		if r.bridge != nil && r.bridge.retired(found.ChatID) {
			continue
		}
		waiting := 0
		if box := r.outbox[found.ChatID]; box != nil {
			waiting = len(box.Items)
		}
		listed = append(listed, listedBot{bot: found, Queued: waiting})
	}
	return listed, nil
}

// match finds the bot Hermes means: by its whole name, by its name without " bot", or by a part of
// the name that only one bot has.
func match(all []listedBot, want string) *bot {
	var partial []*bot
	for index := range all {
		if strings.Contains(strings.ToLower(all[index].Name), want) {
			partial = append(partial, &all[index].bot)
		}
	}
	for _, name := range []string{want, want + " bot"} {
		for index := range all {
			if strings.ToLower(all[index].Name) == name {
				return &all[index].bot
			}
		}
	}
	if len(partial) == 1 {
		return partial[0]
	}
	return nil
}

func (r *relay) resolve(ctx context.Context, name any) (bot, error) {
	given, _ := name.(string)
	want := strings.ToLower(handoff.TrimSpace(given))
	if want == "" {
		return bot{}, errors.New(`bot is required, e.g. "University Bot"`)
	}
	all, err := r.bots(ctx, false)
	if err != nil {
		return bot{}, err
	}
	found := match(all, want)
	if found == nil {
		// A bot created or renamed since the list was built.
		if all, err = r.bots(ctx, true); err != nil {
			return bot{}, err
		}
		found = match(all, want)
	}
	if found == nil {
		names := make([]string, len(all))
		for index, listed := range all {
			names[index] = listed.Name
		}
		return bot{}, fmt.Errorf(`No Grok bot called "%s". Available: %s`, given, strings.Join(names, ", "))
	}
	return *found, nil
}

// ordered drops deleted messages and sorts the rest oldest first.
func ordered(list []message) []message {
	kept := make([]message, 0, len(list))
	for _, entry := range list {
		if !entry.IsDeleted {
			kept = append(kept, entry)
		}
	}
	slices.SortStableFunc(kept, bySortKey)
	return kept
}

// messages reads one page of history: the slow way, for when the journal doesn't reach back far
// enough.
func (r *relay) messages(ctx context.Context, chatID string, wanted int) ([]message, error) {
	found, err := r.backend.messages(ctx, chatID, wanted)
	if err != nil {
		return nil, err
	}
	return ordered(found), nil
}

// recent is what busy needs of a chat: its last busyWindowMS from the journal once the journal
// covers that, and a page of history until then.
func (r *relay) recent(ctx context.Context, chatID string, now int64) (list []message, windowed bool, err error) {
	from := now - busyWindowMS
	if journal := r.backend.live(); journal != nil {
		covered, err := journal.coveredSince()
		if err != nil {
			return nil, false, err
		}
		if covered <= from {
			found, err := journal.since(chatID, from)
			if err != nil {
				return nil, false, err
			}
			return ordered(found), true, nil
		}
	}
	list, err = r.messages(ctx, chatID, busyHistory)
	return list, false, err
}

// shapedMessage is a message as Hermes reads it.
type shapedMessage struct {
	From      string `json:"from"`
	Text      string `json:"text"`
	Timestamp string `json:"timestamp"`
	SortKey   string `json:"sortKey"`
	Type      string `json:"type,omitempty"`
}

func (r *relay) shape(list []message, botName string) []shapedMessage {
	shaped := make([]shapedMessage, len(list))
	r.mu.Lock()
	defer r.mu.Unlock()
	for index, entry := range list {
		from := botName
		if entry.IsSender {
			from = "Leon"
			if r.sentIDs[entry.ChatID+" "+entry.ID] {
				from = "Hermes (as Leon)"
			}
		}
		shaped[index] = shapedMessage{From: from, Text: entry.Text, Timestamp: entry.Timestamp, SortKey: entry.SortKey, Type: entry.Type}
	}
	return shaped
}

// post posts one message, counts it against the budget, and remembers its ID as Hermes's.
func (r *relay) post(ctx context.Context, chatID, text, key string, urgent bool) (string, error) {
	id, err := r.backend.send(ctx, chatID, text, key)
	if err != nil {
		return "", err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	r.budget = recordSend(r.budget, now, urgent)
	if err := host.WriteJSONAtomic(r.budgetFile, r.budget); err != nil {
		return "", err
	}
	if err := r.remember(chatID, id, isoTime(now)); err != nil {
		return "", err
	}
	return id, nil
}

// withUpkeep is a message with the upkeep text, if any, before it. Upkeep never stops a message
// going out.
func (r *relay) withUpkeep(ctx context.Context, text string) string {
	if r.upkeep == nil {
		return text
	}
	before, err := r.upkeep(ctx)
	if err != nil || before == "" {
		return text
	}
	return before + "\n\n" + text
}

func (r *relay) budgetNow() budgetReport {
	r.mu.Lock()
	defer r.mu.Unlock()
	return budgetStatus(r.budget, r.now())
}

// budgetFor is the budget a send is judged by. approval is Leon's own words allowing more, when
// Hermes passes them: they extend a budget that is used up.
func (r *relay) budgetFor(approval any) (status budgetReport, extended bool, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if approval != nil && approval != "" {
		var state budgetState
		if state, extended, err = extendBudget(r.budget, approval, r.now()); err != nil {
			return budgetReport{}, false, err
		}
		r.budget = state
		if err := host.WriteJSONAtomic(r.budgetFile, r.budget); err != nil {
			return budgetReport{}, false, err
		}
	}
	return budgetStatus(r.budget, r.now()), extended, nil
}

// direct sends one message to a bot with no Slack task, e.g. a Grok box repair. It is refused while
// the bot is busy.
func (r *relay) direct(ctx context.Context, name, text string) error {
	target, err := r.resolve(ctx, name)
	if err != nil {
		return err
	}
	list, windowed, err := r.recent(ctx, target.ChatID, r.now())
	if err != nil {
		return err
	}
	if state := busy(list, r.now(), windowed); state.busy {
		return fmt.Errorf("%s is busy: %s", target.Name, state.reason)
	}
	if r.budgetNow().remaining <= 0 {
		return errors.New("the hourly Grok budget is used up")
	}
	if _, err := r.post(ctx, target.ChatID, text, "direct-"+newUUID(), false); err != nil {
		return err
	}
	r.log("grok_direct", map[string]any{"bot": target.Name, "chars": utf16Len(text)})
	return nil
}

// queuedPreview is a queued message as grok_bot_read shows it.
type queuedPreview struct {
	Preview string `json:"preview"`
	// AgeSeconds is nil when the item's time can't be read.
	AgeSeconds *int64 `json:"ageSeconds"`
}

func (r *relay) queued(chatID string) []queuedPreview {
	r.mu.Lock()
	defer r.mu.Unlock()
	box := r.outbox[chatID]
	if box == nil {
		return nil
	}
	now := r.now()
	previews := make([]queuedPreview, len(box.Items))
	for index, item := range box.Items {
		previews[index].Preview = utf16Prefix(item.Text, 160)
		if age := jsRound((float64(now) - parseTime(item.At)) / 1000); !math.IsNaN(age) {
			whole := int64(age)
			previews[index].AgeSeconds = &whole
		}
	}
	return previews
}

// sentReceipt says what went out, in grok_bot_send's answer.
type sentReceipt struct {
	MessageID string  `json:"messageID"`
	SentAs    string  `json:"sentAs"`
	Label     *string `json:"label"`
}

type budgetUse struct {
	Used  int `json:"used"`
	Limit int `json:"limit"`
}

// replies holds the bot's messages seen while waiting, in the order they first arrived.
type replies []message

func (seen replies) find(id string) int {
	return slices.IndexFunc(seen, func(entry message) bool { return entry.ID == id })
}

func (seen *replies) set(entry message) {
	if index := seen.find(entry.ID); index >= 0 {
		(*seen)[index] = entry
		return
	}
	*seen = append(*seen, entry)
}

func (seen *replies) remove(id string) {
	if index := seen.find(id); index >= 0 {
		*seen = slices.Delete(*seen, index, index+1)
	}
}

// sleep waits for a time, or returns false when ctx ends first.
func sleep(ctx context.Context, wait time.Duration) bool {
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func (r *relay) send(ctx context.Context, args map[string]any) (map[string]any, error) {
	text, _ := args["text"].(string)
	if handoff.TrimSpace(text) == "" {
		return nil, errors.New("text is required")
	}
	if utf16Len(text) > maxText {
		return nil, fmt.Errorf("text must be under %d characters", maxText)
	}
	wait := 90.0
	if value, set := args["wait_seconds"]; set {
		wait = jsNumber(value)
	}
	if math.IsNaN(wait) || wait < 0 || wait > maxWaitSeconds {
		return nil, fmt.Errorf("wait_seconds must be 0-%d", maxWaitSeconds)
	}
	urgent := args["urgent"] == true
	// Every task carries its Slack thread, and the bot makes a task bot that works there with
	// Hermes; the instructions for that go after Hermes's own text (see the handoff package).
	requested, err := handoff.ParseThread(args["slack_channel"], args["slack_thread_ts"])
	if err != nil {
		return nil, err
	}
	if r.bridge == nil {
		return nil, errors.New(unavailable)
	}
	thread, err := r.bridge.validate(ctx, requested)
	if err != nil {
		return nil, err
	}

	asked, err := r.resolve(ctx, args["bot"])
	if err != nil {
		return nil, err
	}
	why, err := guardBot(asked.Name, args["needs_bot_because"])
	if err != nil {
		return nil, err
	}
	if why != "" {
		r.log("grok_bot_justified", map[string]any{"bot": asked.Name, "reason": utf16Prefix(why, 300)})
	}
	// The complete Slack route is the identity, including the channel.
	all, err := r.bots(ctx, false)
	if err != nil {
		return nil, err
	}
	taskBot := handoff.TaskName(thread)
	target, followUp := asked, false
	if index := slices.IndexFunc(all, func(listed listedBot) bool { return listed.Name == taskBot }); index >= 0 {
		target, followUp = all[index].bot, true
	} else if strings.HasPrefix(asked.Name, "Task slack:") {
		return nil, errors.New("This Grok task bot belongs to a different Slack thread")
	}
	redirected := target.ChatID != asked.ChatID
	if redirected {
		r.log("grok_task_bot_reused", map[string]any{"asked": asked.Name, "bot": target.Name})
	}
	item := queuedItem{Text: handoff.TrimSpace(text), At: isoTime(r.now()), Thread: thread, FollowUp: followUp}
	answer := func(fields map[string]any) map[string]any {
		fields["ok"] = true
		fields["bot"] = target.Name
		fields["slack_identifier"] = handoff.Identifier(thread)
		fields["task_bot"] = taskBot
		if redirected {
			fields["redirected_from"] = asked.Name
		}
		return fields
	}

	status, extended, err := r.budgetFor(args["leon_approved_more"])
	if err != nil {
		return nil, err
	}
	if extended {
		quote, _ := args["leon_approved_more"].(string)
		r.log("budget_extended", map[string]any{"bot": target.Name, "quote": utf16Prefix(quote, 300)})
	}
	if status.remaining <= 0 && !(urgent && status.urgentOver < urgentOverBudget) {
		r.log("budget_refused", map[string]any{
			"bot":   target.Name,
			"used":  status.used,
			"limit": status.limit,
			"chars": utf16Len(text),
		})
		return nil, errors.New(budgetExceededMessage(status, target.Name, text))
	}

	before, windowed, err := r.recent(ctx, target.ChatID, r.now())
	if err != nil {
		return nil, err
	}
	var baseline any
	if len(before) > 0 {
		baseline = before[len(before)-1].SortKey
	}
	state := busy(before, r.now(), windowed)
	r.mu.Lock()
	box := r.outbox[target.ChatID]
	pending := 0
	if box != nil {
		pending = len(box.Items)
	}
	if !urgent && (state.busy || pending > 0) {
		if box == nil {
			box = &queueBox{Bot: target.Name}
			r.outbox[target.ChatID] = box
		}
		box.Items = append(box.Items, item)
		position := len(box.Items)
		err := host.WriteJSONAtomic(r.outboxFile, r.outbox)
		r.mu.Unlock()
		if err != nil {
			return nil, err
		}
		reason := state.reason
		if pending > 0 {
			reason = strconv.Itoa(pending) + " earlier message(s) are already queued for this bot"
		}
		r.log("grok_queued", map[string]any{
			"bot":      target.Name,
			"position": position,
			"chars":    utf16Len(text),
			"reason":   reason,
		})
		return answer(map[string]any{
			"queued":   true,
			"position": position,
			"reason":   reason,
			"cursor":   baseline,
			"note":     queuedNote,
		}), nil
	}
	r.mu.Unlock()

	// Taken before the send, so nothing that arrives while it is on its way is missed.
	journal := r.backend.live()
	var position int64
	if journal != nil {
		if position, err = journal.cursor(); err != nil {
			return nil, err
		}
	}
	sentAt := r.now()
	messageID, err := r.post(ctx, target.ChatID, r.withUpkeep(ctx, compose([]queuedItem{item})), "send-"+newUUID(), urgent)
	if err != nil {
		return nil, err
	}
	sent := map[string]any{"bot": target.Name, "chars": utf16Len(text)}
	if urgent {
		sent["urgent"] = true
	}
	r.log("grok_send", sent)

	// A reply can arrive as one message that the bot keeps editing, so a changed text counts as
	// activity too, and the texts returned are the ones of the last look.
	var seen replies
	deadline := float64(r.now()) + wait*1000
	quietUntil := math.Inf(1)
	left := func() time.Duration {
		return time.Duration((math.Min(deadline, quietUntil) - float64(r.now())) * float64(time.Millisecond))
	}
	heard := func() {
		quietUntil = float64(r.now()) + float64(r.quiet.Milliseconds())
	}
	if journal != nil {
		// The journal answers the moment something arrives, so there is nothing to poll. It also
		// answers at once when ctx ends, which ends the wait with what has been seen.
		cursor := position
		for timeLeft := left(); timeLeft > 0 && ctx.Err() == nil; timeLeft = left() {
			arrived, next, err := journal.changes(ctx, target.ChatID, cursor, timeLeft)
			if err != nil {
				return nil, err
			}
			cursor = next
			for _, entry := range arrived {
				// An old message can turn up in the journal too (see its Latest); it is no reply.
				if entry.IsSender || parseTime(entry.Timestamp) < float64(sentAt-clockSlackMS) {
					continue
				}
				if entry.IsDeleted {
					seen.remove(entry.ID)
				} else {
					seen.set(entry)
				}
				heard()
			}
		}
	} else {
		newer := func(entry message) bool {
			return !entry.IsSender && (baseline == nil || entry.SortKey > baseline.(string))
		}
		for left() > 0 && sleep(ctx, min(r.poll, left())) {
			latest, err := r.messages(ctx, target.ChatID, 5)
			if err != nil {
				return nil, err
			}
			for _, entry := range latest {
				if index := seen.find(entry.ID); !newer(entry) || (index >= 0 && seen[index].Text == entry.Text) {
					continue
				}
				seen.set(entry)
				heard()
			}
		}
	}
	shown := r.shape(ordered(seen), target.Name)
	cursor := baseline
	note := "No reply within " + formatNumber(wait) + "s. Grok bots often take minutes; call grok_bot_read with this cursor later. Do not resend."
	if len(shown) > 0 {
		r.log("grok_reply", map[string]any{"bot": target.Name, "messages": len(shown)})
		cursor = shown[len(shown)-1].SortKey
		note = "The bot may still send more. Call grok_bot_read with this cursor to check later."
	}
	remaining := r.budgetNow()
	return answer(map[string]any{
		"sent":    sentReceipt{MessageID: messageID, SentAs: "Leon"},
		"replies": shown,
		"cursor":  cursor,
		"budget":  budgetUse{Used: remaining.used, Limit: remaining.limit},
		"note":    note,
	}), nil
}

func (r *relay) read(ctx context.Context, args map[string]any) (map[string]any, error) {
	target, err := r.resolve(ctx, args["bot"])
	if err != nil {
		return nil, err
	}
	wanted := 10.0
	if value, set := args["limit"]; set {
		wanted = jsNumber(value)
	}
	if wanted != math.Trunc(wanted) || wanted < 1 || wanted > 30 {
		return nil, errors.New("limit must be 1-30")
	}
	limit := int(wanted)
	after, hasAfter := "", args["after"] != nil
	if hasAfter {
		if after, _ = args["after"].(string); !cursorPattern.MatchString(after) {
			return nil, errors.New("after must be a cursor returned by grok_bot_send or grok_bot_read")
		}
	}
	// From the journal when it holds what is asked for: everything since the cursor's time, or as
	// many of the latest messages as wanted. Otherwise one page of history.
	var list []message
	fromJournal := false
	if journal := r.backend.live(); journal != nil {
		if hasAfter {
			covered, err := journal.coveredSince()
			if err != nil {
				return nil, err
			}
			// A time too large to hold is later than anything in the journal.
			from, err := strconv.ParseInt(after[:strings.IndexByte(after, ':')], 10, 64)
			if err != nil {
				from = math.MaxInt64
			}
			if from >= covered {
				found, err := journal.since(target.ChatID, from)
				if err != nil {
					return nil, err
				}
				list, fromJournal = ordered(found), true
			}
		} else {
			found, err := journal.latest(target.ChatID, limit)
			if err != nil {
				return nil, err
			}
			if held := ordered(found); len(held) >= limit {
				list, fromJournal = held, true
			}
		}
	}
	if !fromJournal {
		if list, err = r.messages(ctx, target.ChatID, limit); err != nil {
			return nil, err
		}
	}
	if hasAfter {
		list = slices.DeleteFunc(list, func(entry message) bool { return entry.SortKey <= after })
	}
	shown := r.shape(list[max(0, len(list)-limit):], target.Name)
	result := map[string]any{"ok": true, "bot": target.Name, "messages": shown, "cursor": nil}
	if len(shown) > 0 {
		result["cursor"] = shown[len(shown)-1].SortKey
	} else if hasAfter {
		result["cursor"] = after
	}
	if waiting := r.queued(target.ChatID); len(waiting) > 0 {
		result["queued"] = waiting
		result["queuedNote"] = "Queued messages go out together when the bot finishes."
	}
	return result, nil
}

func (r *relay) complete(ctx context.Context, args map[string]any) (map[string]any, error) {
	if r.bridge == nil {
		return nil, errors.New(unavailable)
	}
	thread, err := handoff.ParseThread(args["slack_channel"], args["slack_thread_ts"])
	if err != nil {
		return nil, err
	}
	return r.bridge.complete(ctx, thread)
}

// flushOnce sends each queue whose bot has gone idle, or that is 20 minutes old, as one message.
// now replaces the clock that judges idleness; nil means the relay's own.
func (r *relay) flushOnce(ctx context.Context, now func() int64) {
	if r.bridge == nil || !r.flushing.TryLock() {
		return
	}
	defer r.flushing.Unlock()
	if now == nil {
		now = r.now
	}
	r.mu.Lock()
	chatIDs := slices.Sorted(maps.Keys(r.outbox))
	r.mu.Unlock()
	for _, chatID := range chatIDs {
		r.mu.Lock()
		box := r.outbox[chatID]
		r.mu.Unlock()
		if box == nil {
			continue
		}
		if err := r.flushChat(ctx, chatID, box, now); err != nil {
			r.log("grok_flush_error", map[string]any{"bot": box.Bot, "message": utf16Prefix(err.Error(), 300)})
		}
	}
}

func (r *relay) flushChat(ctx context.Context, chatID string, box *queueBox, now func() int64) error {
	r.mu.Lock()
	if len(box.Items) == 0 || r.bridge.retired(chatID) {
		delete(r.outbox, chatID)
		err := host.WriteJSONAtomic(r.outboxFile, r.outbox)
		r.mu.Unlock()
		return err
	}
	firstAt := box.Items[0].At
	r.mu.Unlock()

	list, windowed, err := r.recent(ctx, chatID, now())
	if err != nil {
		return err
	}
	state := busy(list, now(), windowed)
	if state.busy && float64(now())-parseTime(firstAt) < maxQueueAgeMS {
		return nil
	}
	r.mu.Lock()
	batch := takeBatch(box.Items, maxText)
	r.mu.Unlock()
	text := r.withUpkeep(ctx, compose(batch))
	// The same batch always has the same key, so a flush retried after a lost answer can't post it
	// twice.
	identity := []string{chatID}
	for _, item := range batch {
		identity = append(identity, item.At)
	}
	digest := sha256.Sum256([]byte(strings.Join(identity, "\n")))
	if _, err := r.post(ctx, chatID, text, "flush-"+hex.EncodeToString(digest[:])[:40], false); err != nil {
		return err
	}
	// Only the flusher takes items out, and sends only add at the end, so the batch is still the
	// front of the queue.
	r.mu.Lock()
	box.Items = box.Items[len(batch):]
	left := len(box.Items)
	if left == 0 {
		delete(r.outbox, chatID)
	}
	err = host.WriteJSONAtomic(r.outboxFile, r.outbox)
	r.mu.Unlock()
	if err != nil {
		return err
	}
	why := state.reason
	if state.busy {
		why = "queue older than 20 min"
	}
	r.log("grok_flush", map[string]any{
		"bot":   box.Bot,
		"count": len(batch),
		"chars": utf16Len(text),
		"left":  left,
		"why":   why,
	})
	return nil
}
