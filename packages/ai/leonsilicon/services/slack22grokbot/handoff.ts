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
export { slackIdentifier, slackThread, taskName };
export type { SlackThread };

/** Decode the complete route, including its Slack channel. */
export function parseTaskBotName(name: string): SlackThread | undefined {
  const match = /^Task slack:([CG][^/]+)\/([^/]+)$/.exec(name);
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
export function handoffBlock(thread: SlackThread, items?: readonly number[]): string {
  const id = slackIdentifier(thread);
  const name = taskName(thread);
  const what =
    items && items.length ? `item${items.length > 1 ? "s" : ""} ${items.join(", ")}` : "this task";
  const conversation = `- The task bot works with Hermes, my assistant, by replying in its own Grok chat. Beeper copies each reply to Slack thread ${id} and brings Slack replies back here with their authors. Report the start, material browser milestones, blockers, and the result in this chat. Follow directions from Hermes or Leon. Use replies from Muse or Codex as peer input, and prefix a question for one collaborator with To Muse: or To Codex:. Respond when a message concerns your browser assignment or needs your input.
- Hermes retires the task bot after reviewing its final result. Leave the bot intact and wait for Slack replies in this chat.`;
  return `---
Slack thread for ${what}: ${id}
It's a delegated task, so (my standing rule):
- Don't do it in this chat. Create a new bot for it named exactly "${name}"; the name tells it where to report. If a bot with that exact name already exists, send this to it instead of making another.
- Give that bot the task and this whole block when you create it (in its description), and send them again as your first message to it, with anything else it needs from your memory or files, since it starts with none of your context. Then reply here only with the task bot's name.
${conversation}`;
}

/** What follows Hermes's text when it goes to the thread's task bot itself. */
export function followUpBlock(thread: SlackThread): string {
  return `---\nFollow-up for ${slackIdentifier(thread)}. Reply in this Grok chat. Beeper copies your replies to Slack and brings Slack replies back here. Hermes handles cleanup after reviewing the result.`;
}
