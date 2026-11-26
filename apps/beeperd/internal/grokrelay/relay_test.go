package grokrelay

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/handoff"
)

// These are the cases of slack22grokbot/__tests__/relay.test.ts and the two of handoff.test.ts that
// need the relay, against a fake Beeper: offline, nothing real is sent.

// taskThread is the Slack thread every delegated task carries.
var (
	taskThread = handoff.SlackThread{Channel: "C0TASKS001", ThreadTS: "1795280000.123456"}
	taskBlock  = handoff.GrokBlock(taskThread, nil)
)

// task builds grok_bot_send arguments for the usual thread; extra adds to them or replaces them.
func task(extra map[string]any) map[string]any {
	args := map[string]any{"slack_channel": taskThread.Channel, "slack_thread_ts": taskThread.ThreadTS}
	for key, value := range extra {
		args[key] = value
	}
	return args
}

// fakeBridge stands in for the Slack bridge: every thread exists and no bot is retired.
type fakeBridge struct {
	validateAs func(thread handoff.SlackThread) handoff.SlackThread
}

func (b fakeBridge) validate(_ context.Context, thread handoff.SlackThread) (handoff.SlackThread, error) {
	if b.validateAs != nil {
		return b.validateAs(thread), nil
	}
	return thread, nil
}

func (fakeBridge) complete(context.Context, handoff.SlackThread) (map[string]any, error) {
	return map[string]any{"ok": true}, nil
}

func (fakeBridge) retired(string) bool { return false }

type logged struct {
	event  string
	fields map[string]any
}

// logBook collects what a relay logs.
type logBook struct {
	mu      sync.Mutex
	entries []logged
}

func (b *logBook) log(event string, fields map[string]any) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.entries = append(b.entries, logged{event, fields})
}

func (b *logBook) has(event string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return slices.ContainsFunc(b.entries, func(entry logged) bool { return entry.event == event })
}

type postedMessage struct {
	chatID, text, key string
}

type fakeChat struct {
	id, title string
	messages  []*message
}

// world is the relay against a fake Beeper with no journal.
type world struct {
	stateDir string
	options  relayOptions
	relay    *relay
	logs     logBook

	mu           sync.Mutex
	key, id      int
	chats        []*fakeChat
	posted       []postedMessage
	refreshes    int
	failNextSend bool
}

func setup(t *testing.T, configure ...func(options *relayOptions)) *world {
	w := &world{
		stateDir: filepath.Join(t.TempDir(), "state"),
		key:      1000,
		id:       1,
		chats:    []*fakeChat{{id: "c-task", title: "Task Bot"}, {id: "c-linear", title: "Linear Bot"}},
	}
	w.options = relayOptions{
		stateDir: w.stateDir,
		backend:  w,
		log:      w.logs.log,
		poll:     5 * time.Millisecond,
		bridge:   fakeBridge{},
	}
	for _, change := range configure {
		change(&w.options)
	}
	w.relay = w.open()
	return w
}

// open starts a relay on the same state, as after a restart.
func (w *world) open() *relay { return newRelay(w.options) }

func noBridge(options *relayOptions) { options.bridge = nil }

func (w *world) chat(chatID string) (*fakeChat, error) {
	for _, chat := range w.chats {
		if chat.id == chatID {
			return chat, nil
		}
	}
	return nil, errors.New("no chat " + chatID)
}

func (w *world) addChat(chatID, title string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.chats = append(w.chats, &fakeChat{id: chatID, title: title})
}

// add puts a message in a chat, sent ago before now.
func (w *world) add(chatID string, isSender bool, text string, ago time.Duration) *message {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.addLocked(chatID, isSender, text, ago)
}

func (w *world) addLocked(chatID string, isSender bool, text string, ago time.Duration) *message {
	chat, err := w.chat(chatID)
	if err != nil {
		panic(err)
	}
	added := &message{
		ID:        "$e" + strconv.Itoa(w.id),
		ChatID:    chatID,
		SortKey:   strconv.Itoa(1795000000000+w.key) + ":$e",
		Timestamp: isoTime(time.Now().Add(-ago).UnixMilli()),
		IsSender:  isSender,
		Text:      text,
	}
	w.id++
	w.key++
	chat.messages = append(chat.messages, added)
	return added
}

// edit changes a message's text, as a bot does while it writes.
func (w *world) edit(target *message, text string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	target.Text = text
}

func (w *world) bots(_ context.Context, refresh bool) ([]bot, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if refresh {
		w.refreshes++
	}
	listed := make([]bot, len(w.chats))
	for index, chat := range w.chats {
		listed[index] = bot{Name: chat.title, ChatID: chat.id}
	}
	return listed, nil
}

func (w *world) messages(_ context.Context, chatID string, _ int) ([]message, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	chat, err := w.chat(chatID)
	if err != nil {
		return nil, err
	}
	var newestFirst []message
	for _, held := range slices.Backward(chat.messages) {
		newestFirst = append(newestFirst, *held)
	}
	return newestFirst, nil
}

func (w *world) send(_ context.Context, chatID, text, key string) (string, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.posted = append(w.posted, postedMessage{chatID, text, key})
	if w.failNextSend {
		w.failNextSend = false
		return "", errors.New("timed out after the request went out")
	}
	return w.addLocked(chatID, true, text, 0).ID, nil
}

func (w *world) live() live { return nil }

func (w *world) sent() []postedMessage {
	w.mu.Lock()
	defer w.mu.Unlock()
	return slices.Clone(w.posted)
}

// mustSend is a grok_bot_send that has to be accepted.
func mustSend(t *testing.T, r *relay, args map[string]any) map[string]any {
	t.Helper()
	result, err := r.send(context.Background(), args)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func mustRead(t *testing.T, r *relay, args map[string]any) map[string]any {
	t.Helper()
	result, err := r.read(context.Background(), args)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

// mustRefuse runs a call that has to be refused with a message matching pattern.
func mustRefuse(t *testing.T, err error, pattern string) {
	t.Helper()
	if err == nil {
		t.Fatalf("accepted, want a refusal matching %s", pattern)
	}
	mustMatch(t, err.Error(), pattern)
}

func froms(shown []shapedMessage) []string {
	names := make([]string, len(shown))
	for index, entry := range shown {
		names[index] = entry.From
	}
	return names
}

func texts(shown []shapedMessage) []string {
	found := make([]string, len(shown))
	for index, entry := range shown {
		found[index] = entry.Text
	}
	return found
}

func TestIdleBotSendsDirectlyAndCountsAgainstTheBudget(t *testing.T) {
	w := setup(t)
	w.add("c-task", true, "earlier", 3600*time.Second)
	w.add("c-task", false, "Earlier full answer, done and verified.", 3500*time.Second)
	result := mustSend(t, w.relay, task(map[string]any{"bot": "Task Bot", "text": "please do X", "wait_seconds": 0.0}))
	mustEqual(t, result["ok"], any(true))
	if _, queued := result["queued"]; queued {
		t.Error("an idle bot's message was queued")
	}
	posted := w.sent()
	mustEqual(t, len(posted), 1)
	mustEqual(t, result["budget"], any(budgetUse{Used: 1, Limit: hourlyBudget}))
	mustMatch(t, posted[0].key, `^send-[0-9a-f-]{36}$`)
}

func TestAMissingSlackBridgeLeavesReadToolsAvailableAndRefusesHandoffs(t *testing.T) {
	w := setup(t, noBridge)
	bots, err := w.relay.bots(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.ContainsFunc(bots, func(listed listedBot) bool { return listed.Name == "Task Bot" }) {
		t.Error("Task Bot is not listed")
	}
	_, err = w.relay.send(context.Background(), task(map[string]any{"bot": "Task Bot", "text": "do it", "wait_seconds": 0.0}))
	mustRefuse(t, err, `slack22grokbot is unavailable`)
	mustEqual(t, len(w.sent()), 0)
}

func TestBusyBotQueuedMergedIntoOneMessageOnFlushOnceIdle(t *testing.T) {
	w := setup(t)
	ctx := context.Background()
	w.add("c-task", true, "first ask", 30*time.Second) // no reply yet: busy
	first := mustSend(t, w.relay, task(map[string]any{"bot": "Task", "text": "also do Y", "wait_seconds": 0.0}))
	second := mustSend(t, w.relay, task(map[string]any{"bot": "Task", "text": "and Z", "wait_seconds": 0.0}))
	mustEqual(t, first["queued"], any(true))
	mustEqual(t, second["position"], any(2))
	mustEqual(t, len(w.sent()), 0)
	var outbox map[string]struct {
		Items []json.RawMessage `json:"items"`
	}
	data, err := os.ReadFile(filepath.Join(w.stateDir, "outbox.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &outbox); err != nil {
		t.Fatal(err)
	}
	mustEqual(t, len(outbox["c-task"].Items), 2)
	read := mustRead(t, w.relay, map[string]any{"bot": "Task Bot"})
	mustEqual(t, len(read["queued"].([]queuedPreview)), 2)
	bots, _ := w.relay.bots(ctx, false)
	mustEqual(t, bots[slices.IndexFunc(bots, func(listed listedBot) bool { return listed.ChatID == "c-task" })].Queued, 2)
	w.relay.flushOnce(ctx, nil) // still busy: nothing goes out
	mustEqual(t, len(w.sent()), 0)
	// the bot answers and goes quiet for over a minute
	w.add("c-task", false, "Done with the first ask, here are the full results and the readback.", 90*time.Second)
	w.relay.flushOnce(ctx, nil)
	posted := w.sent()
	mustEqual(t, len(posted), 1)
	// Both carry the same thread, so its handoff block follows once.
	mustEqual(t, posted[0].text, "a few more things, in order:\n\n1. also do Y\n\n2. and Z\n\n"+taskBlock)
	if _, queued := mustRead(t, w.relay, map[string]any{"bot": "Task Bot"})["queued"]; queued {
		t.Error("the flushed messages are still listed as queued")
	}
	mustEqual(t, w.relay.budgetNow().used, 1)
}

func TestAFlushRetriedAfterALostAnswerReusesItsKeySoItCantPostTwice(t *testing.T) {
	w := setup(t)
	ctx := context.Background()
	w.add("c-task", true, "first ask", 30*time.Second)
	mustSend(t, w.relay, task(map[string]any{"bot": "Task Bot", "text": "also do Y", "wait_seconds": 0.0}))
	w.add("c-task", false, "Done with the first ask, here are the full results and the readback.", 90*time.Second)
	w.mu.Lock()
	w.failNextSend = true
	w.mu.Unlock()
	w.relay.flushOnce(ctx, nil)
	if !w.logs.has("grok_flush_error") {
		t.Error("the failed flush was not logged")
	}
	if _, queued := mustRead(t, w.relay, map[string]any{"bot": "Task Bot"})["queued"]; !queued {
		t.Error("the message is no longer queued after a failed flush")
	}
	w.relay.flushOnce(ctx, nil)
	posted := w.sent()
	mustEqual(t, len(posted), 2)
	mustMatch(t, posted[0].key, `^flush-[0-9a-f]{40}$`)
	mustEqual(t, posted[0].key, posted[1].key)
	mustEqual(t, w.relay.budgetNow().used, 1, "only the send that went through counts")
}

func TestUrgentGoesStraightOutEvenWhenBusy(t *testing.T) {
	w := setup(t)
	w.add("c-task", true, "first ask", 10*time.Second)
	result := mustSend(t, w.relay, task(map[string]any{
		"bot":          "Task Bot",
		"text":         "stop, wrong account",
		"urgent":       true,
		"wait_seconds": 0.0,
	}))
	if _, queued := result["queued"]; queued {
		t.Error("an urgent message was queued")
	}
	mustEqual(t, len(w.sent()), 1)
}

func TestLinearBotNeedsAReasonWithOneItIsAllowedAndLogged(t *testing.T) {
	w := setup(t)
	_, err := w.relay.send(context.Background(), task(map[string]any{"bot": "Linear Bot", "text": "read back LEON-6", "wait_seconds": 0.0}))
	mustRefuse(t, err, `linear/todoist MCP tools`)
	mustEqual(t, len(w.sent()), 0)
	result := mustSend(t, w.relay, task(map[string]any{
		"bot":               "Linear Bot",
		"text":              "create the workflow status",
		"needs_bot_because": "the linear MCP cannot create workflow states",
		"wait_seconds":      0.0,
	}))
	mustEqual(t, result["ok"], any(true))
	if !w.logs.has("grok_bot_justified") {
		t.Error("the reason was not logged")
	}
}

func TestBudgetRefusedAtTheLimitWithAskLeonTextLeonsQuoteExtendsIt(t *testing.T) {
	w := setup(t)
	sends := make([]string, hourlyBudget)
	for index := range sends {
		sends[index] = isoTime(time.Now().UnixMilli() - 60_000 + int64(index))
	}
	// The file as the TypeScript relay wrote it, with only the sends in it.
	data, _ := json.Marshal(map[string]any{"sends": sends})
	if err := os.MkdirAll(w.stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(w.stateDir, "budget.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	// a new relay picks the saved budget up, as after a restart
	relay := w.open()
	_, err := relay.send(context.Background(), task(map[string]any{"bot": "Task Bot", "text": "one more", "wait_seconds": 0.0}))
	mustRefuse(t, err, `Ask Leon in Slack`)
	refused, err := (&running{relay: relay, ctx: context.Background()}).CallTool(context.Background(), "grok_bot_send", map[string]any{"bot": "Task Bot", "text": "one more"})
	if err != nil {
		t.Fatal(err)
	}
	mustEqual(t, refused["ok"], any(false))
	mustEqual(t, refused["error"].(map[string]any)["code"], any("slack22grokbot_error"))
	result := mustSend(t, relay, task(map[string]any{
		"bot":                "Task Bot",
		"text":               "one more",
		"wait_seconds":       0.0,
		"leon_approved_more": "yes keep going, send it",
	}))
	mustEqual(t, result["ok"], any(true))
	mustEqual(t, relay.budgetNow().limit, hourlyBudget*2)
}

func TestWaitsForTheReplyAndReturnsItAsItFinallyReads(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		w := setup(t)
		time.AfterFunc(20*time.Millisecond, func() {
			reply := w.add("c-task", false, "Working", 0)
			time.AfterFunc(30*time.Millisecond, func() { w.edit(reply, "Working… done: the form is submitted.") })
		})
		result := mustSend(t, w.relay, task(map[string]any{"bot": "Task Bot", "text": "submit the form", "wait_seconds": 0.2}))
		replies := result["replies"].([]shapedMessage)
		if !reflect.DeepEqual(froms(replies), []string{"Task Bot"}) || !reflect.DeepEqual(texts(replies), []string{"Working… done: the form is submitted."}) {
			t.Errorf("replies = %+v", replies)
		}
		mustEqual(t, result["cursor"], any(replies[0].SortKey))
		mustEqual(t, result["sent"].(sentReceipt).SentAs, "Leon")
	})
}

func TestReadTellsHermessMessagesFromLeonsAndPagesByCursor(t *testing.T) {
	w := setup(t)
	w.add("c-task", true, "typed by Leon himself", 400*time.Second)
	w.add("c-task", false, "An answer to Leon.", 390*time.Second)
	mustSend(t, w.relay, task(map[string]any{"bot": "Task Bot", "text": "from Hermes", "wait_seconds": 0.0}))
	w.add("c-task", false, "An answer to Hermes.", 0)
	all := mustRead(t, w.relay, map[string]any{"bot": "task"})
	lines := all["messages"].([]shapedMessage)
	if want := []string{"Leon", "Task Bot", "Hermes (as Leon)", "Task Bot"}; !reflect.DeepEqual(froms(lines), want) {
		t.Fatalf("from = %v, want %v", froms(lines), want)
	}
	later := mustRead(t, w.relay, map[string]any{"bot": "Task Bot", "after": lines[2].SortKey})
	if got := texts(later["messages"].([]shapedMessage)); !reflect.DeepEqual(got, []string{"An answer to Hermes."}) {
		t.Errorf("after the cursor: %v", got)
	}
	_, err := w.relay.read(context.Background(), map[string]any{"bot": "Task Bot", "after": "26965"})
	mustRefuse(t, err, `after must be a cursor`)
}

func TestAnUnknownBotRefreshesTheListOnceThenNamesTheOnesThereAre(t *testing.T) {
	w := setup(t)
	_, err := w.relay.read(context.Background(), map[string]any{"bot": "Nope"})
	mustRefuse(t, err, `No Grok bot called "Nope"\. Available: Task Bot, Linear Bot`)
	mustEqual(t, w.refreshes, 1)
	w.addChat("c-new", "Brand New Bot")
	mustEqual(t, mustRead(t, w.relay, map[string]any{"bot": "brand new"})["bot"], any("Brand New Bot"))
}

// liveWorld is the relay with a journal: a fake one that hands out positions and wakes waiters like
// the real one.
type liveWorld struct {
	relay          *relay
	coveredMinutes int64

	mu      sync.Mutex
	rows    []liveRow
	head    int64
	id      int
	history int
	waits   []time.Duration
	posted  []string
}

type liveRow struct {
	rev     int64
	message message
}

const liveChat = "!task:beeper.local"

func setupLive(t *testing.T, coveredMinutes int64) *liveWorld {
	w := &liveWorld{coveredMinutes: coveredMinutes, id: 1}
	w.relay = newRelay(relayOptions{
		stateDir: filepath.Join(t.TempDir(), "state"),
		backend:  w,
		log:      func(string, map[string]any) {},
		quiet:    60 * time.Millisecond,
		bridge:   fakeBridge{},
	})
	return w
}

// arrive delivers a message sent ago before now, or changes an earlier one when existing is its ID.
func (w *liveWorld) arrive(isSender bool, text string, ago time.Duration, existing string) message {
	w.mu.Lock()
	defer w.mu.Unlock()
	var arrived message
	if index := slices.IndexFunc(w.rows, func(row liveRow) bool { return row.message.ID == existing }); index >= 0 {
		arrived = w.rows[index].message
		arrived.Text = text
		w.rows = slices.Delete(w.rows, index, index+1)
	} else {
		ts := time.Now().Add(-ago).UnixMilli()
		eventID := "$j" + strconv.Itoa(w.id)
		w.id++
		arrived = message{
			ID:        eventID,
			ChatID:    liveChat,
			SortKey:   sortKeyOf(ts, eventID),
			IsSender:  isSender,
			Text:      text,
			Timestamp: isoTime(ts),
		}
	}
	w.head++
	w.rows = append(w.rows, liveRow{w.head, arrived})
	return arrived
}

func (w *liveWorld) held() []message {
	held := make([]message, len(w.rows))
	for index, row := range w.rows {
		held[index] = row.message
	}
	return held
}

func (w *liveWorld) coveredSince() (int64, error) {
	return time.Now().UnixMilli() - w.coveredMinutes*60_000, nil
}

func (w *liveWorld) latest(_ string, count int) ([]message, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	held := w.held()
	return held[max(0, len(held)-count):], nil
}

func (w *liveWorld) since(_ string, sinceMS int64) ([]message, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return slices.DeleteFunc(w.held(), func(entry message) bool { return parseTime(entry.Timestamp) < float64(sinceMS) }), nil
}

func (w *liveWorld) cursor() (int64, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.head, nil
}

func (w *liveWorld) changes(ctx context.Context, _ string, cursor int64, wait time.Duration) ([]message, int64, error) {
	w.mu.Lock()
	w.waits = append(w.waits, wait)
	w.mu.Unlock()
	deadline := time.Now().Add(wait)
	for {
		w.mu.Lock()
		var found []message
		next := cursor
		for _, row := range w.rows {
			if row.rev > cursor {
				found = append(found, row.message)
				next = row.rev
			}
		}
		w.mu.Unlock()
		// Like the real journal, it answers with what it has when the caller goes away.
		if len(found) > 0 || !time.Now().Before(deadline) || ctx.Err() != nil {
			return found, next, nil
		}
		time.Sleep(3 * time.Millisecond)
	}
}

func (w *liveWorld) bots(context.Context, bool) ([]bot, error) {
	return []bot{{Name: "Task Bot", ChatID: liveChat}}, nil
}

func (w *liveWorld) messages(context.Context, string, int) ([]message, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.history++
	return nil, nil
}

func (w *liveWorld) send(_ context.Context, _, text, _ string) (string, error) {
	w.mu.Lock()
	w.posted = append(w.posted, text)
	w.mu.Unlock()
	return w.arrive(true, text, 0, "").ID, nil
}

func (w *liveWorld) live() live { return w }

func TestWithTheJournalASendReadsNoHistoryAndReturnsTheReplyAsItFinallyReads(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		w := setupLive(t, 60)
		w.arrive(true, "earlier ask", 50*time.Minute, "") // older than the busy window: not even looked at
		time.AfterFunc(20*time.Millisecond, func() {
			w.arrive(false, "Something the bot said last week, surfacing only now.", 7*24*time.Hour, "")
			reply := w.arrive(false, "Working", 0, "")
			time.AfterFunc(25*time.Millisecond, func() { w.arrive(false, "Working… done: submitted.", 0, reply.ID) })
			time.AfterFunc(40*time.Millisecond, func() { w.arrive(false, "Anything else?", 0, "") })
		})
		result := mustSend(t, w.relay, task(map[string]any{"bot": "Task Bot", "text": "submit the form", "wait_seconds": 5.0}))
		if !reflect.DeepEqual(w.posted, []string{"submit the form\n\n" + taskBlock}) {
			t.Errorf("posted %q", w.posted)
		}
		replies := result["replies"].([]shapedMessage)
		if !reflect.DeepEqual(froms(replies), []string{"Task Bot", "Task Bot"}) ||
			!reflect.DeepEqual(texts(replies), []string{"Working… done: submitted.", "Anything else?"}) {
			t.Errorf("replies = %+v", replies)
		}
		mustEqual(t, w.history, 0, "no page of history was read")
		if len(w.waits) > 6 {
			t.Errorf("%d waits: it must wait on the journal instead of polling", len(w.waits))
		}
		if w.waits[0] <= 4000*time.Millisecond {
			t.Errorf("first wait %v: first for the whole time it was given", w.waits[0])
		}
		if last := w.waits[len(w.waits)-1]; last > 60*time.Millisecond {
			t.Errorf("last wait %v: then only for the quiet after a reply", last)
		}
		mustMatch(t, result["cursor"].(string), `^\d{13}:\$j`)
	})
}

func TestWithTheJournalBusyIsJudgedFromTheLastMinutesAlone(t *testing.T) {
	ctx := context.Background()
	// The bot is mid-answer to something Leon asked before the window: still busy.
	first := setupLive(t, 60)
	first.arrive(false, "Here is part one of the long answer you asked for earlier today.", 30*time.Second, "")
	queued := mustSend(t, first.relay, task(map[string]any{"bot": "Task Bot", "text": "one more thing", "wait_seconds": 0.0}))
	mustEqual(t, queued["queued"], any(true))
	mustMatch(t, queued["reason"].(string), `posted 30s ago`)
	mustEqual(t, first.history, 0)

	// Quiet for the whole window: idle, whatever happened before it.
	second := setupLive(t, 60)
	second.arrive(false, "All done.", 20*time.Minute, "")
	if _, queued := mustSend(t, second.relay, task(map[string]any{"bot": "Task Bot", "text": "hi", "wait_seconds": 0.0}))["queued"]; queued {
		t.Error("a quiet bot's message was queued")
	}

	// Leon asked two minutes ago and nothing came back yet: busy, and the queue flushes from the
	// journal too.
	third := setupLive(t, 60)
	third.arrive(true, "do the thing", 2*time.Minute, "")
	mustEqual(t, mustSend(t, third.relay, task(map[string]any{"bot": "Task Bot", "text": "and this", "wait_seconds": 0.0}))["queued"], any(true))
	third.arrive(false, "Done, here are the full results and the readback you wanted.", 90*time.Second, "")
	third.relay.flushOnce(ctx, nil)
	if !reflect.DeepEqual(third.posted, []string{"and this\n\n" + taskBlock}) {
		t.Errorf("posted %q", third.posted)
	}
	mustEqual(t, third.history, 0)
}

func TestWithTheJournalReadsComeFromItWhenItHoldsWhatIsAskedFromHistoryWhenNot(t *testing.T) {
	w := setupLive(t, 60)
	a := w.arrive(false, "first", 10*time.Minute, "")
	w.arrive(false, "second", 5*time.Minute, "")
	later := mustRead(t, w.relay, map[string]any{"bot": "Task Bot", "after": a.SortKey})
	if got := texts(later["messages"].([]shapedMessage)); !reflect.DeepEqual(got, []string{"second"}) {
		t.Errorf("after the cursor: %v", got)
	}
	mustEqual(t, w.history, 0, "a cursor inside the journal's coverage needs no history")
	mustEqual(t, len(mustRead(t, w.relay, map[string]any{"bot": "Task Bot", "limit": 2.0})["messages"].([]shapedMessage)), 2)
	mustEqual(t, w.history, 0, "the latest two are in the journal")
	mustRead(t, w.relay, map[string]any{"bot": "Task Bot", "limit": 10.0})
	mustEqual(t, w.history, 1, "more than the journal holds: one page of history")
	mustRead(t, w.relay, map[string]any{"bot": "Task Bot", "after": strconv.FormatInt(time.Now().UnixMilli()-3*3600_000, 10) + ":$old"})
	mustEqual(t, w.history, 2, "a cursor from before the coverage: history too")
}

func TestAJournalYoungerThanTheBusyWindowIsntTrustedYet(t *testing.T) {
	w := setupLive(t, 5)
	mustSend(t, w.relay, task(map[string]any{"bot": "Task Bot", "text": "hi", "wait_seconds": 0.0}))
	mustEqual(t, w.history, 1, "one small page of history decides busy until the journal is old enough")
}

func TestOneTaskBotPerSlackThreadATaskForAThreadThatHasOneGoesToIt(t *testing.T) {
	w := setup(t, func(options *relayOptions) {
		options.bridge = fakeBridge{validateAs: func(thread handoff.SlackThread) handoff.SlackThread {
			thread.Channel = taskThread.Channel
			return thread
		}}
	})
	w.addChat("c-thread", "Task slack:C0TASKS001/1795280000.123456")
	result := mustSend(t, w.relay, task(map[string]any{
		"slack_channel": "#leon-42-fix",
		"bot":           "Task Bot",
		"text":          "one more thing",
		"wait_seconds":  0.0,
	}))
	posted := w.sent()
	mustEqual(t, len(posted), 1)
	mustEqual(t, posted[0].chatID, "c-thread", "not the bot that was named")
	mustEqual(t, posted[0].text, "one more thing\n\n"+handoff.GrokFollowUpBlock(taskThread))
	mustEqual(t, result["task_bot"], any("Task slack:C0TASKS001/1795280000.123456"))
	mustEqual(t, result["redirected_from"], any("Task Bot"))
	// Another thread still gets a new task bot from the bot that was named.
	other := mustSend(t, w.relay, map[string]any{
		"bot":             "Task Bot",
		"text":            "a new task",
		"slack_channel":   "C0TASKS001",
		"slack_thread_ts": "1795280099.000001",
		"wait_seconds":    0.0,
	})
	posted = w.sent()
	mustEqual(t, posted[len(posted)-1].chatID, "c-task")
	mustMatch(t, posted[len(posted)-1].text, `Create a new bot for it named exactly "Task slack:C0TASKS001/1795280099\.000001"`)
	if _, redirected := other["redirected_from"]; redirected {
		t.Error("a new thread's task was redirected")
	}
	invalid := "Task slack:unknown/1795280099.000001"
	w.addChat("c-invalid", invalid)
	_, err := w.relay.send(context.Background(), task(map[string]any{"slack_thread_ts": "1795280099.000001", "bot": invalid, "text": "new task"}))
	mustRefuse(t, err, `belongs to a different Slack thread`)
	mustEqual(t, len(w.sent()), 2)
}

func TestTheGrokBoxSetupGoesBeforeEveryMessageWhileTheBoxIsDown(t *testing.T) {
	down := true
	w := setup(t, func(options *relayOptions) {
		options.upkeep = func(context.Context) (string, error) {
			if down {
				return "[Before anything else, yourself] SETUP", nil
			}
			return "", nil
		}
	})
	w.add("c-task", true, "earlier", 3600*time.Second)
	w.add("c-task", false, "Done.", 3500*time.Second)
	mustSend(t, w.relay, task(map[string]any{"bot": "Task Bot", "text": "please do X", "wait_seconds": 0.0}))
	mustMatch(t, w.sent()[0].text, `^\[Before anything else, yourself\] SETUP\n\nplease do X`)
	// A queued message gets it when the flusher sends it, and a healthy box adds nothing.
	w.add("c-task", false, "On it.", 120*time.Second)
	mustSend(t, w.relay, task(map[string]any{"bot": "Task Bot", "text": "also Y", "wait_seconds": 0.0}))
	down = false
	w.relay.flushOnce(context.Background(), func() int64 { return time.Now().UnixMilli() + 25*60_000 })
	posted := w.sent()
	mustEqual(t, len(posted), 2)
	mustMatch(t, posted[len(posted)-1].text, `^also Y`)
}

func TestUpkeepThatFailsNeverStopsAMessage(t *testing.T) {
	w := setup(t, func(options *relayOptions) {
		options.upkeep = func(context.Context) (string, error) { return "", errors.New("tailscale is gone") }
	})
	mustSend(t, w.relay, task(map[string]any{"bot": "Task Bot", "text": "please do X", "wait_seconds": 0.0}))
	mustMatch(t, w.sent()[0].text, `^please do X`)
}

func TestDirectSendsOneMessageWithNoSlackTaskAndNotToABusyBot(t *testing.T) {
	w := setup(t)
	ctx := context.Background()
	if err := w.relay.direct(ctx, "Task Bot", "repair the box"); err != nil {
		t.Fatal(err)
	}
	posted := w.sent()
	mustEqual(t, posted[0].text, "repair the box")
	mustMatch(t, posted[0].key, `^direct-`)
	if !w.logs.has("grok_direct") {
		t.Error("the direct send was not logged")
	}
	w.add("c-linear", true, "still waiting", 30*time.Second)
	mustRefuse(t, w.relay.direct(ctx, "Linear Bot", "repair"), `Linear Bot is busy`)
}

// The two cases of handoff.test.ts that are about the relay.

func TestMergedMessagesCarryOneBlockPerThreadNamingTheirItemsWhenThereAreSeveral(t *testing.T) {
	t1 := taskThread
	t2 := handoff.SlackThread{Channel: "#leon-42-fix-the-thing", ThreadTS: "1795280001.000001"}
	at := "2026-11-21T18:00:00.000Z"
	mustEqual(t, compose([]queuedItem{{Text: "one", At: at, Thread: t1}}), "one\n\n"+handoff.GrokBlock(t1, nil))
	same := compose([]queuedItem{{Text: "one", At: at, Thread: t1}, {Text: "two", At: at, Thread: t1}})
	mustEqual(t, strings.Count(same, "Slack thread for"), 1)
	mixed := compose([]queuedItem{
		{Text: "one", At: at, Thread: t1},
		{Text: "two", At: at, Thread: t2},
		{Text: "three", At: at, Thread: t1},
	})
	mustMatch(t, mixed, `Slack thread for items 1, 3: slack:C0TASKS001`)
	mustMatch(t, mixed, `Slack thread for item 2: slack:#leon-42-fix-the-thing`)
}

func TestGrokBotSendRefusesATaskWithoutItsSlackThread(t *testing.T) {
	w := setup(t, noBridge)
	_, err := w.relay.send(context.Background(), map[string]any{"bot": "Task Bot", "text": "do it", "wait_seconds": 0.0})
	mustRefuse(t, err, `slack_channel and slack_thread_ts are required`)
}

// What the TypeScript tests could not get wrong, and a Go port can.

func TestStateFilesKeepTheTypeScriptShapesAndStayPrivate(t *testing.T) {
	w := setup(t)
	w.add("c-task", true, "first ask", 30*time.Second)
	mustSend(t, w.relay, task(map[string]any{"bot": "Task Bot", "text": "queued", "wait_seconds": 0.0}))
	mustSend(t, w.relay, task(map[string]any{"bot": "Linear Bot", "text": "sent", "needs_bot_because": "the linear MCP cannot do this one", "wait_seconds": 0.0}))
	decode := func(name string) any {
		file := filepath.Join(w.stateDir, name)
		info, err := os.Stat(file)
		if err != nil {
			t.Fatal(err)
		}
		mustEqual(t, info.Mode().Perm(), os.FileMode(0o600), name)
		data, _ := os.ReadFile(file)
		var value any
		if err := json.Unmarshal(data, &value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	item := decode("outbox.json").(map[string]any)["c-task"].(map[string]any)
	mustEqual(t, item["bot"], any("Task Bot"))
	queued := item["items"].([]any)[0].(map[string]any)
	if want := map[string]any{"channel": "C0TASKS001", "threadTs": "1795280000.123456"}; !reflect.DeepEqual(queued["thread"], want) {
		t.Errorf("queued thread = %v", queued["thread"])
	}
	mustEqual(t, queued["text"], any("queued"))
	mustMatch(t, queued["at"].(string), `^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$`)
	if _, followUp := queued["followUp"]; followUp {
		t.Error("followUp is only written for a task bot's own messages")
	}
	budget := decode("budget.json").(map[string]any)
	mustEqual(t, len(budget["sends"].([]any)), 1)
	// Empty lists are lists, never null: the TypeScript relay would trip over null.
	mustEqual(t, len(budget["urgent"].([]any)), 0)
	mustEqual(t, len(budget["extensions"].([]any)), 0)
	sent := decode("hermes-sent.json").([]any)[0].(map[string]any)
	mustEqual(t, sent["chatID"], any("c-linear"))
	mustMatch(t, sent["id"].(string), `^\$e`)
	mustMatch(t, sent["at"].(string), `Z$`)
	// A restart reads them back.
	reopened := w.open()
	mustEqual(t, reopened.budgetNow().used, 1)
	mustEqual(t, len(reopened.queued("c-task")), 1)
	mustEqual(t, froms(mustRead(t, reopened, map[string]any{"bot": "Linear Bot"})["messages"].([]shapedMessage))[0], "Hermes (as Leon)")
}

func TestPastAUsedUpBudgetFiveUrgentSendsAnHourStillGoOut(t *testing.T) {
	w := setup(t)
	sends := make([]string, hourlyBudget)
	for index := range sends {
		sends[index] = isoTime(time.Now().UnixMilli() - 60_000 + int64(index))
	}
	data, _ := json.Marshal(budgetState{Sends: sends})
	if err := os.MkdirAll(w.stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(w.stateDir, "budget.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	relay := w.open()
	stop := task(map[string]any{"bot": "Task Bot", "text": "stop, wrong account", "urgent": true, "wait_seconds": 0.0})
	for range urgentOverBudget {
		mustSend(t, relay, stop)
	}
	_, err := relay.send(context.Background(), stop)
	mustRefuse(t, err, `^Hourly budget reached: 30 of 25 relayed Grok bot messages in the last hour \(frees up in about 59 min\)\. `)
	mustEqual(t, len(w.sent()), urgentOverBudget)
	if !w.logs.has("budget_refused") {
		t.Error("the refusal was not logged")
	}
}

func TestAWaitEndsWhenTheCallerGoesAway(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		w := setupLive(t, 60)
		ctx, cancel := context.WithCancel(context.Background())
		time.AfterFunc(time.Second, cancel)
		started := time.Now()
		result, err := w.relay.send(ctx, task(map[string]any{"bot": "Task Bot", "text": "submit the form", "wait_seconds": 150.0}))
		if err != nil {
			t.Fatal(err)
		}
		mustEqual(t, result["ok"], any(true))
		if waited := time.Since(started); waited > 2*time.Second {
			t.Errorf("waited %v after the caller left", waited)
		}
	})
}

func TestBadArgumentsAreRefusedWithTheSameWords(t *testing.T) {
	w := setup(t)
	ctx := context.Background()
	for _, c := range []struct {
		args    map[string]any
		pattern string
	}{
		{task(map[string]any{"bot": "Task Bot", "text": "  "}), `^text is required$`},
		{task(map[string]any{"bot": "Task Bot", "text": strings.Repeat("x", 8001)}), `^text must be under 8000 characters$`},
		{task(map[string]any{"bot": "Task Bot", "text": "x", "wait_seconds": 151.0}), `^wait_seconds must be 0-150$`},
		{task(map[string]any{"bot": "Task Bot", "text": "x", "wait_seconds": "soon"}), `^wait_seconds must be 0-150$`},
		{task(map[string]any{"text": "x"}), `^bot is required, e\.g\. "University Bot"$`},
		{task(map[string]any{"bot": "Task Bot", "text": "x", "leon_approved_more": "ok"}), `must quote Leon's own words`},
	} {
		_, err := w.relay.send(ctx, c.args)
		mustRefuse(t, err, c.pattern)
	}
	_, err := w.relay.read(ctx, map[string]any{"bot": "Task Bot", "limit": 2.5})
	mustRefuse(t, err, `^limit must be 1-30$`)
	_, err = w.relay.read(ctx, map[string]any{"bot": "Task Bot", "limit": 31.0})
	mustRefuse(t, err, `^limit must be 1-30$`)
	mustEqual(t, len(w.sent()), 0)
}
