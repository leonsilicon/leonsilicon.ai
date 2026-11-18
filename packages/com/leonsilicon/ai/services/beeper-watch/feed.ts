import fs from "node:fs";
import path from "node:path";
import { feedText, screenedFeedText } from "#format";
import { channelName, platformOf } from "#platform";
import { FAIL_CLOSED, type Screener, type Verdict } from "#screen";
import type {
  BeeperFeedSource,
  FeedChat,
  FeedMessage,
  Logger,
  PendingMessage,
  SlackPoster,
} from "#types";

/**
 * The feed (2026-11-06): every Beeper message, copied to Slack so Hermes has Leon's full context.
 * Since 2026-11-18 each Beeper connection has its own channel, `<prefix><platform>`: #feed-whatsapp,
 * #feed-instagram, #feed-grok and so on (`platform.ts`). A channel that doesn't exist yet is created
 * when its first message arrives, with Hermes and the `invite` users added. A chat's new messages are
 * posted together once they settle. Posts with a message from a person mention Hermes, which wakes it
 * to decide whether anything needs doing. Leon's own messages, agent chats and muted chats are posted
 * as context only.
 *
 * Left out: the Slack workspace the feed posts in (its messages are already in Slack, and copying
 * them would loop back through Beeper's Slack bridge), chats with an open watch (the watch already
 * delivers them), and reactions.
 *
 * With `screening` (2026-11-07), messages from people go through the screener first. Safe ones go
 * to their platform's channel, and a post there mentions Hermes when the screener says Hermes should
 * know about it (never for chats Leon muted). Unsafe ones and spam go to #feed-flagged and
 * #feed-spam, which Hermes is not in. Leon's own messages and his agent chats aren't screened; they
 * go to their platform's channel as context that never wakes Hermes.
 */

export interface FeedScreening {
  screener: Screener;
  flaggedChannel: string;
  spamChannel: string;
  /** Safe posts from chats Leon muted mention Hermes too. Default false. */
  wakeMuted?: boolean;
  /** A batch the screener couldn't judge for this long goes to the flagged channel. */
  giveUpMs?: number;
}

export type FeedWake = "people" | "all" | "none";

export interface FeedOptions {
  beeper: BeeperFeedSource;
  slack: SlackPoster;
  log: Logger;
  /** Each connection posts to `<channelPrefix><platform>`, e.g. #feed-whatsapp. Default "feed-". */
  channelPrefix?: string;
  /** A channel name or ID for some platforms, instead of `<channelPrefix><platform>`. */
  platformChannels?: Record<string, string>;
  /** Slack users added to the channels the feed creates, besides Hermes. */
  invite?: string[];
  hermesUserId: string;
  stateFile: string;
  /** Without screening: which messages mention Hermes, "people" (default), "all" or "none". */
  wake?: FeedWake;
  /** Screen messages from people and route them to the safe, flagged and spam channels. */
  screening?: FeedScreening | null;
  /** Accounts never copied. Matched against the start of the Beeper account ID. */
  excludeAccounts?: string[];
  /** Networks whose messages never wake Hermes (agents it talks to itself). Lowercase. */
  quietNetworks?: string[];
  /** Chats that currently have an open watch; they're skipped. */
  watchedChats?: () => Set<string>;
  quietMs?: number;
  maxBatchMs?: number;
  /** Each search reaches this far behind the newest message seen, for late arrivals. */
  overlapMs?: number;
  postsPerTick?: number;
  now?: () => number;
}

interface Batch {
  chat: FeedChat;
  messages: PendingMessage[];
  failures: number;
  retryAt?: string;
  /** The screener's verdict, kept while the post is retried; `ids` are the messages it judged. */
  verdict?: Verdict & { ids: string[] };
}

interface FeedState {
  version: 1;
  /** Newest message time seen; searches start `overlapMs` before it. */
  cursor: string;
  /** When the feed was first started: anything older is never copied. */
  floor: string;
  /** Message ID -> timestamp (ms), kept for the overlap window so nothing posts twice. */
  seen: Record<string, number>;
  batches: Record<string, Batch>;
  posted: number;
}

export const FEED_LIMITS = {
  messagesPerBatch: 40,
  maxRetryMs: 10 * 60_000,
  /** A batch that can't be posted for this long is dropped, with a log line. */
  giveUpMs: 24 * 3_600_000,
};

const SKIPPED_TYPES = new Set(["REACTION"]);
const QUIET_TYPES = new Set(["NOTICE"]);

export class Feed {
  #o: Required<FeedOptions>;
  #state: FeedState;
  #channelIds = new Map<string, string>();
  #accounts: { at: number; ids: string[]; networks: Map<string, string> } | null = null;
  #lastTickAt: number | null = null;

  constructor(options: FeedOptions) {
    this.#o = {
      channelPrefix: "feed-",
      platformChannels: {},
      invite: [],
      wake: "people",
      screening: null,
      excludeAccounts: [],
      quietNetworks: ["grokbot", "grok bot", "muse", "chatgpt-dots", "chatgpt dots"],
      watchedChats: () => new Set(),
      quietMs: 30_000,
      maxBatchMs: 120_000,
      overlapMs: 20 * 60_000,
      postsPerTick: 10,
      now: Date.now,
      // An option passed as undefined keeps its default.
      ...(Object.fromEntries(
        Object.entries(options).filter(([, value]) => value !== undefined),
      ) as FeedOptions),
    };
    this.#state = this.#load();
  }

  health(): { lastTickAt: string | null; waiting: number; posted: number } {
    return {
      lastTickAt: this.#lastTickAt === null ? null : iso(this.#lastTickAt),
      waiting: Object.keys(this.#state.batches).length,
      posted: this.#state.posted,
    };
  }

  /** One pass: read new messages across Beeper, then post every chat whose messages have settled. */
  async tick(): Promise<void> {
    const now = this.#o.now();
    const accountIDs = await this.#accountIDs(now);
    const since = Date.parse(this.#state.cursor) - this.#o.overlapMs;
    const { messages, chats, truncated } = await this.#o.beeper.recentMessages(
      iso(since),
      accountIDs,
    );
    if (truncated)
      this.#o.log("warn", "feed search hit its page limit; the oldest new messages were skipped", {
        since: iso(since),
      });

    const watched = this.#o.watchedChats();
    let newest = Date.parse(this.#state.cursor);
    let added = 0;
    for (const message of messages) {
      const at = Date.parse(message.timestamp);
      if (this.#state.seen[message.id] !== undefined) continue;
      this.#state.seen[message.id] = at;
      newest = Math.max(newest, at);
      if (at <= Date.parse(this.#state.floor)) continue;
      const chat = chats[message.chatID];
      if (!chat || !this.#copies(message, chat, watched)) continue;
      this.#add(chat, message);
      added += 1;
    }
    this.#state.cursor = iso(Math.min(newest, now));
    const keepAfter = Date.parse(this.#state.cursor) - this.#o.overlapMs - 3_600_000;
    for (const [id, at] of Object.entries(this.#state.seen))
      if (at < keepAfter) delete this.#state.seen[id];

    let posts = 0;
    for (const [chatID, batch] of Object.entries(this.#state.batches)) {
      if (posts >= this.#o.postsPerTick) break;
      if (!this.#due(batch, now)) continue;
      posts += 1;
      await this.#post(chatID, batch, now);
    }
    if (added > 0 || posts > 0) this.#save();
    this.#lastTickAt = now;
  }

  #copies(message: FeedMessage, chat: FeedChat, watched: Set<string>): boolean {
    if (SKIPPED_TYPES.has(message.type)) return false;
    if (watched.has(message.chatID)) return false;
    if (this.#excluded(message.accountID)) return false;
    // "$space" and similar entries are Beeper's own bookkeeping, not conversations.
    if (chat.network.startsWith("$")) return false;
    return true;
  }

  #excluded(accountID: string): boolean {
    return this.#o.excludeAccounts.some((prefix) => prefix && accountID.startsWith(prefix));
  }

  #wakes(message: FeedMessage, chat: FeedChat): boolean {
    if (this.#o.screening) return false; // screened posts decide for themselves
    if (this.#o.wake === "none") return false;
    if (message.isSender || QUIET_TYPES.has(message.type)) return false;
    if (this.#o.wake === "all") return true;
    if (chat.isMuted) return false;
    return !this.#agentChat(message, chat);
  }

  /** Chats with Leon's own agents (Grok bots, Muse, Dots): trusted context, never screened or woken. */
  #agentChat(message: FeedMessage, chat: FeedChat): boolean {
    const network = chat.network.toLowerCase();
    const account = message.accountID.split(".")[0]?.toLowerCase() ?? "";
    return this.#o.quietNetworks.some((quiet) => quiet === network || quiet === account);
  }

  #add(chat: FeedChat, message: FeedMessage): void {
    const batch = (this.#state.batches[chat.id] ??= { chat, messages: [], failures: 0 });
    batch.chat = chat;
    batch.messages.push({
      id: message.id,
      from: message.isSender ? "Leon" : message.senderName,
      wakes: this.#wakes(message, chat),
      untrusted: !message.isSender && !this.#agentChat(message, chat),
      text: message.text,
      type: message.type,
      timestamp: message.timestamp,
    });
    batch.messages.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    if (batch.messages.length > FEED_LIMITS.messagesPerBatch)
      batch.messages = batch.messages.slice(-FEED_LIMITS.messagesPerBatch);
  }

  #due(batch: Batch, now: number): boolean {
    if (batch.messages.length === 0) return false;
    if (batch.retryAt && Date.parse(batch.retryAt) > now) return false;
    const times = batch.messages.map((message) => Date.parse(message.timestamp));
    return (
      now - Math.max(...times) >= this.#o.quietMs || now - Math.min(...times) >= this.#o.maxBatchMs
    );
  }

  async #post(chatID: string, batch: Batch, now: number): Promise<void> {
    const screening = this.#o.screening;
    // Messages saved before screening existed have no flag: treat everything not Leon's as untrusted.
    const untrusted = batch.messages.some((m) => m.untrusted ?? m.from !== "Leon");
    let heldIn: string | null = null; // null: the chat's platform channel
    let text: string;
    let wakes = false;
    let verdict: Verdict | undefined;
    if (screening && untrusted) {
      verdict = await this.#verdict(chatID, batch, screening, now);
      if (!verdict) return; // the screener failed; retried later
      heldIn =
        verdict.route === "safe"
          ? null
          : verdict.route === "spam"
            ? screening.spamChannel
            : screening.flaggedChannel;
      const muted = batch.chat.isMuted && screening.wakeMuted !== true;
      wakes = verdict.route === "safe" && verdict.wake === true && !muted;
      text = screenedFeedText(
        batch.chat,
        batch.messages,
        verdict,
        wakes ? this.#o.hermesUserId : null,
        muted ? "muted chat, Hermes not woken" : "nothing for Hermes to act on, not woken",
      );
    } else {
      wakes = !screening && batch.messages.some((message) => message.wakes);
      text = feedText(batch.chat, batch.messages, wakes ? this.#o.hermesUserId : null);
    }
    try {
      const channel = heldIn
        ? await this.#channel(heldIn)
        : await this.#platformChannel(batch.chat);
      await this.#o.slack.post(channel, text);
    } catch (error) {
      batch.failures += 1;
      const oldest = Math.min(...batch.messages.map((message) => Date.parse(message.timestamp)));
      if (now - oldest > FEED_LIMITS.giveUpMs) {
        delete this.#state.batches[chatID];
        this.#o.log("error", "feed post dropped after a day of failures", {
          network: batch.chat.network,
          messages: batch.messages.length,
          error: (error as Error).message,
        });
        return;
      }
      batch.retryAt = iso(
        now + Math.min(FEED_LIMITS.maxRetryMs, 30_000 * 2 ** (batch.failures - 1)),
      );
      this.#o.log("warn", "feed post failed", {
        network: batch.chat.network,
        failures: batch.failures,
        retryAt: batch.retryAt,
        error: (error as Error).message,
      });
      return;
    }
    delete this.#state.batches[chatID];
    this.#state.posted += 1;
    this.#o.log("info", "feed posted", {
      network: batch.chat.network,
      type: batch.chat.type,
      messages: batch.messages.length,
      wokeHermes: wakes,
      ...(verdict ? { route: verdict.route, reason: verdict.reason, by: verdict.by } : {}),
    });
  }

  /**
   * The screener's verdict on a batch, reused while the same messages wait to be posted. When the
   * screener fails, schedules a retry and returns undefined; after `giveUpMs` it fails closed.
   */
  async #verdict(
    chatID: string,
    batch: Batch,
    screening: FeedScreening,
    now: number,
  ): Promise<Verdict | undefined> {
    const ids = batch.messages.map((m) => m.id);
    if (batch.verdict && batch.verdict.ids.join() === ids.join()) return batch.verdict;
    let verdict: Verdict;
    try {
      verdict = await screening.screener.screen({
        chat: { title: batch.chat.title, network: batch.chat.network, type: batch.chat.type },
        messages: batch.messages.map((m) => ({
          from: m.from,
          owner: !(m.untrusted ?? m.from !== "Leon"),
          text: m.text,
          type: m.type,
        })),
      });
    } catch (error) {
      const oldest = Math.min(...batch.messages.map((m) => Date.parse(m.timestamp)));
      if (now - oldest < (screening.giveUpMs ?? 15 * 60_000)) {
        batch.failures += 1;
        batch.retryAt = iso(now + Math.min(5 * 60_000, 30_000 * 2 ** (batch.failures - 1)));
        this.#o.log("warn", "screening failed; will retry", {
          network: batch.chat.network,
          failures: batch.failures,
          retryAt: batch.retryAt,
          error: (error as Error).message,
        });
        this.#save();
        return undefined;
      }
      this.#o.log("error", "screening kept failing; holding the messages as flagged", {
        network: batch.chat.network,
        error: (error as Error).message,
      });
      verdict = FAIL_CLOSED;
    }
    batch.failures = 0;
    delete batch.retryAt;
    batch.verdict = { ...verdict, ids };
    this.#state.batches[chatID] = batch;
    return verdict;
  }

  async #channel(name: string): Promise<string> {
    let id = this.#channelIds.get(name);
    if (!id) {
      const channel = await this.#o.slack.channel(name);
      if (channel.isPrivate && !channel.isMember)
        throw new Error(`Beeper Watch isn't in #${channel.name}; /invite @Beeper Watch there`);
      id = channel.id;
      this.#channelIds.set(name, id);
    }
    return id;
  }

  /** The chat's platform channel, such as #feed-whatsapp, created the first time it's needed. */
  async #platformChannel(chat: FeedChat): Promise<string> {
    const platform = platformOf(chat.accountID, chat.network);
    const name = this.#o.platformChannels[platform] ?? channelName(this.#o.channelPrefix, platform);
    const cached = this.#channelIds.get(name);
    if (cached) return cached;
    const slack = this.#o.slack;
    if (!slack.ensureChannel) return this.#channel(name);
    const label = this.#accounts?.networks.get(chat.accountID) || chat.network || platform;
    const channel = await slack.ensureChannel(name, {
      invite: [this.#o.hermesUserId, ...this.#o.invite],
      purpose: `Every Beeper message from ${label}, copied by Beeper Watch.${
        this.#o.screening
          ? " Messages from people are screened first; flagged ones and spam are held back from Hermes."
          : ""
      }`,
    });
    if (channel.created)
      this.#o.log(channel.problems?.length ? "warn" : "info", "feed channel created", {
        channel: channel.name,
        platform,
        ...(channel.problems?.length ? { problems: channel.problems } : {}),
      });
    if (channel.isPrivate && !channel.isMember)
      throw new Error(`Beeper Watch isn't in #${channel.name}; /invite @Beeper Watch there`);
    this.#channelIds.set(name, channel.id);
    return channel.id;
  }

  /** Every Beeper account except the excluded ones, refreshed every 10 minutes. */
  async #accountIDs(now: number): Promise<string[]> {
    if (!this.#accounts || now - this.#accounts.at > 10 * 60_000) {
      const accounts = await this.#o.beeper.accounts();
      this.#accounts = {
        at: now,
        ids: accounts.map((account) => account.accountID).filter((id) => !this.#excluded(id)),
        networks: new Map(accounts.map((account) => [account.accountID, account.network])),
      };
    }
    return this.#accounts.ids;
  }

  #load(): FeedState {
    const fresh = (): FeedState => ({
      version: 1,
      // Start now: the feed copies what arrives from here on, not the backlog.
      cursor: iso(this.#o.now()),
      floor: iso(this.#o.now()),
      seen: {},
      batches: {},
      posted: 0,
    });
    let raw: string;
    try {
      raw = fs.readFileSync(this.#o.stateFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const state = fresh();
        this.#state = state;
        this.#save();
        return state;
      }
      throw error;
    }
    try {
      const data = JSON.parse(raw) as Partial<FeedState>;
      if (typeof data.cursor !== "string" || Number.isNaN(Date.parse(data.cursor)))
        throw new Error("missing cursor");
      return {
        version: 1,
        cursor: data.cursor,
        floor: typeof data.floor === "string" ? data.floor : data.cursor,
        seen: data.seen ?? {},
        batches: data.batches ?? {},
        posted: data.posted ?? 0,
      };
    } catch (error) {
      const aside = `${this.#o.stateFile}.corrupt-${Date.now()}`;
      fs.renameSync(this.#o.stateFile, aside);
      this.#o.log("error", "feed state was unreadable; starting from now", {
        movedTo: aside,
        error: (error as Error).message,
      });
      return fresh();
    }
  }

  #save(): void {
    fs.mkdirSync(path.dirname(this.#o.stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.#o.stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.#state)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.#o.stateFile);
  }
}

const iso = (ms: number): string => new Date(ms).toISOString();
