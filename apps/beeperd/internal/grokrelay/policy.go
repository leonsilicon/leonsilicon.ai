package grokrelay

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/handoff"
)

// Usage policy for slack22grokbot. Grok Bot bills by agent steps and tokens, and Hermes was sending
// follow-ups to bots still working on its previous message (63 of 134 sends landed under 3 minutes
// after the last one), each starting another full run. These pure helpers decide when a bot is busy,
// merge queued messages into one, keep an hourly budget that sends Hermes to Leon, and steer Linear
// and Todoist work to Hermes's own MCP tools.

const (
	hourlyBudget = 25
	// extension is added for the rolling hour after Leon approves more.
	extension = 25
	// urgentOverBudget is the urgent stop or correction sends allowed per hour past an exhausted
	// budget.
	urgentOverBudget = 5
	hourMS           = 60 * 60 * 1000
	// noReplyBusyMS: no reply yet, so assume the bot is still working this long.
	noReplyBusyMS = 10 * 60 * 1000
	// quietMS: the bot posted this recently, so it may still be sending.
	quietMS = 60 * 1000
	// ackQuietMS: only acknowledgements so far, so give it this long to post the real answer…
	ackQuietMS = 5 * 60 * 1000
	// ackWindowMS: …but only while our last message is this fresh.
	ackWindowMS = 20 * 60 * 1000
	// busyWindowMS is how much of a chat busy needs: every rule above looks at most this far back
	// (the 20-minute acknowledgement window, with room to spare).
	busyWindowMS = 25 * 60 * 1000
	// maxQueueAgeMS: flush a queue this old even if the bot still looks busy.
	maxQueueAgeMS    = 20 * 60 * 1000
	minJustification = 20
)

var bookkeepingBots = []string{"linear bot", "todoist bot"}

// queuedItem is one message waiting for a busy bot. Its JSON is the outbox file's.
type queuedItem struct {
	// Text is Hermes's own text, without the handoff block.
	Text string `json:"text"`
	At   string `json:"at"`
	// Thread is the task's Slack thread; the block for it is added when the queue goes out.
	Thread handoff.SlackThread `json:"thread"`
	// FollowUp marks a message for the thread's task bot itself: it gets a follow-up note instead of
	// the "make a task bot" block.
	FollowUp bool `json:"followUp,omitempty"`
}

type budgetExtension struct {
	At    string `json:"at"`
	Quote string `json:"quote"`
}

// budgetState is the last hour's sends and Leon's approvals. Its JSON is the budget file's.
type budgetState struct {
	Sends      []string          `json:"sends"`
	Urgent     []string          `json:"urgent"`
	Extensions []budgetExtension `json:"extensions"`
}

var (
	anchor     = regexp.MustCompile(`(?is)<a` + jsSpaces + `[^>]*href="([^"]*)"[^>]*>(.*?)</a>`)
	anyTag     = regexp.MustCompile(`<[^>]+>`)
	lineBreak  = regexp.MustCompile(`(?i)<br` + jsSpaces + `*/?>`)
	listItem   = regexp.MustCompile(`(?i)<li[^>]*>`)
	blockEnd   = regexp.MustCompile(`(?i)</(p|li|ul|ol|h\d|pre|blockquote)>`)
	looseItem  = regexp.MustCompile(`\n` + jsSpaces + `*\n- `)
	blankLines = regexp.MustCompile(`\n{3,}`)
	entities   = strings.NewReplacer("&nbsp;", " ", "&lt;", "<", "&gt;", ">", "&quot;", `"`, "&#39;", "'")

	ackStart = regexp.MustCompile(`^(?:` + jsSpaces + `|["'*_>])+`)
	ack      = regexp.MustCompile(`(?i)^(on it|checking|looking|i['’]ll|i will|i['’]m (checking|looking|pulling|working|on it|going|starting|reading)|i am (checking|looking|pulling|working)|working on|got it|sure|let me|one moment|give me a (moment|sec|second|minute))`)
)

// plain turns HTML into readable text with links kept, for a source that hands replies over as HTML.
func plain(html string) string {
	text := anchor.ReplaceAllStringFunc(html, func(match string) string {
		parts := anchor.FindStringSubmatch(match)
		href, label := parts[1], parts[2]
		if anyTag.ReplaceAllString(label, "") == href {
			return href
		}
		return label + " (" + href + ")"
	})
	text = lineBreak.ReplaceAllString(text, "\n")
	text = listItem.ReplaceAllString(text, "- ")
	text = blockEnd.ReplaceAllString(text, "\n")
	text = anyTag.ReplaceAllString(text, "")
	// &amp; goes last, so "&amp;lt;" stays the text "&lt;".
	text = strings.ReplaceAll(entities.Replace(text), "&amp;", "&")
	text = looseItem.ReplaceAllString(text, "\n- ")
	text = blankLines.ReplaceAllString(text, "\n\n")
	return handoff.TrimSpace(text)
}

// isAck reports whether a reply only says the bot has started.
func isAck(text string) bool {
	start := ackStart.ReplaceAllString(text, "")
	return utf16Len(start) < 200 && ack.MatchString(start)
}

// bySortKey orders messages as their cursors do.
func bySortKey(a, b message) int {
	return strings.Compare(a.SortKey, b.SortKey)
}

type busyState struct {
	busy   bool
	reason string
}

func seconds(ms float64) string {
	return formatNumber(jsRound(ms/1000)) + "s"
}

// busy says whether a bot is still working, judged from the chat itself, so it survives restarts.
// "Out" is anything from Leon's account (Leon or Hermes).
//
// windowed means the messages are only the last busyWindowMS of the chat.
func busy(messages []message, now int64, windowed bool) busyState {
	list := make([]message, 0, len(messages))
	for _, line := range messages {
		if !line.IsDeleted {
			list = append(list, line)
		}
	}
	slices.SortStableFunc(list, bySortKey)
	lastOut := -1
	for index, line := range list {
		if line.IsSender {
			lastOut = index
		}
	}
	at := func(line message) float64 { return parseTime(line.Timestamp) }
	if lastOut < 0 {
		// windowed: Leon's message may be older than the window. Every rule that needs it has expired
		// by then; a bot still posting hasn't.
		if windowed && len(list) > 0 {
			if age := float64(now) - at(list[len(list)-1]); age < quietMS {
				return busyState{true, "the bot posted " + seconds(age) + " ago and may still be sending"}
			}
		}
		if windowed {
			return busyState{false, "nothing from Leon in this chat lately, and the bot is quiet"}
		}
		return busyState{false, "no message from Leon in this chat yet"}
	}
	outAge := float64(now) - at(list[lastOut])
	var replies []message
	for _, line := range list[lastOut+1:] {
		if !line.IsSender {
			replies = append(replies, line)
		}
	}
	if len(replies) == 0 {
		if outAge < noReplyBusyMS {
			return busyState{true, "no reply yet to the last message, sent " + seconds(outAge) + " ago"}
		}
		return busyState{false, "the last message got no reply in " + seconds(outAge) + "; treating the bot as idle"}
	}
	quiet := float64(now) - at(replies[len(replies)-1])
	if quiet < quietMS {
		return busyState{true, "the bot posted " + seconds(quiet) + " ago and may still be sending"}
	}
	onlyAcks := !slices.ContainsFunc(replies, func(line message) bool { return !isAck(line.Text) })
	if onlyAcks && quiet < ackQuietMS && outAge < ackWindowMS {
		return busyState{true, "the bot has only acknowledged so far (" + seconds(quiet) + " ago) and is probably still working"}
	}
	return busyState{false, "the bot finished replying " + seconds(quiet) + " ago"}
}

// compose writes the message for a batch of queued items. One item goes out unchanged; several
// become one numbered message, in Leon's lowercase voice. Then comes the handoff block of each Slack
// thread the items carry, once per thread.
func compose(items []queuedItem) string {
	var kept []queuedItem
	for _, item := range items {
		item.Text = handoff.TrimSpace(item.Text)
		if item.Text != "" {
			kept = append(kept, item)
		}
	}
	body := ""
	switch {
	case len(kept) == 1:
		body = kept[0].Text
	case len(kept) > 1:
		numbered := make([]string, len(kept))
		for index, item := range kept {
			numbered[index] = strconv.Itoa(index+1) + ". " + item.Text
		}
		body = "a few more things, in order:\n\n" + strings.Join(numbered, "\n\n")
	}
	type entry struct {
		thread   handoff.SlackThread
		items    []int
		followUp bool
	}
	var threads []*entry
	byKey := map[string]*entry{}
	for index, item := range kept {
		key := handoff.Identifier(item.Thread)
		found := byKey[key]
		if found == nil {
			found = &entry{thread: item.Thread, followUp: true}
			byKey[key] = found
			threads = append(threads, found)
		}
		found.items = append(found.items, index+1)
		found.followUp = found.followUp && item.FollowUp
	}
	parts := []string{body}
	for _, found := range threads {
		switch {
		case found.followUp:
			parts = append(parts, handoff.GrokFollowUpBlock(found.thread))
		case len(kept) > 1 && len(threads) > 1:
			parts = append(parts, handoff.GrokBlock(found.thread, found.items))
		default:
			parts = append(parts, handoff.GrokBlock(found.thread, nil))
		}
	}
	return strings.Join(parts, "\n\n")
}

// takeBatch is the longest prefix of the queue whose composed message fits in max characters (at
// least one item).
func takeBatch(items []queuedItem, max int) []queuedItem {
	count := 1
	for count < len(items) && utf16Len(compose(items[:count+1])) <= max {
		count++
	}
	return slices.Clone(items[:min(count, len(items))])
}

// pruneBudget is the budget state, pruned to the last hour.
func pruneBudget(state budgetState, now int64) budgetState {
	fresh := func(at string) bool { return float64(now)-parseTime(at) < hourMS }
	pruned := budgetState{Sends: []string{}, Urgent: []string{}, Extensions: []budgetExtension{}}
	for _, at := range state.Sends {
		if fresh(at) {
			pruned.Sends = append(pruned.Sends, at)
		}
	}
	for _, at := range state.Urgent {
		if fresh(at) {
			pruned.Urgent = append(pruned.Urgent, at)
		}
	}
	for _, extended := range state.Extensions {
		if fresh(extended.At) {
			pruned.Extensions = append(pruned.Extensions, extended)
		}
	}
	return pruned
}

type budgetReport struct {
	used            int
	limit           int
	remaining       int
	urgentOver      int
	resetsInMinutes int
}

func budgetStatus(state budgetState, now int64) budgetReport {
	pruned := pruneBudget(state, now)
	report := budgetReport{
		used:       len(pruned.Sends),
		limit:      hourlyBudget + extension*len(pruned.Extensions),
		urgentOver: len(pruned.Urgent),
	}
	report.remaining = max(0, report.limit-report.used)
	if report.used > 0 {
		report.resetsInMinutes = int(math.Ceil((hourMS - (float64(now) - parseTime(pruned.Sends[0]))) / 60000))
	}
	return report
}

func recordSend(state budgetState, now int64, urgent bool) budgetState {
	pruned := pruneBudget(state, now)
	at := isoTime(now)
	pruned.Sends = append(pruned.Sends, at)
	if urgent && budgetStatus(state, now).remaining <= 0 {
		pruned.Urgent = append(pruned.Urgent, at)
	}
	return pruned
}

// extendBudget adds extension sends for the next hour on Leon's approval. It only applies once the
// budget is used up.
func extendBudget(state budgetState, quote any, now int64) (budgetState, bool, error) {
	words, _ := quote.(string)
	words = handoff.TrimSpace(words)
	if utf16Len(words) < 8 {
		return budgetState{}, false, errors.New("leon_approved_more must quote Leon's own words approving more messages")
	}
	pruned := pruneBudget(state, now)
	if budgetStatus(pruned, now).remaining > 0 {
		return pruned, false, nil
	}
	pruned.Extensions = append(pruned.Extensions, budgetExtension{At: isoTime(now), Quote: utf16Prefix(words, 500)})
	return pruned, true, nil
}

func budgetExceededMessage(status budgetReport, botName, text string) string {
	return fmt.Sprintf("Hourly budget reached: %d of %d relayed Grok bot messages in the last hour (frees up in about %d min). ", status.used, status.limit, status.resetsInMinutes) +
		"Grok usage is limited, so Leon wants to be asked before more go out. Ask Leon in Slack (his DM or the task thread) whether to keep going, " +
		"and quote what you still need to send to " + botName + `: "` + utf16Prefix(handoff.TrimSpace(text), 300) + `". Do not retry until he answers. ` +
		fmt.Sprintf("If he says yes, call grok_bot_send again with leon_approved_more set to his exact words; that allows %d more this hour.", extension)
}

// guardBot lets Linear Bot and Todoist Bot through only for what Hermes's own linear and todoist MCP
// tools can't do. It returns the reason given, or "" for any other bot.
func guardBot(botName string, needsBotBecause any) (string, error) {
	if !slices.Contains(bookkeepingBots, strings.ToLower(botName)) {
		return "", nil
	}
	why, _ := needsBotBecause.(string)
	why = handoff.TrimSpace(why)
	if utf16Len(why) < minJustification {
		return "", errors.New("Linear and Todoist go through your own linear/todoist MCP tools (Leon's rule, 2026-11-07), not this bot. " +
			"Only message it for something those tools can't do, and say what in needs_bot_because.")
	}
	return why, nil
}
