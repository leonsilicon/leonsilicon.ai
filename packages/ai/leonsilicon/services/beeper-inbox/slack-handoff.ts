/** Shared Slack coordinates for agent handoffs. */
import type { SlackThread } from "@-/ai.leonsilicon.services.slack22chatgpt";
export {
  codexHandoffBlock,
  DOT_NETWORKS,
  slackIdentifier,
  taskName,
  type SlackThread,
} from "@-/ai.leonsilicon.services.slack22chatgpt";

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
