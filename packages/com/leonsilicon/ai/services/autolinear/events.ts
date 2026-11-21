import { CLIENT_MSG_ID_PREFIX } from "@-/com.leonsilicon.ai.services.slack-as-leon";
import type { AutolinearConfig } from "#config";
import type { IntakeMessage, SlackFileRef } from "#intake";

/** A `message` event as Slack's Events API sends it for Leon's own (user) event subscriptions. */
export interface SlackMessageEvent {
  type?: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  client_msg_id?: string;
  blocks?: unknown[];
  files?: (SlackFileRef & Record<string, unknown>)[];
}

/** What reading an event needs to look up: Leon's DM with Hermes, and a channel's name. */
export interface EventLookups {
  hermesDmId(): Promise<string | null>;
  channelName(channelId: string): Promise<string | null>;
}

const SLACK_TS = /^\d{10}\.\d{6}$/;
const MENTION = /<@([UW][A-Z0-9]+)/g;

/**
 * The cheap checks, no lookups: is this event one of Leon's messages that Hermes is sure to answer?
 * His own words (not a bot's, not an agent's post as him, not an edit or a join), no command, and no
 * mention of anyone but Hermes (Hermes ignores messages addressed to someone else). Returns where it
 * is: his DM, or a public channel (Hermes is in every one). Anything else, a private channel or a
 * group DM included, waits for Hermes's own call.
 */
export function fastPathKind(
  event: SlackMessageEvent | undefined,
  config: AutolinearConfig,
): "dm" | "channel" | null {
  if (event?.type !== "message") return null;
  if (event.subtype && event.subtype !== "file_share" && event.subtype !== "thread_broadcast")
    return null;
  if (event.user !== config.leonUserId || event.bot_id) return null;
  if (event.client_msg_id?.startsWith(`${CLIENT_MSG_ID_PREFIX}-`)) return null;
  if (!event.channel || !event.ts || !SLACK_TS.test(event.ts)) return null;
  if (config.skipChannels.includes(event.channel)) return null;
  const text = event.text ?? "";
  if (/^\s*[/!]/.test(text)) return null;
  for (const [, user] of text.matchAll(MENTION)) if (user !== config.hermesUserId) return null;
  if (event.channel_type === "im") return "dm";
  if (event.channel_type === "channel") return "channel";
  return null;
}

/**
 * The intake for an event's message, or null when Hermes's own call should decide instead: the
 * cheap checks above, then the lookups. A DM must be the one with Hermes; a channel must not be an
 * issue channel (`leon-<number>…`), where Hermes answers in place.
 */
export async function messageFromEvent(
  event: SlackMessageEvent | undefined,
  config: AutolinearConfig,
  lookups: EventLookups,
): Promise<IntakeMessage | null> {
  const kind = fastPathKind(event, config);
  if (!kind || !event) return null;
  const channel = event.channel!;
  let place: string;
  if (kind === "dm") {
    if (channel !== (await lookups.hermesDmId())) return null;
    place = "a DM with Hermes";
  } else {
    const name = await lookups.channelName(channel);
    if (!name || new RegExp(`^${config.channelPrefix}-\\d+(?:-|$)`).test(name)) return null;
    place = `#${name}`;
  }
  const reply = Boolean(event.thread_ts && event.thread_ts !== event.ts);
  return {
    channel,
    ts: event.ts!,
    threadTs: reply ? event.thread_ts! : null,
    user: event.user!,
    text: event.text ?? "",
    where: reply ? `a thread in ${place}` : place,
    ...(Array.isArray(event.blocks) ? { blocks: event.blocks } : {}),
    ...(event.files?.length
      ? {
          files: event.files.map((f) => ({
            name: typeof f.name === "string" ? f.name : "",
            title: typeof f.title === "string" ? f.title : "",
            permalink: typeof f.permalink === "string" ? f.permalink : "",
          })),
        }
      : {}),
  };
}
