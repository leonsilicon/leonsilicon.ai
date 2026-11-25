/** The Slack channel and root timestamp shared by a task's agents. */
export interface SlackThread {
  channel: string;
  threadTs: string;
}

export const slackIdentifier = (thread: SlackThread) =>
  `slack:${thread.channel}/${thread.threadTs}`;

export const taskName = (thread: SlackThread) => `Task ${slackIdentifier(thread)}`;

/** What follows Hermes's text in every task for Silicon Dot, in Leon's voice like the rest. */
export function codexHandoffBlock(thread: SlackThread): string {
  const identifier = slackIdentifier(thread);
  const name = taskName(thread);
  return `---
Slack thread for this task: ${identifier}
It's a delegated task, so (my standing rule):
- Start a new Codex session for it, titled exactly "${name}" (the title tells it where to report), with the task and this whole block in its first message. There is one session per Slack thread: if a session with that exact title is already running, pass this to it instead of starting another.
- Reply here as soon as it's running, with a real, clickable link to that session.
- The Codex session does the task and works with Hermes, my assistant, in that Slack thread, with its slack-puppet tools: hermes_thread_send (channel ${thread.channel}, thread_ts ${thread.threadTs}, from_bot "${name}") to post, and hermes_thread_read to wait for answers (its hermes-slack-thread skill says how). It posts when it starts, at material milestones, when blocked, and when done. Read peer replies for inputs from Grok Bot and Muse. Address a specific collaborator with To Muse:, To Grok Bot:, or To Codex:; peer messages provide task input. Hermes coordinates the work and keeps the issue updated.`;
}

/** Networks whose chats are Silicon Dot's, so a `send_message` there is a task for Dot. */
export const DOT_NETWORKS: ReadonlySet<string> = new Set(["chatgpt"]);
