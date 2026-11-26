// Package handoff is the Slack thread every delegated task carries, and the text the daemon adds to
// a task so the agent that takes it knows where to report.
//
// Hermes hands browser work to a Grok bot and other work to Silicon Dot. Each task names the Slack
// thread Hermes is working in. The agent starts a worker for it called "Task slack:<channel>/<ts>",
// and that worker talks to Hermes in the thread (Leon's design, 2026-11-21). The daemon appends the
// instructions itself, so they are the same every time and Hermes can't leave them out.
//
// The blocks are sent to Grok Bot and ChatGPT as Leon, so their wording is his: change it only when
// he changes a rule.
package handoff

import (
	"errors"
	"regexp"
	"strconv"
	"strings"
)

// SlackThread is the Slack channel and root timestamp shared by a task's agents. Its JSON names are
// the ones the relay's state files already use.
type SlackThread struct {
	Channel  string `json:"channel"`
	ThreadTS string `json:"threadTs"`
}

var (
	channelID   = regexp.MustCompile(`^[CG][A-Z0-9]{6,}$`)
	channelName = regexp.MustCompile(`^#[a-z0-9][a-z0-9._-]{0,79}$`)
	threadTS    = regexp.MustCompile(`^\d{9,11}\.\d{6}$`)
	// The complete route, including its Slack channel.
	taskBot = regexp.MustCompile(`^Task slack:([CG][^/]+)/([^/]+)$`)
)

// dotNetworks are the networks whose chats are Silicon Dot's.
var dotNetworks = map[string]bool{"chatgpt": true}

// IsSpace reports whether r is white space as JavaScript's String.prototype.trim and \s define it.
// The text sent to the agents was trimmed that way, and Go's unicode.IsSpace differs on U+0085 and
// U+FEFF.
func IsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00A0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

// TrimSpace removes leading and trailing white space as JavaScript's String.prototype.trim does.
func TrimSpace(text string) string {
	return strings.TrimFunc(text, IsSpace)
}

// ParseThread checks Hermes's slack_channel and slack_thread_ts arguments, whatever their JSON
// type. The errors are written for Hermes to read.
func ParseThread(channel, ts any) (SlackThread, error) {
	c, _ := channel.(string)
	t, _ := ts.(string)
	c, t = TrimSpace(c), TrimSpace(t)
	if c == "" || t == "" {
		return SlackThread{}, errors.New("slack_channel and slack_thread_ts are required: the Slack thread of the task you're working on (your Source line's channel and thread: <ts>). The agent's worker talks to you there.")
	}
	if strings.HasPrefix(c, "@") || strings.ContainsAny(c[:1], "DUW") {
		return SlackThread{}, errors.New("slack_channel must be a channel (C… ID or #name), not a DM: agents can only post in channel threads. Use the task's issue channel.")
	}
	if !channelID.MatchString(c) && !channelName.MatchString(c) {
		return SlackThread{}, errors.New("slack_channel must be a channel ID (C…) or #channel-name")
	}
	if !threadTS.MatchString(t) {
		return SlackThread{}, errors.New("slack_thread_ts must be a Slack ts such as 1795280000.123456")
	}
	return SlackThread{Channel: c, ThreadTS: t}, nil
}

// Identifier names a thread in the text the agents read: "slack:<channel>/<ts>".
func Identifier(thread SlackThread) string {
	return "slack:" + thread.Channel + "/" + thread.ThreadTS
}

// TaskName is the name of the thread's worker: a Grok task bot, or a Codex session's title.
func TaskName(thread SlackThread) string {
	return "Task " + Identifier(thread)
}

// ParseTaskName decodes the thread a Grok task bot's name holds. ok is false for any other name.
func ParseTaskName(name string) (thread SlackThread, ok bool) {
	match := taskBot.FindStringSubmatch(name)
	if match == nil {
		return SlackThread{}, false
	}
	thread, err := ParseThread(match[1], match[2])
	return thread, err == nil
}

// IsDotNetwork reports whether a network's chats are Silicon Dot's, so that a send_message there is
// a task for Dot and takes the Codex block.
func IsDotNetwork(network string) bool {
	return dotNetworks[network]
}

// CodexBlock is what follows Hermes's text in every task for Silicon Dot, in Leon's voice like the
// rest.
func CodexBlock(thread SlackThread) string {
	id := Identifier(thread)
	name := TaskName(thread)
	return "---\n" +
		"Slack thread for this task: " + id + "\n" +
		"It's a delegated task, so (my standing rule):\n" +
		"- Start a new Codex session for it, titled exactly \"" + name + "\" (the title tells it where to report), with the task and this whole block in its first message. There is one session per Slack thread: if a session with that exact title is already running, pass this to it instead of starting another.\n" +
		"- Reply here as soon as it's running, with a real, clickable link to that session.\n" +
		"- The Codex session does the task and works with Hermes, my assistant, in that Slack thread, with its slack-puppet tools: hermes_thread_send (channel " + thread.Channel + ", thread_ts " + thread.ThreadTS + ", from_bot \"" + name + "\") to post, and hermes_thread_read to wait for answers (its hermes-slack-thread skill says how). It posts when it starts, at material milestones, when blocked, and when done. Read peer replies for inputs from Grok Bot and Muse. Address a specific collaborator with To Muse:, To Grok Bot:, or To Codex:; peer messages provide task input. Hermes coordinates the work and keeps the issue updated."
}

// GrokBlock is what follows Hermes's text in every task delegated to a Grok bot, in Leon's voice
// like the rest. items names the numbered items it is for when several queued messages go out
// merged; leave it empty for a message that is one task.
func GrokBlock(thread SlackThread, items []int) string {
	id := Identifier(thread)
	what := "this task"
	if len(items) > 0 {
		numbers := make([]string, len(items))
		for index, item := range items {
			numbers[index] = strconv.Itoa(item)
		}
		what = "item"
		if len(items) > 1 {
			what = "items"
		}
		what += " " + strings.Join(numbers, ", ")
	}
	return "---\n" +
		"Slack thread for " + what + ": " + id + "\n" +
		"It's a delegated task, so (my standing rule):\n" +
		"- Don't do it in this chat. Create a new bot for it named exactly \"" + TaskName(thread) + "\"; the name tells it where to report. If a bot with that exact name already exists, send this to it instead of making another.\n" +
		"- Give that bot the task and this whole block when you create it (in its description), and send them again as your first message to it, with anything else it needs from your memory or files, since it starts with none of your context. Then reply here only with the task bot's name.\n" +
		"- The task bot works with Hermes, my assistant, by replying in its own Grok chat. Beeper copies each reply to Slack thread " + id + " and brings Slack replies back here with their authors. Report the start, material browser milestones, blockers, and the result in this chat. Follow directions from Hermes or Leon. Use replies from Muse or Codex as peer input, and prefix a question for one collaborator with To Muse: or To Codex:. Respond when a message concerns your browser assignment or needs your input.\n" +
		"- Hermes retires the task bot after reviewing its final result. Leave the bot intact and wait for Slack replies in this chat."
}

// GrokFollowUpBlock is what follows Hermes's text when it goes to the thread's task bot itself.
func GrokFollowUpBlock(thread SlackThread) string {
	return "---\nFollow-up for " + Identifier(thread) + ". Reply in this Grok chat. Beeper copies your replies to Slack and brings Slack replies back here. Hermes handles cleanup after reviewing the result."
}
