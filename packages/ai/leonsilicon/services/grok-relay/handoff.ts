/**
 * Every task Hermes hands a Grok bot carries the Slack thread Hermes is working in. The bot makes a
 * task bot for it whose name holds that thread, `Task slack:<channel>/<thread_ts>`, and the task bot
 * talks to Hermes there through slack-puppet's Grok tools (Leon's design, 2026-11-21). The relay
 * appends the instructions itself, so they are the same every time and Hermes can't leave them out.
 */

import {
  slackIdentifier,
  slackThread,
  taskName,
  type SlackThread,
} from "@-/ai.leonsilicon.services.beeper-inbox";

// The thread check and identifier are shared with the inbox's send_message (Silicon Dot's chats).
export { slackIdentifier, slackThread };
export type { SlackThread };

/** The task bot's name: the thread is in it, so the bot knows where to report. */
export const taskBotName = taskName;

/**
 * What follows Hermes's text in every delegated task, in Leon's voice like the rest. `items` names
 * the numbered items it is for when several queued messages go out merged.
 */
export function handoffBlock(thread: SlackThread, items?: readonly number[]): string {
  const id = slackIdentifier(thread);
  const name = taskBotName(thread);
  const what =
    items && items.length ? `item${items.length > 1 ? "s" : ""} ${items.join(", ")}` : "this task";
  return `---
Slack thread for ${what}: ${id}
It's a delegated task, so (my standing rule):
- Don't do it in this chat. Create a new bot for it named exactly "${name}"; the name tells it where to report. There is one bot per Slack thread: if a bot whose name ends in "/${thread.threadTs}" already exists, send this to it instead of making another.
- Give that bot the task and this whole block when you create it (in its description), and send them again as your first message to it, with anything else it needs from your memory or files, since it starts with none of your context. Then reply here only with the task bot's name.
- The task bot does the task and works with Hermes, my assistant, in that Slack thread, with the slack-puppet tools: hermes_thread_send (channel ${thread.channel}, thread_ts ${thread.threadTs}, from_bot its own name) to post, and hermes_thread_read to wait for answers. It doesn't post there before it has the task; then it posts when it starts (what it's doing), whenever it needs something, and when it's done. Hermes's answers there count as mine.
- When the task is done and Hermes has said so, the task bot deletes itself with grokbot-admin's grok_bot_delete (its own agent ID).`;
}

/** True for the task bot of this thread: its name ends in the thread's ts (one bot per thread). */
export function isTaskBotFor(name: string, thread: SlackThread): boolean {
  const n = name.trim();
  return n.startsWith("Task slack:") && n.endsWith(`/${thread.threadTs}`);
}

/** What follows Hermes's text when it goes to the thread's task bot itself. */
export function followUpBlock(thread: SlackThread): string {
  return `---
Follow-up for your task in Slack thread ${slackIdentifier(thread)}: carry on there with Hermes, my assistant, through hermes_thread_send (channel ${thread.channel}, thread_ts ${thread.threadTs}) and hermes_thread_read, as before.`;
}

/** Hermes's text with the handoff block after it. */
export const withHandoff = (text: string, thread: SlackThread) =>
  `${text.trim()}\n\n${handoffBlock(thread)}`;
