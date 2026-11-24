import { FEED_LIMITS, type GmailFeed, type Logger } from "#feed";
import type { GmailClient } from "#gmail";
import type { Store } from "#store";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function ahead(target: string | null, cursor: string | null): boolean {
  return target !== null && (cursor === null || BigInt(target) > BigInt(cursor));
}

/** The persistent watch and work schedule that share the mailbox cursor and delivery queue. */
export class GmailPush {
  readonly #store: Store;
  readonly #topic: string;

  constructor(store: Store, topic: string) {
    this.#store = store;
    this.#topic = topic;
  }

  get active(): boolean {
    return (
      this.#store.get("watch_topic") === this.#topic &&
      this.#store.get("watch_verified_topic") === this.#topic &&
      this.#store.get("watch_expires_at") !== null
    );
  }

  notify(historyId: string, now: number): void {
    this.#store.set("watch_verified_topic", this.#topic);
    this.#store.set("last_push_at", now);
    this.#observe(historyId, now);
  }

  requestSync(now: number): void {
    const previous = this.#store.getNumber("manual_sync_at") ?? 0;
    this.#store.set("manual_sync_at", Math.max(now, previous + 1));
    this.#store.set("sync_retry_at", null);
  }

  watchAt(): number {
    return this.#store.get("watch_topic") === this.#topic
      ? (this.#store.getNumber("watch_renew_at") ?? 0)
      : 0;
  }

  syncAt(): number | null {
    return this.#needsSync() ? (this.#store.getNumber("sync_retry_at") ?? 0) : null;
  }

  #needsSync(): boolean {
    return (
      this.#store.get("manual_sync_at") !== null ||
      ahead(this.#store.get("push_history_id"), this.#store.get("history_id"))
    );
  }

  #observe(historyId: string, now: number): void {
    const cursor = this.#store.get("history_id");
    if (!ahead(historyId, cursor)) return;
    const previous = this.#store.get("push_history_id");
    if (!ahead(previous, cursor)) this.#store.set("push_pending_since", now);
    if (ahead(historyId, previous)) this.#store.set("push_history_id", historyId);
  }

  async renew(gmail: Pick<GmailClient, "watch">, log: Logger, now: number): Promise<void> {
    if (this.watchAt() > now) return;
    if (this.#store.get("watch_topic") !== this.#topic) {
      this.#store.set("watch_topic", this.#topic);
      this.#store.set("watch_expires_at", null);
    }
    try {
      const { historyId, expiration } = await gmail.watch(this.#topic);
      if (expiration <= now + MINUTE) throw new Error("Gmail watch expires too soon");
      this.#store.set("watch_expires_at", expiration);
      this.#store.set("watch_renew_at", Math.min(now + DAY, expiration - MINUTE));
      this.#store.set("watch_error", null);
      this.#observe(historyId, now);
      log("info", "Gmail watch renewed", { expiration });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#store.set("watch_error", message);
      this.#store.set("watch_renew_at", now + MINUTE);
      log("warn", "Gmail watch renewal failed", { error: message });
    }
  }

  async sync(feed: Pick<GmailFeed, "poll">, now: number): Promise<void> {
    const manual = this.#store.get("manual_sync_at");
    const target = this.#store.get("push_history_id");
    try {
      await feed.poll();
    } catch {
      this.#store.set("sync_retry_at", now + MINUTE);
      return;
    }

    const requested = this.#store.get("manual_sync_at");
    if (manual !== null && manual === requested) this.#store.set("manual_sync_at", null);
    if (!this.#needsSync()) {
      this.#store.set("push_pending_since", null);
      this.#store.set("sync_retry_at", null);
    } else {
      // A new push can arrive while Gmail is being read. Process it on the next alarm.
      const newerWork =
        target !== this.#store.get("push_history_id") ||
        (manual !== this.#store.get("manual_sync_at") &&
          this.#store.get("manual_sync_at") !== null);
      this.#store.set("sync_retry_at", newerWork ? null : now + MINUTE);
    }
  }

  status(feed: ReturnType<GmailFeed["status"]>, now: number) {
    const expiration = this.#store.getNumber("watch_expires_at");
    const lastPush = this.#store.getNumber("last_push_at");
    const pendingSince = this.#store.getNumber("push_pending_since");
    const failingSince = this.#store.getNumber("poll_failing_since");
    const active = this.active;
    const stale = (since: number | null) => since !== null && now - since >= FEED_LIMITS.staleMs;
    return {
      ...feed,
      ok: active
        ? expiration !== null &&
          expiration > now &&
          (feed.oldestPendingMs ?? 0) <= FEED_LIMITS.stuckMs &&
          !stale(failingSince) &&
          !stale(pendingSince)
        : feed.ok,
      mode: active ? "push" : "polling",
      watchExpiresAt: expiration,
      lastPushAgoMs: lastPush === null ? null : now - lastPush,
      watchError: this.#store.get("watch_error"),
    };
  }
}
