import { tolerate, type SlackCall } from "@-/ai.leonsilicon.services.slack22linear";

const CHANNEL_ID = /^[CG][A-Z0-9]{6,}$/;
const MESSAGE_TS = /^\d{10}\.\d{6}$/;
const FEED_NAME = /^feed-[a-z0-9_-]+$/;
const NEW_MESSAGES = new Set([
  "bot_message",
  "file_share",
  "me_message",
  "thread_broadcast",
  "reply_broadcast",
]);
const MAX_TEXT = 4_000;

export interface FeedEvent {
  channel: string;
  ts: string;
  threadTs: string | null;
  text: string;
  files: string[];
}

export interface FeedMessage extends FeedEvent {
  name: string;
  museRun?: { scheduleId: string; runId: string };
}

/** Only Hermes's own top-level posts in #feed-muse carry scheduled runs. */
export function museRun(
  source: FeedMessage,
  event: Record<string, unknown>,
  hermesUserId: unknown,
): FeedMessage["museRun"] {
  if (
    source.name !== "feed-muse" ||
    source.threadTs ||
    !hermesUserId ||
    event.user !== hermesUserId ||
    typeof event.bot_id !== "string" ||
    !event.bot_id
  )
    return undefined;
  return readMuseRun(source.text);
}

export function readMuseRun(text: string): FeedMessage["museRun"] {
  const match =
    /^Muse (?:reminder|routine) due: [^\n]+\nMuse schedule: ([\w.-]{1,200})\nMuse run: ([\w.:-]{1,200})$/.exec(
      text,
    );
  return match ? { scheduleId: match[1]!, runId: match[2]! } : undefined;
}

/** Slack bots post most feeds. Only accept new channel messages, including actual thread replies. */
export function feedEvent(event?: Record<string, unknown>): FeedEvent | null {
  if (
    event?.type !== "message" ||
    (event.channel_type !== "channel" && event.channel_type !== "group")
  )
    return null;
  if (event.subtype && (typeof event.subtype !== "string" || !NEW_MESSAGES.has(event.subtype)))
    return null;
  const { channel, ts, thread_ts: threadTs } = event;
  if (typeof channel !== "string" || !CHANNEL_ID.test(channel)) return null;
  if (typeof ts !== "string" || !MESSAGE_TS.test(ts)) return null;
  if (threadTs != null && (typeof threadTs !== "string" || !MESSAGE_TS.test(threadTs))) return null;

  const text = typeof event.text === "string" ? event.text.trim().slice(0, MAX_TEXT) : "";
  const files = Array.isArray(event.files)
    ? event.files.slice(0, 10).flatMap((file) => {
        const name: unknown = file?.title || file?.name;
        return typeof name === "string" ? [name.slice(0, 200)] : [];
      })
    : [];
  if (!text && !files.length) return null;
  return { channel, ts, threadTs: threadTs && threadTs !== ts ? threadTs : null, text, files };
}

interface FeedChannel {
  name?: string;
  is_archived?: boolean;
  is_ext_shared?: boolean;
}

/** Resolve by Slack's channel ID. Cache names briefly so renames and quarantines take effect. */
export async function feedMessage(
  event: FeedEvent,
  slack: SlackCall,
  cache: Map<string, { channel: FeedChannel; until: number }>,
  heldChannels: readonly (string | undefined)[],
): Promise<FeedMessage | null> {
  const held = [
    "feed-flagged",
    "feed-spam",
    ...heldChannels.map((value) => value?.trim().replace(/^#/, "")),
  ];
  if (held.includes(event.channel)) return null;
  const cached = cache.get(event.channel);
  let channel = cached?.channel;
  if (!cached || cached.until < Date.now()) {
    const response = await tolerate(slack("conversations.info", { channel: event.channel }), [
      "channel_not_found",
      "not_in_channel",
    ]);
    channel = (response?.channel as FeedChannel | undefined) ?? {};
    if (cache.size >= 2_000) cache.clear();
    cache.set(event.channel, { channel, until: Date.now() + 60_000 });
  }
  const name = channel?.name;
  if (
    !name ||
    !FEED_NAME.test(name) ||
    channel?.is_archived ||
    channel?.is_ext_shared ||
    held.includes(name)
  )
    return null;
  return { ...event, name };
}
