import type { SlackAsLeonConfig } from "#config";
import { createHash } from "node:crypto";
import { Directory, linkBotMentions, type SlackUser } from "#directory";
import {
  agentOf,
  CLIENT_MSG_ID_PREFIX,
  GROK_BOT_GROUP,
  GROK_BRIDGE_GROUP,
  isMarked,
  newClientMsgId,
  type Agent,
  type Poster,
} from "#marker";
import { SlackError, type SlackCall, type SlackResponse } from "#slack";

/** A request the service won't carry out; the message says why and what to do instead. */
export class Refused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refused";
  }
}

/** A message this service posted. */
export interface SentRecord {
  channel: string;
  ts: string;
  /** Set when it was posted as a reply in an existing thread. */
  threadTs?: string;
  clientMsgId: string;
}

export interface Reply {
  ts: string;
  /**
   * "you" for the caller's own posts through this service; "hermes" (Hermes posting as Leon),
   * "grok_bot" or "codex" (an agent posting as Leon) for the others; then "leon", "bot" or "person".
   */
  from: "you" | "hermes" | "grok_bot" | "codex" | "leon" | "bot" | "person";
  author: string;
  userId?: string;
  text: string;
  /** Top level of a DM rather than the thread. */
  topLevel?: boolean;
  edited?: boolean;
  files?: string[];
}

export interface SendArgs {
  channel: string;
  text: string;
  thread_ts?: string;
  wait_seconds?: number;
  /** An agent's own name (bot name or Codex session title), shown on its post; agents only. */
  from_bot?: string;
}

export interface ReadArgs {
  channel: string;
  ts: string;
  after?: string;
  wait_seconds?: number;
}

export interface Conversation {
  replies: Reply[];
  /** Latest ts seen; pass it as `after` to get only newer messages. */
  cursor: string;
  waited_seconds: number;
  /** True once someone other than Leon has answered (for an agent: Hermes, or Leon himself). */
  answered: boolean;
}

export interface SendResult extends Conversation {
  ok: true;
  channel: string;
  ts: string;
  thread_ts: string;
  permalink?: string;
  /** A bot was mentioned or DMed, so the call waited for its reply by default. */
  addressed_to_bot: boolean;
  text_sent: string;
}

export interface ServiceOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  /** How long an answer must stay unchanged before a wait returns it. */
  settleMs?: number;
  /** Counts Grok bots' posts, apart from Hermes's (default: in memory). */
  grokRate?: RateStore;
  /** Counts Codex sessions' posts (default: in memory). */
  codexRate?: RateStore;
}

type Settings = Pick<SlackAsLeonConfig, "maxPerHour" | "blockedUsers" | "maxWaitSeconds"> &
  Partial<Pick<SlackAsLeonConfig, "grokMaxPerHour" | "codexMaxPerHour">>;

/** Counts posts for the hourly limit. Entries older than an hour may be forgotten. */
export interface RateStore {
  /** Posts made at or after `sinceMs`. */
  count(sinceMs: number): Promise<number>;
  add(atMs: number, id: string): Promise<void>;
}

/** A RateStore that lives in memory (tests, or a single long-lived process). */
export function memoryRateStore(): RateStore {
  let posts: number[] = [];
  return {
    count: async (sinceMs) => posts.filter((at) => at >= sinceMs).length,
    add: async (atMs) => {
      posts = [...posts.filter((at) => atMs - at < HOUR_MS), atMs];
    },
  };
}

interface RawMessage {
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  client_msg_id?: string;
  text?: string;
  edited?: unknown;
  bot_profile?: { name?: string };
  username?: string;
  files?: { name?: string; title?: string; permalink?: string }[];
}

/**
 * What Hermes's gateway posts about itself rather than to anyone: the acknowledgement when a message
 * reaches a busy session ("⚡ Interrupting current task. I'll respond to your message shortly.", or
 * queued, steered, redirected, draining) and its working heartbeat, each opening with an emoji that
 * Slack may spell as a `:shortcode:`. Handed to a Grok bot or a Codex session as Hermes's reply,
 * one makes the agent stop and wait for Hermes, and spend a run saying so (Leon, 2026-11-25:
 * "don't do this").
 */
const GATEWAY_NOTICE =
  /^\s*(?::[a-z0-9_+-]+:|\p{Extended_Pictographic}\uFE0F?)\s*(?:Interrupting current task|Queued for the next turn|Steered into current run|Redirected current run|Subagent working|Compressing context|Gateway (?:restarting|shutting down|is )|Working —|Agent is running|Another turn is still running|Turn setup stalled|Still starting this turn|This agent is draining)/u;

/** A bot's post that is one of Hermes's gateway notices, never an answer. */
const isGatewayNotice = (raw: RawMessage): boolean =>
  Boolean(raw.bot_id || raw.subtype === "bot_message") &&
  !raw.files?.length &&
  GATEWAY_NOTICE.test(raw.text ?? "");

const CONVERSATION_ID = /^[CGD][A-Z0-9]{6,}$/;
const USER_ID = /^[UW][A-Z0-9]{6,}$/;
const TS = /^\d{9,11}\.\d{6}$/;
const BROADCAST = /<!(?:channel|here|everyone)(?:\|[^>]*)?>|(?:^|\s)@(?:channel|here|everyone)\b/i;
const MAX_TEXT = 12_000;
const MAX_BOT_NAME = 200;
const HOUR_MS = 3_600_000;

/** Slack timestamps as comparable integers (seconds and microseconds). */
export function tsKey(ts: string): bigint {
  const [seconds = "0", micros = "0"] = ts.split(".");
  return BigInt(seconds) * 1_000_000n + BigInt(micros.padEnd(6, "0").slice(0, 6));
}

const later = (a: string, b: string) => tsKey(a) > tsKey(b);

/** A string field from a Slack response, or "" when it is missing or not a string. */
const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** Posts to Slack as Leon and reads the answers to what it posted. */
export class SlackAsLeon {
  readonly directory: Directory;
  readonly #slack: SlackCall;
  readonly #settings: Settings;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #pollMs: number;
  readonly #settleMs: number;
  readonly #rate: RateStore;
  readonly #agentRates: Record<Agent, RateStore>;
  #leon?: Promise<string>;

  constructor(settings: Settings, slack: SlackCall, rate: RateStore, options: ServiceOptions = {}) {
    this.#slack = slack;
    this.#settings = settings;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#pollMs = options.pollMs ?? 3_000;
    this.#settleMs = options.settleMs ?? 8_000;
    this.directory = new Directory(slack, this.#now);
    this.#rate = rate;
    this.#agentRates = {
      grok: options.grokRate ?? memoryRateStore(),
      codex: options.codexRate ?? memoryRateStore(),
    };
  }

  /** Leon's user ID, from the session itself. */
  leonId(): Promise<string> {
    this.#leon ??= this.#slack("auth.test").then((auth) => {
      const id = str(auth.user_id);
      if (!id) throw new Error("Slack auth.test returned no user");
      return id;
    });
    void this.#leon.catch(() => (this.#leon = undefined));
    return this.#leon;
  }

  /** Whether the session still works: "ok", "invalid" (signed out or revoked) or "unknown". */
  async sessionState(): Promise<"ok" | "invalid" | "unknown"> {
    try {
      await this.#slack("auth.test");
      return "ok";
    } catch (error) {
      const code = error instanceof SlackError ? error.code : "";
      return ["invalid_auth", "not_authed", "account_inactive", "token_revoked"].includes(code)
        ? "invalid"
        : "unknown";
    }
  }

  /**
   * Posts as Leon. For Hermes (the default) anywhere Leon can, waiting for a bot it addresses. For an
   * agent (a Grok bot or a Codex session) only as a reply in a channel thread, labelled with its
   * name and marked so Hermes answers it, waiting for that answer.
   */
  async send(args: SendArgs, poster: Poster = "hermes"): Promise<SendResult> {
    const raw = String(args.text ?? "").trim();
    if (!raw) throw new Refused("text is empty");
    if (raw.length > MAX_TEXT)
      throw new Refused(`text is ${raw.length} characters; keep it under ${MAX_TEXT}`);
    if (BROADCAST.test(raw))
      throw new Refused("@channel, @here and @everyone are not sent from Leon's account");
    const threadTs = args.thread_ts?.trim() || undefined;
    if (threadTs && !TS.test(threadTs))
      throw new Refused("thread_ts must be a Slack message ts such as 1794360293.700699");

    const agent: Agent | null = poster === "hermes" ? null : poster;
    const fromBot = String(args.from_bot ?? "")
      .replace(/[*_~`<>]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (agent) {
      if (!fromBot)
        throw new Refused(
          "from_bot is required: your own name (your bot name, or your Codex session's title)",
        );
      if (fromBot.length > MAX_BOT_NAME)
        throw new Refused(`from_bot is longer than ${MAX_BOT_NAME} characters`);
      if (!threadTs)
        throw new Refused(
          "thread_ts is required: you can post only as a reply in the Slack thread of your task",
        );
      if (/<[@!#][^>]*>/.test(raw))
        throw new Refused(
          "You can't mention people, bots or channels here; Hermes reads the whole thread without a mention",
        );
    }

    if (agent && !/^(#|[CG][A-Z0-9])/.test(String(args.channel ?? "").trim()))
      throw new Refused("You can post only in channel threads, not in DMs");
    const target = await this.#resolve(String(args.channel ?? ""));
    if (agent && (target.dmUser !== undefined || !/^[CG]/.test(target.channel)))
      throw new Refused("You can post only in channel threads, not in DMs");
    const bots = await this.directory.bots();
    const text = agent ? `🤖 *${fromBot}*: ${raw}` : linkBotMentions(raw, bots);
    const mentioned = [...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1] ?? "");
    const blocked = [target.dmUser, ...mentioned].find(
      (u) => u && this.#settings.blockedUsers.includes(u),
    );
    if (blocked) throw new Refused(await this.#blockedMessage(blocked));

    const now = this.#now();
    const rate = agent ? this.#agentRates[agent] : this.#rate;
    const limit = agent
      ? ((agent === "grok" ? this.#settings.grokMaxPerHour : this.#settings.codexMaxPerHour) ?? 120)
      : this.#settings.maxPerHour;
    const recent = await rate.count(now - HOUR_MS);
    if (recent >= limit)
      throw new Refused(
        agent
          ? `${agent === "grok" ? "Grok bots have" : "Codex sessions have"} posted ${recent} messages in the last hour (limit ${limit}); wait, or tell Leon some other way`
          : `already sent ${recent} messages as Leon in the last hour (limit ${limit}); ask Leon before sending more`,
      );

    const botIds = new Set(bots.map((b) => b.id));
    const addressedToBot =
      (target.dmUser !== undefined && botIds.has(target.dmUser)) ||
      mentioned.some((u) => botIds.has(u));

    const clientMsgId = newClientMsgId(poster);
    const posted = await this.#slack("chat.postMessage", {
      channel: target.channel,
      text,
      thread_ts: threadTs,
      client_msg_id: clientMsgId,
    });
    const ts = str(posted.ts);
    const channel = str(posted.channel) || target.channel;
    const record: SentRecord = {
      channel,
      ts,
      ...(threadTs ? { threadTs } : {}),
      clientMsgId,
    };
    await rate.add(now, ts);
    console.log(
      JSON.stringify({
        event: agent ? `sent_for_${agent}` : "sent",
        channel,
        ts,
        thread_ts: threadTs ?? null,
        chars: text.length,
        addressed_to_bot: addressedToBot,
      }),
    );

    let permalink: string | undefined;
    try {
      permalink =
        str((await this.#slack("chat.getPermalink", { channel, message_ts: ts })).permalink) ||
        undefined;
    } catch {
      permalink = undefined;
    }

    const wait = this.#waitSeconds(args.wait_seconds, addressedToBot || agent ? 90 : 0);
    const conversation = await this.#follow(record, ts, wait, target.dmUser, poster);
    return {
      ok: true,
      channel,
      ts,
      thread_ts: threadTs ?? ts,
      ...(permalink ? { permalink } : {}),
      addressed_to_bot: addressedToBot,
      text_sent: text,
      ...conversation,
    };
  }

  async read(
    args: ReadArgs,
    poster: Poster = "hermes",
  ): Promise<Conversation & { ok: true; channel: string; ts: string }> {
    const channel = String(args.channel ?? "").trim();
    const ts = String(args.ts ?? "").trim();
    const record = await this.#lookup(channel, ts);
    // An agent reads only the threads of its own kind's posts.
    if (poster !== "hermes" && (!record || agentOf(record.clientMsgId) !== poster))
      throw new Refused(
        `${channel}:${ts} isn't one of your posts. Reading starts from your own post: post first with hermes_thread_send (in a shell, hermes-thread send), which returns the ts to read from, then read with that ts.`,
      );
    if (!record)
      throw new Refused(
        `${channel}:${ts} was not sent through slack_send_as_leon; this tool only reads the answers to those messages (use your own Slack tools for anything else)`,
      );
    const after = args.after?.trim() || record.ts;
    if (!TS.test(after))
      throw new Refused("after must be a Slack ts (a cursor from a previous call)");
    const dmUser = channel.startsWith("D") ? await this.#imUser(channel) : undefined;
    const wait = this.#waitSeconds(args.wait_seconds, 0);
    return { ok: true, channel, ts, ...(await this.#follow(record, after, wait, dmUser, poster)) };
  }

  /** Reads one page of replies for the server-side Grok bridge, or validates its root. */
  async grokThread(args: { channel: string; threadTs: string; after?: string }) {
    const { channel } = await this.#grokTarget(args.channel, args.threadTs);
    if (args.after !== undefined && !TS.test(args.after))
      throw new Refused("after must be a Slack timestamp");
    const response = await this.#slack("conversations.replies", {
      channel,
      ts: args.threadTs,
      oldest: args.after,
      limit: args.after === undefined ? 1 : 100,
    });
    const raw = (response.messages as RawMessage[] | undefined) ?? [];
    if (args.after === undefined) {
      const root = raw[0];
      if (root?.ts !== args.threadTs || (root.thread_ts && root.thread_ts !== root.ts))
        throw new Refused("Use the exact timestamp of the Slack thread's first message");
      return { channel, cursor: args.threadTs, replies: [] };
    }
    const leon = await this.leonId();
    const replies = [];
    let cursor = args.after;
    for (const message of raw) {
      if (!message.ts || message.thread_ts !== args.threadTs || !later(message.ts, args.after))
        continue;
      if (later(message.ts, cursor)) cursor = message.ts;
      if (agentOf(message.client_msg_id) === "grok" || isGatewayNotice(message)) continue;
      if (
        message.subtype &&
        !["bot_message", "thread_broadcast", "file_share"].includes(message.subtype)
      )
        continue;
      const shaped = await this.#shape(message, leon, false, "grok");
      const files = (message.files ?? []).map(
        (file) => file.permalink ?? file.title ?? file.name ?? "file",
      );
      replies.push({ ...shaped, files });
    }
    return { channel, cursor, replies: replies.sort((a, b) => (later(a.ts, b.ts) ? 1 : -1)) };
  }

  /** Mirrors an event under a stable ID and updates the same Slack message when Grok edits it. */
  async mirrorGrok(args: {
    channel: string;
    threadTs: string;
    bot: string;
    text: string;
    eventId: string;
    retrySince?: string;
    slackTs?: string;
  }) {
    const { channel } = await this.#grokTarget(args.channel, args.threadTs);
    const bot = args.bot;
    const separator = bot.lastIndexOf("/");
    const sourceChannel = bot.slice("Task slack:".length, separator);
    if (
      !bot.startsWith("Task slack:") ||
      bot.slice(separator + 1) !== args.threadTs ||
      (await this.#grokTarget(sourceChannel, args.threadTs)).channel !== channel
    )
      throw new Refused("The Grok bot's name must point to this Slack thread");
    if (
      !args.eventId ||
      args.eventId.length > 300 ||
      !args.text.trim() ||
      args.text.length > 30_000
    )
      throw new Refused("The bridge needs a Matrix event ID and up to 30,000 characters of text");
    const hash = createHash("sha256")
      .update(JSON.stringify([channel, args.threadTs, args.eventId]))
      .digest("hex");
    const clientMsgId = `${CLIENT_MSG_ID_PREFIX}-${GROK_BOT_GROUP}-${GROK_BRIDGE_GROUP}-8${hash.slice(0, 3)}-${hash.slice(3, 15)}`;
    const text = `🤖 *${bot.replaceAll("*", "")}*: ${args.text.replace(/[&<>]/g, (value) =>
      value === "&" ? "&amp;" : value === "<" ? "&lt;" : "&gt;",
    )}`;
    let slackTs = args.slackTs;
    if (!slackTs && args.retrySince !== undefined) {
      if (!TS.test(args.retrySince)) throw new Refused("Invalid retry timestamp");
      let cursor: string | undefined;
      do {
        const page = await this.#slack("conversations.replies", {
          channel,
          ts: args.threadTs,
          oldest: args.retrySince,
          limit: 100,
          cursor,
        });
        slackTs = ((page.messages as RawMessage[] | undefined) ?? []).find(
          (message) => message.client_msg_id === clientMsgId,
        )?.ts;
        cursor =
          (page.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ||
          undefined;
      } while (cursor && !slackTs);
    }
    if (slackTs) {
      if (!TS.test(slackTs)) throw new Refused("Invalid Slack message timestamp");
      const record = await this.#lookup(channel, slackTs);
      if (record?.threadTs !== args.threadTs || record.clientMsgId !== clientMsgId)
        throw new Refused("This Slack reply does not belong to the Grok message");
      await this.#slack("chat.update", { channel, ts: slackTs, text, parse: "none" });
      return { ts: slackTs };
    }
    const posted = await this.#slack("chat.postMessage", {
      channel,
      text,
      thread_ts: args.threadTs,
      client_msg_id: clientMsgId,
      parse: "none",
      unfurl_links: false,
      unfurl_media: false,
    });
    if (!TS.test(str(posted.ts)))
      throw new Error("Slack returned no timestamp for the mirrored reply");
    return { ts: str(posted.ts) };
  }

  async #grokTarget(channel: string, threadTs: string): Promise<{ channel: string }> {
    if (!/^(?:[CG][A-Z0-9]{6,}|#[a-z0-9][a-z0-9._-]{0,79})$/.test(channel) || !TS.test(threadTs))
      throw new Refused("Use a Slack channel and its exact thread timestamp");
    const target = await this.#resolve(channel);
    if (!/^[CG]/.test(target.channel)) throw new Refused("Grok tasks require a channel thread");
    return target;
  }

  /** The bots in the workspace, with Leon's DM channel with each. */
  async bots(): Promise<{ id: string; name: string; mention: string; dm_channel?: string }[]> {
    const [bots, ims] = await Promise.all([this.directory.bots(), this.directory.ims()]);
    return bots
      .filter((b) => !this.#settings.blockedUsers.includes(b.id))
      .map((b) => ({
        id: b.id,
        name: b.name,
        mention: `<@${b.id}>`,
        ...(ims.get(b.id) ? { dm_channel: ims.get(b.id) } : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  #waitSeconds(requested: number | undefined, fallback: number): number {
    const value =
      typeof requested === "number" && Number.isFinite(requested) ? requested : fallback;
    return Math.max(0, Math.min(value, this.#settings.maxWaitSeconds));
  }

  async #blockedMessage(userId: string): Promise<string> {
    const name = (await this.directory.user(userId))?.name ?? userId;
    return `${name} is not reachable as Leon through this tool (Leon's rule; for Silicon Dot, hand tasks off the way your memory says, through its Beeper chat)`;
  }

  async #imUser(channel: string): Promise<string | undefined> {
    const info = await this.#slack("conversations.info", { channel });
    const conversation = info.channel as { is_im?: boolean; user?: string } | undefined;
    return conversation?.is_im ? conversation.user : undefined;
  }

  async #resolve(input: string): Promise<{ channel: string; dmUser?: string }> {
    const value = input.trim();
    if (CONVERSATION_ID.test(value))
      return value.startsWith("D")
        ? { channel: value, dmUser: await this.#imUser(value) }
        : { channel: value };
    let userId: string | undefined;
    if (USER_ID.test(value)) userId = value;
    else if (value.startsWith("@")) userId = (await this.directory.userByName(value.slice(1)))?.id;
    else if (value.startsWith("#")) {
      const id = await this.directory.channelByName(value);
      if (!id) throw new Refused(`Leon has no channel named ${value}`);
      return { channel: id };
    } else
      throw new Refused(
        "channel must be a conversation ID (C…, G…, D…), a user ID (U…) to DM, #channel-name or @Name",
      );
    if (!userId) throw new Refused(`no one in the workspace is named ${value.slice(1)}`);
    if (this.#settings.blockedUsers.includes(userId))
      throw new Refused(await this.#blockedMessage(userId));
    const opened = await this.#slack("conversations.open", { users: userId });
    const id = String((opened.channel as { id?: string } | undefined)?.id ?? "");
    if (!id) throw new Error("Slack conversations.open returned no channel");
    return { channel: id, dmUser: userId };
  }

  /** Messages after `after` in the record's thread (and, in a DM with a bot, at the top level). */
  async #collect(
    record: SentRecord,
    after: string,
    dmUser: string | undefined,
    poster: Poster,
  ): Promise<Reply[]> {
    const root = record.threadTs ?? record.ts;
    const replies = await this.#slack("conversations.replies", {
      channel: record.channel,
      ts: root,
      oldest: after,
      limit: 200,
    });
    const found = new Map<string, { raw: RawMessage; topLevel: boolean }>();
    for (const raw of (replies.messages as RawMessage[] | undefined) ?? [])
      if (raw.ts && later(raw.ts, after)) found.set(raw.ts, { raw, topLevel: false });
    const dmBot = dmUser ? (await this.directory.user(dmUser))?.isBot === true : false;
    if (dmBot) {
      const history = await this.#slack("conversations.history", {
        channel: record.channel,
        oldest: after,
        limit: 100,
      });
      for (const raw of (history.messages as RawMessage[] | undefined) ?? [])
        if (raw.ts && later(raw.ts, after) && !found.has(raw.ts))
          found.set(raw.ts, { raw, topLevel: raw.ts !== root });
    }
    const leon = await this.leonId();
    const out: Reply[] = [];
    for (const { raw, topLevel } of found.values()) {
      if (raw.subtype && !["bot_message", "thread_broadcast", "file_share"].includes(raw.subtype))
        continue;
      if (isGatewayNotice(raw)) continue;
      out.push(await this.#shape(raw, leon, topLevel, poster));
    }
    return out.sort((a, b) => (later(a.ts, b.ts) ? 1 : -1));
  }

  async #shape(raw: RawMessage, leon: string, topLevel: boolean, poster: Poster): Promise<Reply> {
    let from: Reply["from"];
    let author: string;
    let user: SlackUser | undefined;
    if (raw.user && !raw.bot_id) user = await this.directory.user(raw.user);
    const kind: Poster | null =
      agentOf(raw.client_msg_id) ?? (isMarked(raw.client_msg_id) ? "hermes" : null);
    if (kind === poster) {
      from = "you";
      author = "you (sent as Leon)";
    } else if (kind === "grok") {
      from = "grok_bot";
      author = "a Grok bot (sent as Leon)";
    } else if (kind === "codex") {
      from = "codex";
      author = "a Codex session (sent as Leon)";
    } else if (kind === "hermes") {
      from = "hermes";
      author = "Hermes (sent as Leon)";
    } else if (raw.user === leon && !raw.bot_id) {
      from = "leon";
      author = "Leon";
    } else if (raw.bot_id || raw.subtype === "bot_message" || user?.isBot) {
      from = "bot";
      author =
        raw.bot_profile?.name ??
        raw.username ??
        (raw.user ? (await this.directory.user(raw.user))?.name : undefined) ??
        "a bot";
    } else {
      from = "person";
      author = user?.name ?? raw.user ?? "someone";
    }
    const files = (raw.files ?? []).map((f) => f.title ?? f.name ?? "file");
    return {
      ts: raw.ts ?? "",
      from,
      author,
      ...(raw.user ? { userId: raw.user } : {}),
      text: raw.text ?? "",
      ...(topLevel ? { topLevel: true } : {}),
      ...(raw.edited ? { edited: true } : {}),
      ...(files.length ? { files } : {}),
    };
  }

  /** Reads the answers, waiting up to `waitSeconds` for someone other than Leon to answer and settle. */
  async #follow(
    record: SentRecord,
    after: string,
    waitSeconds: number,
    dmUser: string | undefined,
    poster: Poster,
  ): Promise<Conversation> {
    const start = this.#now();
    const deadline = start + waitSeconds * 1000;
    // Hermes waits for a bot or a person; an agent waits for Hermes, or for Leon himself.
    const answered = (replies: Reply[]) =>
      replies.some(
        (r) =>
          r.from === "bot" ||
          r.from === "person" ||
          (poster !== "hermes" && (r.from === "leon" || r.from === "hermes")),
      );
    const signature = (replies: Reply[]) =>
      JSON.stringify(replies.map((r) => [r.ts, r.text, r.edited ?? false]));
    let replies = await this.#collect(record, after, dmUser, poster);
    let changedAt = this.#now();
    while (this.#now() < deadline) {
      if (answered(replies) && this.#now() - changedAt >= this.#settleMs) break;
      await this.#sleep(Math.min(this.#pollMs, Math.max(0, deadline - this.#now())));
      const next = await this.#collect(record, after, dmUser, poster);
      if (signature(next) !== signature(replies)) {
        replies = next;
        changedAt = this.#now();
      }
    }
    const cursor = replies.reduce((max, r) => (later(r.ts, max) ? r.ts : max), after);
    return {
      replies,
      cursor,
      waited_seconds: Math.round((this.#now() - start) / 1000),
      answered: answered(replies),
    };
  }

  /**
   * The message at channel:ts, if this service posted it. Slack itself is the record: the
   * marker in the message's client_msg_id says so, so nothing has to be stored.
   */
  async #lookup(channel: string, ts: string): Promise<SentRecord | undefined> {
    if (!CONVERSATION_ID.test(channel) || !TS.test(ts)) return undefined;
    const exact = { channel, latest: ts, oldest: ts, inclusive: true };
    const at = (data: SlackResponse) =>
      ((data.messages as RawMessage[] | undefined) ?? []).find((m) => m.ts === ts);
    let message = at(await this.#slack("conversations.history", { ...exact, limit: 1 }));
    // A reply inside a thread is not in the channel history.
    message ??= at(await this.#slack("conversations.replies", { ...exact, ts, limit: 5 }));
    if (!message || !isMarked(message.client_msg_id)) return undefined;
    return {
      channel,
      ts,
      ...(message.thread_ts && message.thread_ts !== ts ? { threadTs: message.thread_ts } : {}),
      clientMsgId: message.client_msg_id ?? "",
    };
  }
}
