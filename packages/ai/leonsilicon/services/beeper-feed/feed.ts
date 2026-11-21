import { readFileSync } from "node:fs";
import {
  writeJsonAtomic,
  type ExtensionContext,
  type ExtensionJournal,
  type JournalEntry,
  type RoomInfo,
} from "@-/ai.leonsilicon.services.beeper-inbox";
import {
  FAIL_CLOSED,
  type Screener,
  type SlackPoster,
  type Verdict,
} from "@-/ai.leonsilicon.services.feed-common";
import { feedChannel, MAX_TEXT, mirrorText } from "#format";

const SCREEN_RETRY_MS = 15 * 60_000;
const MAX_RETRY_MS = 10 * 60_000;
const RETRY_LIFETIME_MS = 7 * 24 * 60 * 60_000;
const BATCH_SIZE = 100;
const POSTS_PER_TICK = 10;

interface Pending {
  message: JournalEntry;
  queuedAt: number;
  attempts: number;
  retryAt: number;
  verdict?: Verdict;
}

interface State {
  since: number;
  cursor: number;
  pending: Record<string, Pending>;
  posted: number;
  expired: number;
}

interface FeedOptions {
  source: Pick<ExtensionContext, "rooms" | "senderNames"> & {
    journal: Pick<ExtensionJournal, "head" | "changes">;
  };
  slack: SlackPoster;
  screener: Screener;
  flaggedChannel: string;
  spamChannel: string;
  invite: string[];
  stateFile: string;
  log: ExtensionContext["log"];
  now?: () => number;
}

/** A one-way consumer of the inbox journal. The cursor and pending messages commit together. */
export class BeeperFeed {
  readonly #options: FeedOptions;
  readonly #now: () => number;
  readonly #channels = new Map<string, string>();
  #state: State | null;
  #lastTick: number | null = null;

  constructor(options: FeedOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#state = this.#load();
  }

  status() {
    return {
      start_at: this.#state ? new Date(this.#state.since).toISOString() : null,
      last_tick_at: this.#lastTick === null ? null : new Date(this.#lastTick).toISOString(),
      pending: Object.keys(this.#state?.pending ?? {}).length,
      posted: this.#state?.posted ?? 0,
      expired: this.#state?.expired ?? 0,
    };
  }

  async tick(stopped: () => boolean = () => false): Promise<void> {
    const { source } = this.#options;
    if (!this.#state) {
      const since = this.#now();
      const cursor = await source.journal.head();
      this.#commit({ since, cursor, pending: {}, posted: 0, expired: 0 });
    }
    const state = this.#state!;
    const page = await source.journal.changes({ after: state.cursor, limit: BATCH_SIZE });
    if (page.cursor > state.cursor) {
      const pending = { ...state.pending };
      for (const message of page.entries) {
        const id = message.eventId;
        if (message.redacted) {
          delete pending[id];
          continue;
        }
        const previous = pending[id];
        if (
          message.ts < state.since ||
          (!previous && message.edited && message.seq <= state.cursor)
        )
          continue;
        // Keep the current revision until it's posted. A newly decrypted event can have an older seq.
        pending[id] = {
          message: { ...message, text: message.text.slice(0, MAX_TEXT), html: null },
          queuedAt: previous?.queuedAt ?? this.#now(),
          attempts: 0,
          retryAt: 0,
        };
      }
      this.#commit({ ...state, cursor: page.cursor, pending });
    }

    const now = this.#now();
    const due = Object.values(this.#state!.pending)
      .filter((item) => item.retryAt <= now)
      .slice(0, POSTS_PER_TICK);
    if (due.length && !stopped()) {
      const rooms = new Map(
        (await source.rooms(due.map(({ message }) => message.roomId))).map((room) => [
          room.roomId,
          room,
        ]),
      );
      const senders = await source.senderNames(
        due
          .filter(({ message }) => !message.isMe && rooms.has(message.roomId))
          .map(({ message }) => message.sender),
      );
      for (const item of due) {
        if (stopped()) break;
        const { message } = item;
        const room = rooms.get(message.roomId);
        if (now - item.queuedAt >= RETRY_LIFETIME_MS) {
          this.#finish(item, "expired");
          this.#options.log("warn", "message expired before Slack delivery");
        } else if (!room) {
          this.#retry(item);
        } else {
          const channel = feedChannel(room);
          if (!channel) {
            this.#finish(item);
            continue;
          }
          await this.#post(
            item,
            room,
            channel,
            message.isMe ? "Leon" : senders[message.sender] || message.sender,
          );
        }
      }
    }
    this.#lastTick = this.#now();
  }

  async #post(item: Pending, room: RoomInfo, platform: string, sender: string): Promise<void> {
    const { message } = item;
    let verdict = item.verdict;
    if (!verdict) {
      try {
        verdict = await this.#options.screener.screen({
          chat: {
            title: room.name ?? "Beeper conversation",
            network: room.network,
            type: room.isDirect ? "direct" : "room",
          },
          messages: [{ from: sender, owner: false, text: message.text, type: message.type }],
        });
      } catch {
        if (this.#now() - item.queuedAt < SCREEN_RETRY_MS) {
          this.#retry(item);
          this.#options.log("warn", "message screening will retry");
          return;
        }
        verdict = FAIL_CLOSED;
      }
      item = { ...item, verdict, attempts: 0, retryAt: 0 };
      this.#store(item);
    }

    const destination =
      verdict.route === "safe"
        ? platform
        : verdict.route === "spam"
          ? this.#options.spamChannel
          : this.#options.flaggedChannel;
    const create = verdict.route === "safe";
    try {
      let channel = this.#channels.get(destination);
      if (!channel) {
        const result = await this.#options.slack.ensureChannel(destination, {
          create,
          purpose: create ? `Screened messages from Beeper · ${room.network}` : "",
          invite: create ? this.#options.invite : [],
        });
        channel = result.id;
        this.#channels.set(destination, channel);
      }
      await this.#options.slack.post(channel, mirrorText(message, room, sender, verdict));
    } catch {
      this.#channels.delete(destination);
      this.#retry(item);
      this.#options.log("warn", "Slack delivery will retry", { platform, route: verdict.route });
      return;
    }
    this.#finish(item, "posted");
  }

  #retry(item: Pending): void {
    const delay = Math.min(MAX_RETRY_MS, 30_000 * 2 ** item.attempts);
    this.#store({ ...item, attempts: item.attempts + 1, retryAt: this.#now() + delay });
  }

  #store(item: Pending): void {
    const state = this.#state!;
    this.#commit({ ...state, pending: { ...state.pending, [item.message.eventId]: item } });
  }

  #finish(item: Pending, count?: "posted" | "expired"): void {
    const next = { ...this.#state!, pending: { ...this.#state!.pending } };
    delete next.pending[item.message.eventId];
    if (count) next[count] += 1;
    this.#commit(next);
  }

  #load(): State | null {
    try {
      const state = JSON.parse(readFileSync(this.#options.stateFile, "utf8")) as State;
      if (
        !Number.isSafeInteger(state.cursor) ||
        state.cursor < 0 ||
        !Number.isFinite(state.since) ||
        !state.pending ||
        typeof state.pending !== "object" ||
        Array.isArray(state.pending) ||
        !Number.isSafeInteger(state.posted) ||
        !Number.isSafeInteger(state.expired)
      )
        throw new Error("invalid Beeper Feed state");
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  #commit(next: State): void {
    writeJsonAtomic(this.#options.stateFile, next);
    this.#state = next;
  }
}
