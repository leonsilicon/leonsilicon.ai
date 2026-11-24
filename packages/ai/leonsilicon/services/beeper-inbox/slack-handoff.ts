/**
 * Every task Hermes hands another agent carries the Slack thread Hermes is working in (Leon's
 * design, 2026-11-21). The agent starts a worker for the task whose name holds that thread,
 * `Task slack:<channel>/<thread_ts>`, and the worker talks to Hermes there through slack-puppet. The
 * slack22grokbot does this for Grok bots; `send_message` does it for Silicon Dot's chats, whose workers
 * are Codex sessions. The instructions are appended here, so they are the same every time.
 */

/** The Slack thread of a task: a channel (ID or #name) and the thread's root ts. */
export interface SlackThread {
  channel: string;
  threadTs: string;
}

const CHANNEL_ID = /^[CG][A-Z0-9]{6,}$/;
const CHANNEL_NAME = /^#[a-z0-9][a-z0-9._-]{0,79}$/;
const TS = /^\d{9,11}\.\d{6}$/;

/** Checks Hermes's `slack_channel` and `slack_thread_ts`, with messages written for Hermes. */
export function slackThread(channel: unknown, threadTs: unknown): SlackThread {
  const c = typeof channel === "string" ? channel.trim() : "";
  const t = typeof threadTs === "string" ? threadTs.trim() : "";
  if (!c || !t)
    throw new Error(
      "slack_channel and slack_thread_ts are required: the Slack thread of the task you're working on (your Source line's channel and thread: <ts>). The agent's worker talks to you there.",
    );
  if (/^[DUW]/.test(c) || c.startsWith("@"))
    throw new Error(
      "slack_channel must be a channel (C… ID or #name), not a DM: agents can only post in channel threads. Use the task's issue channel.",
    );
  if (!CHANNEL_ID.test(c) && !CHANNEL_NAME.test(c))
    throw new Error("slack_channel must be a channel ID (C…) or #channel-name");
  if (!TS.test(t)) throw new Error("slack_thread_ts must be a Slack ts such as 1795280000.123456");
  return { channel: c, threadTs: t };
}

/** `slack:<channel>/<thread_ts>`: how an agent names the thread. */
export const slackIdentifier = (thread: SlackThread) =>
  `slack:${thread.channel}/${thread.threadTs}`;

/** The worker's name (a task bot's, a Codex session's title): the thread is in it. */
export const taskName = (thread: SlackThread) => `Task ${slackIdentifier(thread)}`;

/** What follows Hermes's text in every task for Silicon Dot, in Leon's voice like the rest. */
export function codexHandoffBlock(thread: SlackThread): string {
  const name = taskName(thread);
  return `---
Slack thread for this task: ${slackIdentifier(thread)}
It's a delegated task, so (my standing rule):
- Start a new Codex session for it, titled exactly "${name}" (the title tells it where to report), with the task and this whole block in its first message. There is one session per Slack thread: if a session whose title ends in "/${thread.threadTs}" is already running, pass this to it instead of starting another.
- Reply here as soon as it's running, with a real, clickable link to that session.
- The Codex session does the task and works with Hermes, my assistant, in that Slack thread, with its slack-puppet tools: hermes_thread_send (channel ${thread.channel}, thread_ts ${thread.threadTs}, from_bot "${name}") to post, and hermes_thread_read to wait for answers (its hermes-slack-thread skill says how). It posts when it starts (what it's doing), whenever it needs a decision or something only Hermes or I have, and when it's done. Hermes's answers there count as mine.`;
}

/** Networks whose chats are Silicon Dot's, so a `send_message` there is a task for Dot. */
export const DOT_NETWORKS: ReadonlySet<string> = new Set(["chatgpt"]);
