import {
  FAIL_CLOSED,
  type Screener,
  type Verdict,
} from "@-/com.leonsilicon.ai.services.beeper-watch/screen";
import { emailPost, outageText, recoveredText, type PostVerdict } from "#format";
import { GmailError, type GmailApi } from "#gmail";
import { parseEmail, pendingParts, type GmailMessage } from "#mime";
import { screenInput } from "#screen";
import type { SlackPoster } from "#slack";
import type { QueuedMessage, Store } from "#store";

export type LogLevel = "info" | "warn" | "error";
export type Logger = (level: LogLevel, message: string, fields?: Record<string, unknown>) => void;

export type FeedWake = "screened" | "none";

export interface FeedConfig {
  /** Where safe emails go, created when missing: `feed-gmail`. */
  channel: string;
  /** Where unsafe and spam emails are held (IDs or names of existing private channels). */
  flaggedChannel: string;
  spamChannel: string;
  hermesUserId: string;
  /** Added to the channel when the bot creates it, besides Hermes. */
  invite: string[];
  /** `screened` wakes Hermes when the screener says it should know; `none` never does. */
  wake: FeedWake;
  /** Body characters the screener reads and a post shows. */
  maxBody: number;
}

export interface GmailFeedDeps {
  config: FeedConfig;
  store: Store;
  gmail: GmailApi;
  slack: SlackPoster;
  screener: Screener;
  log: Logger;
  now?: () => number;
}

export const FEED_LIMITS = {
  /** A message the screener still can't judge after this long is held in #feed-flagged. */
  screenGiveUpMs: 15 * 60_000,
  /** Gmail unreachable for this long gets one notice in the feed channel. */
  outageNoticeMs: 30 * 60_000,
  /** The poll is stale, for /healthz, after this long. */
  staleMs: 5 * 60_000,
  /** A message still waiting after this long makes /healthz unhealthy. */
  stuckMs: 30 * 60_000,
  /** Gmail's label names are refreshed this often. */
  labelsMs: 6 * 3600_000,
  /** Text parts fetched separately per message, at most. */
  maxFetchedParts: 5,
};

const PURPOSE =
  "Every email that reaches Leon's Gmail, copied by the Gmail feed (gmail-feed.leonsilicon.ai). Screened first: unsafe ones are held in #feed-flagged and spam in #feed-spam.";

/** Inbound mail: not a draft, not chat, and not something Leon sent unless it also reached a folder. */
export function isInbound(labelIds: string[]): boolean {
  const labels = new Set(labelIds);
  if (labels.has("DRAFT") || labels.has("CHAT")) return false;
  if (labels.has("SENT") && !labels.has("INBOX") && !labels.has("SPAM")) return false;
  return true;
}

/** The screener's verdict, or Gmail's own when it had already filed the email as spam. */
export type EmailVerdict = Omit<Verdict, "by" | "reason"> &
  PostVerdict & { by: Verdict["by"] | "gmail"; reason: Verdict["reason"] | "gmail_spam" };

const GMAIL_SPAM: EmailVerdict = { route: "spam", reason: "gmail_spam", by: "gmail", wake: false };

/**
 * Copies every email that reaches the mailbox into Slack. `poll` reads Gmail's history since the last
 * poll and queues new message IDs; `process` fetches, screens and posts the queue in arrival order,
 * retrying with backoff. Both are safe to call again after a crash: IDs dedupe, and a post that got
 * up records its ts, so it isn't posted twice.
 */
export class GmailFeed {
  readonly #c: FeedConfig;
  readonly #store: Store;
  readonly #gmail: GmailApi;
  readonly #slack: SlackPoster;
  readonly #screener: Screener;
  readonly #log: Logger;
  readonly #now: () => number;

  constructor(deps: GmailFeedDeps) {
    this.#c = deps.config;
    this.#store = deps.store;
    this.#gmail = deps.gmail;
    this.#slack = deps.slack;
    this.#screener = deps.screener;
    this.#log = deps.log;
    this.#now = deps.now ?? Date.now;
  }

  /** Reads new history and queues what arrived. The first poll only records where to start. */
  async poll(): Promise<{ queued: number; started?: boolean }> {
    const now = this.#now();
    try {
      const result = await this.#poll(now);
      await this.#recovered(now);
      this.#store.set("last_poll_ok_at", now);
      this.#store.set("poll_error", null);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#store.set("poll_error", message.slice(0, 300));
      if (this.#store.getNumber("poll_failing_since") === null)
        this.#store.set("poll_failing_since", now);
      this.#log("warn", "poll failed", { error: message });
      await this.#outage(now, message);
      throw error;
    }
  }

  async #poll(now: number): Promise<{ queued: number; started?: boolean }> {
    const start = this.#store.get("history_id");
    if (!start || !this.#store.get("mailbox")) {
      const profile = await this.#gmail.profile();
      this.#store.set("mailbox", profile.emailAddress);
      if (!start) {
        this.#store.set("history_id", profile.historyId);
        this.#log("info", "started", { historyId: profile.historyId });
        return { queued: 0, started: true };
      }
    }
    let queued = 0;
    let latest = start;
    try {
      let pageToken: string | undefined;
      do {
        const page = await this.#gmail.history(start, pageToken);
        for (const id of page.messageIds) if (this.#store.enqueue(id, now)) queued++;
        latest = page.historyId;
        pageToken = page.nextPageToken;
      } while (pageToken);
    } catch (error) {
      if (!(error instanceof GmailError && error.status === 404)) throw error;
      // Gmail keeps about a week of history. Past that, catch up by date from the last good poll.
      const profile = await this.#gmail.profile();
      const since = (this.#store.getNumber("last_poll_ok_at") ?? now) - 3600_000;
      queued += await this.#search(`after:${Math.floor(since / 1000)}`, now, false);
      latest = profile.historyId;
      this.#log("warn", "history expired, caught up by date", { since, queued });
    }
    this.#store.set("history_id", latest);
    if (queued) this.#log("info", "queued", { queued });
    return { queued };
  }

  /** Queues every message received since `sinceMs`, spam and trash included. They never wake Hermes. */
  async backfill(sinceMs: number): Promise<{ queued: number }> {
    const queued = await this.#search(`after:${Math.floor(sinceMs / 1000)}`, this.#now(), true);
    this.#log("info", "backfill queued", { since: sinceMs, queued });
    return { queued };
  }

  async #search(query: string, now: number, backfill: boolean): Promise<number> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.#gmail.list(query, pageToken);
      ids.push(...page.ids);
      pageToken = page.nextPageToken;
    } while (pageToken);
    let queued = 0;
    // Gmail lists newest first; queue oldest first so they're posted in order.
    for (const id of ids.reverse()) if (this.#store.enqueue(id, now, backfill)) queued++;
    return queued;
  }

  async #outage(now: number, error: string): Promise<void> {
    const since = this.#store.getNumber("poll_failing_since") ?? now;
    if (now - since < FEED_LIMITS.outageNoticeMs || this.#store.get("outage_notified")) return;
    try {
      const channel = await this.#feedChannel();
      await this.#slack.post(channel, outageText(since, error));
      this.#store.set("outage_notified", now);
    } catch (postError) {
      this.#log("warn", "outage notice failed", { error: String(postError) });
    }
  }

  async #recovered(now: number): Promise<void> {
    const since = this.#store.getNumber("poll_failing_since");
    if (since === null) return;
    if (this.#store.get("outage_notified"))
      try {
        await this.#slack.post(await this.#feedChannel(), recoveredText(since));
      } catch (error) {
        this.#log("warn", "recovery notice failed", { error: String(error) });
      }
    this.#store.set("poll_failing_since", null);
    this.#store.set("outage_notified", null);
    this.#log("info", "gmail reachable again", { downMs: now - since });
  }

  /** Posts up to `limit` due messages. Failures are retried later; nothing is dropped silently. */
  async process(limit = 25): Promise<{ posted: number; skipped: number; failed: number }> {
    const counts = { posted: 0, skipped: 0, failed: 0 };
    for (const message of this.#store.due(this.#now(), limit)) {
      try {
        counts[await this.#deliver(message)]++;
      } catch (error) {
        counts.failed++;
        const text = error instanceof Error ? error.message : String(error);
        const dead = this.#store.fail(message, text, this.#now());
        this.#log(dead ? "error" : "warn", dead ? "gave up on message" : "message failed", {
          id: message.id,
          attempt: message.attempts + 1,
          error: text,
        });
      }
    }
    this.#store.prune(this.#now());
    return counts;
  }

  async #deliver(queued: QueuedMessage): Promise<"posted" | "skipped"> {
    let message: GmailMessage;
    try {
      message = await this.#gmail.message(queued.id);
    } catch (error) {
      if (error instanceof GmailError && (error.status === 404 || error.status === 400)) {
        this.#store.finish(queued.id, "skipped", this.#now(), "gone from Gmail");
        return "skipped";
      }
      throw error;
    }
    if (!isInbound(message.labelIds ?? [])) {
      this.#store.finish(queued.id, "skipped", this.#now(), "not inbound");
      return "skipped";
    }

    const fetched = new Map<string, string>();
    for (const part of pendingParts(message).slice(0, FEED_LIMITS.maxFetchedParts))
      fetched.set(part.partId, await this.#gmail.attachment(message.id, part.attachmentId));
    const email = parseEmail(message, fetched);
    const labels = await this.#labels(email.labelIds);

    let verdict: EmailVerdict;
    if (queued.verdict) verdict = JSON.parse(queued.verdict) as EmailVerdict;
    else {
      if (email.labelIds.includes("SPAM")) verdict = GMAIL_SPAM;
      else
        try {
          verdict = await this.#screener.screen(screenInput(email, labels, this.#c.maxBody));
        } catch (error) {
          if (this.#now() - queued.firstSeen < FEED_LIMITS.screenGiveUpMs) throw error;
          this.#log("warn", "screener unavailable, holding", { id: email.id });
          verdict = FAIL_CLOSED;
        }
      this.#store.saveVerdict(queued.id, JSON.stringify(verdict), verdict.route);
    }

    const mailbox = this.#store.get("mailbox") ?? "";
    const mention =
      verdict.route === "safe" &&
      verdict.wake &&
      this.#c.wake === "screened" &&
      !queued.backfill &&
      email.fromAddress !== mailbox.toLowerCase()
        ? this.#c.hermesUserId
        : null;
    const quiet = queued.backfill
      ? "copied late, Hermes not woken"
      : this.#c.wake === "none"
        ? "Hermes not woken"
        : "Hermes not woken: nothing it needs to know now";
    const post = emailPost(email, {
      verdict,
      mention,
      quiet,
      mailbox,
      labels,
      channelName: this.#c.channel.replace(/^#/, ""),
    });

    let channel = queued.channel;
    let ts = queued.ts;
    if (!channel || !ts) {
      channel = await this.#routeChannel(verdict.route);
      ts = (await this.#slack.post(channel, post.text)).ts;
      this.#store.posted(queued.id, channel, ts);
    }
    for (let i = queued.chunksDone; i < post.thread.length; i++) {
      await this.#slack.post(channel, post.thread[i], ts);
      this.#store.chunkPosted(queued.id, i + 1);
    }
    this.#store.finish(queued.id, "done", this.#now());
    this.#log("info", "posted", {
      id: email.id,
      route: verdict.route,
      reason: verdict.reason,
      by: verdict.by,
      wokeHermes: mention !== null,
      thread: post.thread.length,
    });
    return "posted";
  }

  async #labels(ids: string[]): Promise<Map<string, string>> {
    const cached = this.#store.get("labels");
    const at = this.#store.getNumber("labels_at") ?? 0;
    let map = new Map<string, string>(cached ? (JSON.parse(cached) as [string, string][]) : []);
    const unknown = ids.some((id) => id.startsWith("Label_") && !map.has(id));
    if (!cached || unknown || this.#now() - at > FEED_LIMITS.labelsMs) {
      try {
        const labels = await this.#gmail.labels();
        map = new Map(labels.filter((l) => l.type !== "system").map((l) => [l.id, l.name]));
        this.#store.set("labels", JSON.stringify([...map]));
        this.#store.set("labels_at", this.#now());
      } catch (error) {
        // Label names are a nicety; post without them rather than hold the email.
        this.#log("warn", "labels failed", { error: String(error) });
      }
    }
    return map;
  }

  async #feedChannel(): Promise<string> {
    const cached = this.#store.get("channel_id");
    if (cached) return cached;
    const result = await this.#slack.ensureChannel(this.#c.channel, {
      create: true,
      purpose: PURPOSE,
      invite: [this.#c.hermesUserId, ...this.#c.invite],
    });
    if (result.created)
      this.#log("info", "created channel", { channel: result.id, problems: result.problems });
    this.#store.set("channel_id", result.id);
    return result.id;
  }

  async #routeChannel(route: Verdict["route"]): Promise<string> {
    if (route === "safe") return this.#feedChannel();
    const wanted = route === "spam" ? this.#c.spamChannel : this.#c.flaggedChannel;
    const key = `channel:${wanted}`;
    const cached = this.#store.get(key);
    if (cached) return cached;
    const { id } = await this.#slack.ensureChannel(wanted, {
      create: false,
      purpose: "",
      invite: [],
    });
    this.#store.set(key, id);
    return id;
  }

  /** For /healthz and /admin/status: freshness and counts, never email content. */
  status() {
    const now = this.#now();
    const lastOk = this.#store.getNumber("last_poll_ok_at");
    const stats = this.#store.stats(now);
    const pollFresh = lastOk !== null && now - lastOk < FEED_LIMITS.staleMs;
    const stuck = stats.oldestPendingMs !== null && stats.oldestPendingMs > FEED_LIMITS.stuckMs;
    return {
      ok: pollFresh && !stuck,
      started: Boolean(this.#store.get("history_id")),
      lastPollOkAgoMs: lastOk === null ? null : now - lastOk,
      pollError: this.#store.get("poll_error"),
      pending: stats.pending,
      oldestPendingMs: stats.oldestPendingMs,
      postedLastDay: stats.postedLastDay,
      skippedLastDay: stats.skippedLastDay,
      deadLastDay: stats.deadLastDay,
      dead: stats.dead,
    };
  }
}
