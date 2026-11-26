package grokrelay

import (
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/handoff"
)

// These are the cases of slack22grokbot/__tests__/policy.test.ts.

var t0 = time.Date(2026, 11, 7, 19, 0, 0, 0, time.UTC).UnixMilli()

func secs(n int64) int64 { return n * 1000 }

var lineKey int64 = 100

// line is one message of a chat, sent offsetMS after t0.
func line(isSender bool, offsetMS int64, text string) message {
	lineKey++
	return message{
		IsSender:  isSender,
		Timestamp: isoTime(t0 + offsetMS),
		SortKey:   strconv.FormatInt(t0+lineKey, 10) + ":$event",
		Text:      text,
	}
}

func mustMatch(t *testing.T, text, pattern string) {
	t.Helper()
	if !regexp.MustCompile(pattern).MatchString(text) {
		t.Errorf("%q does not match %s", text, pattern)
	}
}

func mustEqual[T comparable](t *testing.T, got, want T, what ...string) {
	t.Helper()
	if got != want {
		t.Errorf("%s: got %v, want %v", strings.Join(what, " "), got, want)
	}
}

func TestIdleWhenLeonNeverWrote(t *testing.T) {
	mustEqual(t, busy([]message{line(false, 0, "hello")}, t0+secs(5), false).busy, false)
	mustEqual(t, busy(nil, t0, false).busy, false)
}

func TestBusyWhileTheLastMessageHasNoReplyIdleAfter10Min(t *testing.T) {
	chat := []message{line(false, 0, "done"), line(true, secs(10), "do the thing")}
	mustEqual(t, busy(chat, t0+secs(70), false).busy, true)
	mustEqual(t, busy(chat, t0+secs(10)+9*60000, false).busy, true)
	mustEqual(t, busy(chat, t0+secs(10)+11*60000, false).busy, false)
}

func TestBusyRightAfterAReplyIdleOnceQuietFor60s(t *testing.T) {
	chat := []message{
		line(true, 0, "do it"),
		line(false, secs(30), "Here is the full answer with everything you asked for, finished and verified in Linear."),
	}
	mustEqual(t, busy(chat, t0+secs(60), false).busy, true)
	mustEqual(t, busy(chat, t0+secs(95), false).busy, false)
}

func TestOnlyAcksBusyUpTo5MinOfQuietThenIdle(t *testing.T) {
	chat := []message{line(true, 0, "check my inbox"), line(false, secs(5), "Checking your inbox now.")}
	mustEqual(t, busy(chat, t0+secs(5)+secs(120), false).busy, true)
	mustEqual(t, busy(chat, t0+secs(5)+secs(310), false).busy, false)
}

func TestAckVariantsAndNonAcks(t *testing.T) {
	for _, text := range []string{
		"On it.",
		"I’ll check that now.",
		"I'm pulling the issues now.",
		"Let me look.",
		"Got it, working on it.",
		"**Checking** now",
	} {
		mustEqual(t, isAck(text), true, text)
	}
	mustEqual(t, isAck("Done. LEON-6 is now marked Done and the readback matches."), false)
	// long text is a real answer
	mustEqual(t, isAck("Checking "+strings.Repeat("x", 250)), false)
}

func TestStaleAckIdleOnceOurMessageIsOver20MinOld(t *testing.T) {
	chat := []message{line(true, 0, "go"), line(false, 19*60000, "On it")}
	// quiet 2 min (< 5 min) but our message is 21 min old
	mustEqual(t, busy(chat, t0+21*60000, false).busy, false)
}

func TestARealReplyFollowedByLeonTypingAgainMakesItBusyAgain(t *testing.T) {
	chat := []message{
		line(true, 0, "a"),
		line(false, secs(20), "Full answer that is clearly not an acknowledgement at all, with details."),
		line(true, secs(300), "b"),
	}
	mustEqual(t, busy(chat, t0+secs(330), false).busy, true)
}

func TestComposeNumbersQueuedMessagesAndAppendsTheirHandoff(t *testing.T) {
	thread := handoff.SlackThread{Channel: "C0TASKS001", ThreadTS: "1795280000.123456"}
	items := []queuedItem{{Text: " a ", Thread: thread}, {Text: "b", Thread: thread}}
	mustEqual(t, compose(items[:1]), "a\n\n"+handoff.GrokBlock(thread, nil))
	mustEqual(t, compose(items), "a few more things, in order:\n\n1. a\n\n2. b\n\n"+handoff.GrokBlock(thread, nil))
	mustEqual(t, compose(nil), "")
}

func TestTakeBatchKeepsUnderTheSizeLimitButAlwaysTakesOne(t *testing.T) {
	thread := handoff.SlackThread{Channel: "C0TASKS001", ThreadTS: "1795280000.123456"}
	var items []queuedItem
	for _, letter := range []string{"a", "b", "c"} {
		items = append(items, queuedItem{Text: strings.Repeat(letter, 50), Thread: thread})
	}
	mustEqual(t, len(takeBatch(items, utf16Len(compose(items)))), 3)
	mustEqual(t, len(takeBatch(items, utf16Len(compose(items[:2])))), 2)
	mustEqual(t, len(takeBatch(items, 10)), 1)
}

func TestBudgetRollingHourRefusesAtTheLimitFreesAsSendsAgeOut(t *testing.T) {
	var state budgetState
	for i := range int64(hourlyBudget) {
		state = recordSend(state, t0+i*1000, false)
	}
	mustEqual(t, budgetStatus(state, t0+secs(30)).remaining, 0)
	mustMatch(t, budgetExceededMessage(budgetStatus(state, t0+secs(30)), "Task Bot", "do x"), `Ask Leon in Slack`)
	// the first send ages out after an hour
	mustEqual(t, budgetStatus(state, t0+hourMS+500).remaining, 1)
	mustEqual(t, len(pruneBudget(state, t0+2*hourMS).Sends), 0)
}

func TestBudgetExtensionOnlyWhenExhaustedAddsExtensionForTheHourNeedsAQuote(t *testing.T) {
	var state budgetState
	// not exhausted yet
	if _, extended, err := extendBudget(state, "yes keep going", t0); err != nil || extended {
		t.Errorf("an unused budget was extended: %v, %v", extended, err)
	}
	for i := range int64(hourlyBudget) {
		state = recordSend(state, t0+i, false)
	}
	if _, _, err := extendBudget(state, "ok", t0+secs(1)); err == nil {
		t.Error("a two-letter approval was accepted")
	} else {
		mustMatch(t, err.Error(), `quote Leon`)
	}
	extendedState, extended, err := extendBudget(state, "yes, keep going with the sweep", t0+secs(1))
	if err != nil {
		t.Fatal(err)
	}
	mustEqual(t, extended, true)
	mustEqual(t, budgetStatus(extendedState, t0+secs(2)).limit, hourlyBudget+extension)
	mustEqual(t, budgetStatus(extendedState, t0+secs(2)).remaining, extension)
	mustEqual(t, budgetStatus(extendedState, t0+hourMS+secs(5)).limit, hourlyBudget)
}

func TestLinearAndTodoistBotsNeedAReasonOfSomeLengthOtherBotsDont(t *testing.T) {
	if why, err := guardBot("Task Bot", nil); err != nil || why != "" {
		t.Errorf("Task Bot was guarded: %q, %v", why, err)
	}
	if _, err := guardBot("Linear Bot", "because"); err == nil {
		t.Error("Linear Bot went through with a short reason")
	} else {
		mustMatch(t, err.Error(), `linear/todoist MCP tools`)
	}
	why, err := guardBot("Todoist Bot", "  the todoist MCP cannot create filters  ")
	if err != nil {
		t.Fatal(err)
	}
	mustEqual(t, why, "the todoist MCP cannot create filters")
}

func TestPlainHTMLToTextWithLinksKept(t *testing.T) {
	mustEqual(t,
		plain(`<p>See <a href="https://x.test/a">the page</a></p><ul><li>one</li><li>two &amp; 3</li></ul>`),
		"See the page (https://x.test/a)\n- one\n- two & 3",
	)
}

func TestBusyFromAWindowOfTheChatABotStillPostingCountsEvenWhenLeonsMessageIsOlder(t *testing.T) {
	posting := []message{line(false, 0, "Here is the first half of the answer, more is coming.")}
	mustEqual(t, busy(posting, t0+secs(30), false).busy, false, "all of the chat, no message from Leon: idle")
	mustEqual(t, busy(posting, t0+secs(30), true).busy, true)
	mustEqual(t, busy(posting, t0+secs(90), true).busy, false, "quiet for over a minute")
	mustEqual(t, busy(nil, t0, true).busy, false)
}
