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

/** Decode the complete route, including its Slack channel. */
export function parseTaskBotName(name: string): SlackThread | undefined {
  const match = /^Task slack:([^/]+)\/([^/]+)$/.exec(name);
  if (!match) return undefined;
  try {
    return slackThread(match[1], match[2]);
  } catch {
    return undefined;
  }
}

/**
 * What follows Hermes's text in every delegated task, in Leon's voice like the rest. `items` names
 * the numbered items it is for when several queued messages go out merged.
 */
export function handoffBlock(
  thread: SlackThread,
  items?: readonly number[],
  automatic = false,
): string {
  const id = slackIdentifier(thread);
  const name = taskBotName(thread);
  const what =
    items && items.length ? `item${items.length > 1 ? "s" : ""} ${items.join(", ")}` : "this task";
  const conversation = automatic
    ? `- The task bot works with Hermes, my assistant, by replying in its own Grok chat. Beeper copies every reply to Slack thread ${id} and brings Slack replies back here with their authors. Do not use slack-puppet to post duplicates or wait for replies. Send progress, questions and your final result in this chat. Treat a relayed reply identified as from Hermes or Leon as my answer, and distinguish it from other authors.
- Hermes retires the task bot after reviewing its final result. Leave the bot intact and wait for Slack replies in this chat.`
    : `- The task bot does the task and works with Hermes, my assistant, in that Slack thread, with the slack-puppet tools: hermes_thread_send (channel ${thread.channel}, thread_ts ${thread.threadTs}, from_bot its own name) to post, and hermes_thread_read to wait for answers. It doesn't post there before it has the task; then it posts when it starts (what it's doing), whenever it needs something, and when it's done. Hermes's answers there count as mine.
- When the task is done and Hermes has said so, the task bot deletes itself with grokbot-admin's grok_bot_delete (its own agent ID).`;
  return `---
Slack thread for ${what}: ${id}
It's a delegated task, so (my standing rule):
- Don't do it in this chat. Create a new bot for it named exactly "${name}"; the name tells it where to report. If a bot with that exact name already exists, send this to it instead of making another.
- Give that bot the task and this whole block when you create it (in its description), and send them again as your first message to it, with anything else it needs from your memory or files, since it starts with none of your context. Then reply here only with the task bot's name.
${conversation}`;
}

/** True for the task bot named for this precise Slack channel and thread. */
export function isTaskBotFor(name: string, thread: SlackThread): boolean {
  return name === taskBotName(thread);
}

/** What follows Hermes's text when it goes to the thread's task bot itself. */
export function followUpBlock(thread: SlackThread, automatic = false): string {
  if (automatic)
    return `---\nFollow-up for ${slackIdentifier(thread)}. Reply in this Grok chat. Beeper copies your replies to Slack and brings Slack replies back here. Hermes handles cleanup after reviewing the result.`;
  return `---
Follow-up for your task in Slack thread ${slackIdentifier(thread)}: carry on there with Hermes, my assistant, through hermes_thread_send (channel ${thread.channel}, thread_ts ${thread.threadTs}) and hermes_thread_read, as before.`;
}

/** Hermes's text with the handoff block after it. */
export const withHandoff = (text: string, thread: SlackThread) =>
  `${text.trim()}\n\n${handoffBlock(thread)}`;
