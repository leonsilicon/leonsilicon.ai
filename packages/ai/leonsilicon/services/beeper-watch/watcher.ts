import { randomBytes } from "node:crypto";
import { expiryText, heldText, pingText, screenedFeedText } from "#format";
import { FAIL_CLOSED, type Screener, type Verdict } from "#screen";
import type { WatchStore } from "#store";
import type {
  AddWatchInput,
  BeeperSource,
  ChatMessage,
  Logger,
  PendingMessage,
  SlackPoster,
  Watch,
} from "#types";

export const LIMITS = {
  maxWatches: 50,
  maxWaitingFor: 500,
  defaultHours: 72,
  maxHours: 336,
  maxBackfillHours: 168,
  pingsPerHour: 6,
  seenKept: 500,
  pendingKept: 30,
  maxRetryMs: 10 * 60_000,
};

const HOUR = 3_600_000;
const QUIET_TYPES = new Set(["REACTION", "NOTICE"]);
const THREAD_TS = /^\d{9,11}\.\d{6}$/;

/** An error the tool caller can fix; its message goes back to Hermes as is. */
export class UserError extends Error {}

export interface WatcherOptions {
  store: WatchStore;
  beeper: BeeperSource;
  slack: SlackPoster;
  hermesUserId: string;
  log: Logger;
  /** Channel for watches registered without one. */
  defaultChannel: string;
  /** Wait this long after the latest reply before pinging, so a reply split over several messages arrives as one ping. */
  quietMs?: number;
  /** Ping anyway once the first reply is this old. */
  maxBatchMs?: number;
  /**
   * Screens replies from people before they reach the watch's thread (2026-11-07). A flagged reply
   * goes to the flagged or spam channel, and the thread only gets a notice without its text. Only
   * the safety answer counts here: Hermes is waiting for this reply, so a safe one always pings.
   */
  screening?: WatchScreening | null;
  now?: () => number;
}

export interface WatchScreening {
  screener: Screener;
  flaggedChannel: string;
  spamChannel: string;
  /** True for chats with Leon's own agents, whose replies aren't screened. */
  trusted: (network: string) => boolean;
  /** A reply the screener couldn't judge for this long is held as flagged. */
  giveUpMs?: number;
}

export interface WatchSummary {
  id: string;
  chat_id: string;
  chat: string;
  network: string;
  waiting_for: string;
  from?: string;
  slack_channel: string;
  slack_thread_ts?: string;
  since: string;
  expires_at: string;
  replies_delivered: number;
  replies_waiting: number;
}

export interface WatcherHealth {
  watches: number;
  lastTickAt: string | null;
  beeper: boolean | null;
}

export class Watcher {
  #o: Required<WatcherOptions>;
  #lastTickAt: number | null = null;
  #beeperUp: boolean | null = null;

  constructor(options: WatcherOptions) {
    this.#o = {
      quietMs: 30_000,
      maxBatchMs: 120_000,
      screening: null,
      now: Date.now,
      ...options,
    };
  }

  async add(
    input: AddWatchInput,
  ): Promise<{ watch: WatchSummary; updated: boolean; alreadyReceived: number }> {
    const chatID = requiredString(input.chat_id, "chat_id");
    const waitingFor = requiredString(input.waiting_for, "waiting_for");
    if (waitingFor.length > LIMITS.maxWaitingFor)
      throw new UserError(`waiting_for must be at most ${LIMITS.maxWaitingFor} characters`);
    const from = optionalString(input.from, "from");
    const channelArgument =
      optionalString(input.slack_channel, "slack_channel") ?? this.#o.defaultChannel;
    if (/^D[A-Z0-9]+$/.test(channelArgument))
      throw new UserError(
        `Beeper Watch can't post in DMs. Pass a channel, or leave slack_channel out to use #${this.#o.defaultChannel.replace(/^#/, "")}.`,
      );
    const threadTs = optionalString(input.slack_thread_ts, "slack_thread_ts");
    if (threadTs !== undefined && !THREAD_TS.test(threadTs))
      throw new UserError("slack_thread_ts must look like 1793918187.574419");
    const hours =
      input.expires_in_hours === undefined ? LIMITS.defaultHours : Number(input.expires_in_hours);
    if (!Number.isFinite(hours) || hours < 1 || hours > LIMITS.maxHours)
      throw new UserError(`expires_in_hours must be between 1 and ${LIMITS.maxHours}`);

    const now = this.#o.now();
    let since = now;
    if (input.since !== undefined && input.since !== null && input.since !== "") {
      since = typeof input.since === "string" ? Date.parse(input.since) : Number.NaN;
      if (!Number.isFinite(since))
        throw new UserError("since must be an ISO 8601 time, e.g. 2026-11-06T18:50:00Z");
      if (since > now + 60_000) throw new UserError("since is in the future");
      if (now - since > LIMITS.maxBackfillHours * HOUR)
        throw new UserError(`since can be at most ${LIMITS.maxBackfillHours / 24} days ago`);
    }

    let chat;
    try {
      chat = await this.#o.beeper.chat(chatID);
    } catch (error) {
      throw new UserError(
        `Beeper has no chat ${chatID} (${(error as Error).message}). Find the chat ID with the beeper tools, such as search_chats.`,
      );
    }
    let channel;
    try {
      channel = await this.#o.slack.channel(channelArgument);
    } catch (error) {
      throw new UserError((error as Error).message);
    }
    if (channel.isPrivate && !channel.isMember)
      throw new UserError(
        `Beeper Watch isn't in #${channel.name}. Ask Leon to /invite @Beeper Watch there, or use a public channel.`,
      );

    const expiresAt = iso(now + hours * HOUR);
    const existing = this.#o.store
      .list()
      .find(
        (watch) =>
          watch.chatID === chat.id &&
          watch.slackChannel === channel.id &&
          (watch.slackThreadTs ?? "") === (threadTs ?? ""),
      );
    let watch: Watch;
    if (existing) {
      watch = {
        ...existing,
        waitingFor,
        from,
        expiresAt:
          Date.parse(expiresAt) > Date.parse(existing.expiresAt) ? expiresAt : existing.expiresAt,
        since: since < Date.parse(existing.since) ? iso(since) : existing.since,
      };
    } else {
      if (this.#o.store.list().length >= LIMITS.maxWatches)
        throw new UserError(
          `${LIMITS.maxWatches} watches are open. Remove finished ones with beeper_watch_remove first.`,
        );
      watch = {
        id: `w_${randomBytes(4).toString("hex")}`,
        chatID: chat.id,
        chatTitle: chat.title,
        network: chat.network,
        waitingFor,
        from,
        slackChannel: channel.id,
        slackChannelName: channel.name,
        slackThreadTs: threadTs,
        createdAt: iso(now),
        since: iso(since),
        expiresAt,
        seen: [],
        pending: [],
        pings: [],
        delivered: 0,
        failures: 0,
      };
    }
    this.#o.store.put(watch);
    this.#o.log("info", existing ? "watch updated" : "watch added", {
      watch: watch.id,
      network: watch.network,
      channel: watch.slackChannelName,
      backfillMinutes: Math.round((now - Date.parse(watch.since)) / 60_000),
    });

    let alreadyReceived = 0;
    if (Date.parse(watch.since) < now) {
      try {
        const messages = await this.#o.beeper.messagesSince(watch.chatID, watch.since);
        alreadyReceived = messages.filter((message) => wakes(watch, message)).length;
      } catch {
        // The next poll will report Beeper being down; the watch itself is saved.
      }
    }
    return { watch: summary(watch), updated: Boolean(existing), alreadyReceived };
  }

  list(): WatchSummary[] {
    return this.#o.store.list().map(summary);
  }

  remove(id: string): WatchSummary {
    const watch = this.#o.store.get(id);
    if (!watch) {
      const open = this.#o.store.list().map((w) => w.id);
      throw new UserError(
        `No open watch ${id}. Open watches: ${open.length ? open.join(", ") : "none"}`,
      );
    }
    this.#o.store.delete(id);
    this.#o.log("info", "watch removed", { watch: id });
    return summary(watch);
  }

  health(): WatcherHealth {
    return {
      watches: this.#o.store.list().length,
      lastTickAt: this.#lastTickAt === null ? null : iso(this.#lastTickAt),
      beeper: this.#beeperUp,
    };
  }

  /** One polling pass: expire old watches, read new messages, and ping where a reply has settled. */
  async tick(): Promise<void> {
    const now = this.#o.now();
    const byChat = new Map<string, Watch[]>();
    for (const watch of this.#o.store.list()) {
      if (Date.parse(watch.expiresAt) <= now) {
        await this.#expire(watch, now);
        continue;
      }
      byChat.set(watch.chatID, [...(byChat.get(watch.chatID) ?? []), watch]);
    }
    let reached = false;
    let lastError: Error | undefined;
    for (const [chatID, watches] of byChat) {
      const since = watches.map((w) => w.since).sort()[0];
      let messages: ChatMessage[];
      try {
        messages = await this.#o.beeper.messagesSince(chatID, since);
        reached = true;
        this.#chatError(chatID, watches, null);
      } catch (error) {
        lastError = error as Error;
        this.#chatError(chatID, watches, lastError);
        continue;
      }
      for (const watch of watches) await this.#process(watch, messages, now);
    }
    if (byChat.size > 0) this.#beeper(reached, lastError);
    this.#lastTickAt = now;
  }

  #chatErrors = new Map<string, string>();

  #chatError(chatID: string, watches: Watch[], error: Error | null): void {
    const before = this.#chatErrors.get(chatID);
    if (error === null) {
      this.#chatErrors.delete(chatID);
      return;
    }
    if (before !== error.message)
      this.#o.log("warn", "cannot read a watched chat", {
        watches: watches.map((w) => w.id),
        error: error.message,
      });
    this.#chatErrors.set(chatID, error.message);
  }

  async #process(watch: Watch, messages: ChatMessage[], now: number): Promise<void> {
    let changed = false;
    const seen = new Set(watch.seen);
    const since = Date.parse(watch.since);
    for (const message of messages) {
      if (Date.parse(message.timestamp) <= since || seen.has(message.id)) continue;
      seen.add(message.id);
      watch.seen.push(message.id);
      watch.pending.push({
        id: message.id,
        from: message.isSender ? "Leon" : message.senderName,
        wakes: wakes(watch, message),
        text: message.text,
        type: message.type,
        timestamp: message.timestamp,
      });
      changed = true;
    }
    if (changed) {
      watch.seen = watch.seen.slice(-LIMITS.seenKept);
      watch.pending = watch.pending.slice(-LIMITS.pendingKept);
    }
    if (this.#due(watch, now)) {
      await this.#ping(watch, now);
      changed = true;
    }
    if (changed) this.#o.store.put(watch);
  }

  #due(watch: Watch, now: number): boolean {
    const replies = watch.pending
      .filter((message) => message.wakes)
      .map((m) => Date.parse(m.timestamp));
    if (replies.length === 0) return false;
    if (watch.retryAt && Date.parse(watch.retryAt) > now) return false;
    watch.pings = watch.pings.filter((at) => now - Date.parse(at) < HOUR);
    if (watch.pings.length >= LIMITS.pingsPerHour) return false;
    return (
      now - Math.max(...replies) >= this.#o.quietMs ||
      now - Math.min(...replies) >= this.#o.maxBatchMs
    );
  }

  async #ping(watch: Watch, now: number): Promise<boolean> {
    const messages: PendingMessage[] = watch.pending;
    const replies = messages.filter((message) => message.wakes).length;
    const screening = this.#o.screening;
    if (screening && !screening.trusted(watch.network)) {
      const verdict = await this.#screen(watch, messages, screening, now);
      if (!verdict) return false;
      if (verdict.route !== "safe") return this.#hold(watch, messages, verdict, screening, now);
    }
    try {
      await this.#o.slack.post(
        watch.slackChannel,
        pingText(watch, messages, this.#o.hermesUserId),
        watch.slackThreadTs,
      );
    } catch (error) {
      watch.failures += 1;
      watch.retryAt = iso(now + Math.min(LIMITS.maxRetryMs, 30_000 * 2 ** (watch.failures - 1)));
      this.#o.log("warn", "ping failed", {
        watch: watch.id,
        failures: watch.failures,
        retryAt: watch.retryAt,
        error: (error as Error).message,
      });
      return false;
    }
    watch.pending = [];
    watch.delivered += replies;
    watch.failures = 0;
    delete watch.retryAt;
    watch.pings.push(iso(now));
    this.#o.log("info", "pinged hermes", { watch: watch.id, replies, messages: messages.length });
    return true;
  }

  /** The verdict on a watch's pending reply; undefined (with a retry scheduled) when the screener failed. */
  async #screen(
    watch: Watch,
    messages: PendingMessage[],
    screening: WatchScreening,
    now: number,
  ): Promise<Verdict | undefined> {
    try {
      return await screening.screener.screen({
        chat: { title: watch.chatTitle, network: watch.network, type: "" },
        messages: messages.map((m) => ({
          from: m.from,
          owner: m.from === "Leon",
          text: m.text,
          type: m.type,
        })),
      });
    } catch (error) {
      const oldest = Math.min(
        ...messages.filter((m) => m.wakes).map((m) => Date.parse(m.timestamp)),
      );
      if (now - oldest >= (screening.giveUpMs ?? 15 * 60_000)) {
        this.#o.log("error", "screening kept failing; holding the reply as flagged", {
          watch: watch.id,
          error: (error as Error).message,
        });
        return FAIL_CLOSED;
      }
      watch.failures += 1;
      watch.retryAt = iso(now + Math.min(5 * 60_000, 30_000 * 2 ** (watch.failures - 1)));
      this.#o.log("warn", "screening failed; will retry", {
        watch: watch.id,
        failures: watch.failures,
        retryAt: watch.retryAt,
        error: (error as Error).message,
      });
      return undefined;
    }
  }

  /** Puts a flagged reply in its held channel and tells the watch's thread, without the text. */
  async #hold(
    watch: Watch,
    messages: PendingMessage[],
    verdict: Verdict,
    screening: WatchScreening,
    now: number,
  ): Promise<boolean> {
    const heldName = verdict.route === "spam" ? screening.spamChannel : screening.flaggedChannel;
    let heldIn = heldName.replace(/^#/, "");
    try {
      const held = await this.#o.slack.channel(heldName);
      heldIn = held.name;
      if (held.isPrivate && !held.isMember)
        throw new Error(`Beeper Watch isn't in #${held.name}; /invite @Beeper Watch there`);
      const chat = {
        id: watch.chatID,
        accountID: "",
        title: watch.chatTitle,
        network: watch.network,
        type: "",
        isMuted: false,
      };
      await this.#o.slack.post(held.id, screenedFeedText(chat, messages, verdict, null));
    } catch (error) {
      watch.failures += 1;
      watch.retryAt = iso(now + Math.min(LIMITS.maxRetryMs, 30_000 * 2 ** (watch.failures - 1)));
      this.#o.log("warn", "could not post a held reply", {
        watch: watch.id,
        failures: watch.failures,
        error: (error as Error).message,
      });
      return false;
    }
    try {
      await this.#o.slack.post(
        watch.slackChannel,
        heldText(watch, verdict, this.#o.hermesUserId, heldIn),
        watch.slackThreadTs,
      );
    } catch (error) {
      // The reply is safe in the held channel; only Hermes's notice is missing.
      this.#o.log("warn", "could not tell the watch thread about a held reply", {
        watch: watch.id,
        error: (error as Error).message,
      });
    }
    const replies = messages.filter((message) => message.wakes).length;
    watch.pending = [];
    watch.delivered += replies;
    watch.failures = 0;
    delete watch.retryAt;
    watch.pings.push(iso(now));
    this.#o.log("info", "held a watched reply", {
      watch: watch.id,
      route: verdict.route,
      reason: verdict.reason,
      by: verdict.by,
    });
    return true;
  }

  async #expire(watch: Watch, now: number): Promise<void> {
    if (watch.pending.some((message) => message.wakes)) {
      // A reply arrived but was never delivered: keep retrying for a day rather than drop it.
      if (watch.retryAt && Date.parse(watch.retryAt) > now) return;
      const delivered = await this.#ping(watch, now);
      if (!delivered && now - Date.parse(watch.expiresAt) < 24 * HOUR) {
        this.#o.store.put(watch);
        return;
      }
    } else if (watch.delivered === 0) {
      try {
        await this.#o.slack.post(watch.slackChannel, expiryText(watch), watch.slackThreadTs);
      } catch (error) {
        this.#o.log("warn", "expiry notice failed", {
          watch: watch.id,
          error: (error as Error).message,
        });
      }
    }
    this.#o.store.delete(watch.id);
    this.#o.log("info", "watch expired", { watch: watch.id, delivered: watch.delivered });
  }

  #beeper(up: boolean, error?: Error): void {
    if (this.#beeperUp !== up)
      this.#o.log(
        up ? "info" : "error",
        up ? "beeper reachable" : "beeper unreachable",
        error ? { error: error.message } : {},
      );
    this.#beeperUp = up;
  }
}

function wakes(watch: Watch, message: ChatMessage): boolean {
  if (message.isSender || QUIET_TYPES.has(message.type)) return false;
  return !watch.from || message.senderName.toLowerCase().includes(watch.from.toLowerCase());
}

function summary(watch: Watch): WatchSummary {
  return {
    id: watch.id,
    chat_id: watch.chatID,
    chat: watch.chatTitle,
    network: watch.network,
    waiting_for: watch.waitingFor,
    ...(watch.from ? { from: watch.from } : {}),
    slack_channel: `#${watch.slackChannelName} (${watch.slackChannel})`,
    ...(watch.slackThreadTs ? { slack_thread_ts: watch.slackThreadTs } : {}),
    since: watch.since,
    expires_at: watch.expiresAt,
    replies_delivered: watch.delivered,
    replies_waiting: watch.pending.filter((message) => message.wakes).length,
  };
}

function requiredString(value: unknown, name: string): string {
  const text = optionalString(value, name);
  if (text === undefined) throw new UserError(`${name} is required`);
  return text;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new UserError(`${name} must be a string`);
  const text = value.trim();
  return text === "" ? undefined : text;
}

const iso = (ms: number): string => new Date(ms).toISOString();
