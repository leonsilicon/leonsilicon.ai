import type { DatabaseSync } from "node:sqlite";

/**
 * Every message sync delivers, written down once as it arrives, so that whatever needs new messages
 * often (the Grok relay waiting for a reply, a feed of every chat) can ask "what is new or changed
 * since N?" instead of reading history again. A page of history costs about half a second per message
 * (see the README); a journal read is one indexed query.
 *
 * Each message gets a position when it first arrives (`seq`) and a new one whenever it changes (`rev`:
 * an edit, a deletion, a decryption that succeeded late). Positions only grow, so "after N" never
 * misses or repeats a change.
 *
 * Unlike the rest of `inbox.db` this table holds message text, for `RETENTION_MS` at most. It sits in
 * the owner-only state directory beside the keys that decrypt everything anyway.
 */

/** How long a message stays in the journal. */
export const RETENTION_MS = 7 * 24 * 60 * 60_000;
/** The journal counts as broken off when the daemon was away this long: sync may have skipped events. */
export const GAP_MS = 30 * 60_000;
const MAX_ROWS = 100_000;
const MAX_ATTEMPTS = 5;

export interface JournalEntry {
  /** Where the message first arrived. */
  seq: number;
  /** Where it last changed; equal to `seq` for a message that never changed. */
  rev: number;
  roomId: string;
  eventId: string;
  sender: string;
  isMe: boolean;
  /** The Matrix message type: `m.text`, `m.notice`, `m.image`… */
  type: string;
  text: string;
  html: string | null;
  /** When it was sent, as the homeserver recorded it. */
  ts: number;
  /** When sync delivered it here. */
  receivedAt: number;
  edited: boolean;
  redacted: boolean;
  replyTo: string | null;
  attachments: number;
}

export interface JournalMessage {
  roomId: string;
  eventId: string;
  sender: string;
  isMe: boolean;
  type: string;
  text: string;
  html?: string | undefined;
  ts: number;
  /** For an edit: the message it replaces. */
  replaces?: string | undefined;
  replyTo?: string | undefined;
  attachments?: number | undefined;
}

interface Row {
  seq: number;
  rev: number;
  room_id: string;
  event_id: string;
  sender: string;
  is_me: number;
  type: string;
  text: string;
  html: string | null;
  ts: number;
  received_at: number;
  edited: number;
  redacted: number;
  pending: number;
  reply_to: string | null;
  attachments: number;
}

function entry(row: Row): JournalEntry {
  return {
    seq: Number(row.seq),
    rev: Number(row.rev),
    roomId: row.room_id,
    eventId: row.event_id,
    sender: row.sender,
    isMe: row.is_me === 1,
    type: row.type,
    text: row.text,
    html: row.html,
    ts: Number(row.ts),
    receivedAt: Number(row.received_at),
    edited: row.edited === 1,
    redacted: row.redacted === 1,
    replyTo: row.reply_to,
    attachments: Number(row.attachments),
  };
}

export class MessageJournal {
  readonly #db: DatabaseSync;
  readonly #listeners = new Set<(entry: JournalEntry) => void>();

  constructor(db: DatabaseSync, now: number = Date.now()) {
    this.#db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS journal (
      seq INTEGER PRIMARY KEY,
      rev INTEGER NOT NULL,
      room_id TEXT NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      sender TEXT NOT NULL,
      is_me INTEGER NOT NULL,
      type TEXT NOT NULL,
      text TEXT NOT NULL,
      html TEXT,
      ts INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      edited INTEGER NOT NULL DEFAULT 0,
      redacted INTEGER NOT NULL DEFAULT 0,
      pending INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      reply_to TEXT,
      attachments INTEGER NOT NULL DEFAULT 0
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS journal_rev ON journal (rev)");
    db.exec("CREATE INDEX IF NOT EXISTS journal_room_rev ON journal (room_id, rev)");
    db.exec("CREATE INDEX IF NOT EXISTS journal_room_ts ON journal (room_id, ts)");
    db.exec("CREATE INDEX IF NOT EXISTS journal_ts ON journal (ts)");
    db.exec(
      "CREATE TABLE IF NOT EXISTS journal_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)",
    );
    this.alive(now);
  }

  #meta(key: string): number | null {
    const row = this.#db.prepare("SELECT value FROM journal_meta WHERE key = ?").get(key) as
      | { value: number }
      | undefined;
    return row ? Number(row.value) : null;
  }

  #setMeta(key: string, value: number): void {
    this.#db
      .prepare("INSERT OR REPLACE INTO journal_meta (key, value) VALUES (?, ?)")
      .run(key, value);
  }

  #next(): number {
    const next = (this.#meta("head") ?? 0) + 1;
    this.#setMeta("head", next);
    return next;
  }

  #row(eventId: string): Row | undefined {
    return this.#db.prepare("SELECT * FROM journal WHERE event_id = ?").get(eventId) as
      | Row
      | undefined;
  }

  #changed(eventId: string): JournalEntry | null {
    const row = this.#row(eventId);
    if (!row) return null;
    const changed = entry(row);
    for (const listener of this.#listeners) {
      try {
        listener(changed);
      } catch {
        // a listener's failure is its own
      }
    }
    return changed;
  }

  /**
   * Called once a minute, and at start. After an absence of GAP_MS or more, sync may have skipped
   * events, so the journal only vouches for what came after.
   */
  alive(now: number = Date.now()): void {
    const last = this.#meta("alive_at");
    if (last === null || this.#meta("covered_since") === null || now - last >= GAP_MS)
      this.#setMeta("covered_since", now);
    this.#setMeta("alive_at", now);
  }

  /** The time from which the journal has every message sync delivered. */
  coveredSince(): number {
    return this.#meta("covered_since") ?? Date.now();
  }

  /** The latest position: "after this" means from now on. */
  head(): number {
    return this.#meta("head") ?? 0;
  }

  /**
   * Writes a message down. An edit updates the message it replaces; a message seen before is left
   * alone, unless it was waiting to be decrypted. Returns the entry when something changed.
   */
  record(message: JournalMessage, now: number = Date.now()): JournalEntry | null {
    const target = message.replaces ?? message.eventId;
    const existing = this.#row(target);
    if (existing && !message.replaces && existing.pending !== 1) return null;
    if (existing) {
      this.#db
        .prepare(
          `UPDATE journal SET rev = ?, text = ?, html = ?, type = ?, edited = ?, pending = 0,
             sender = ?, is_me = ?, ts = CASE WHEN pending = 1 THEN ? ELSE ts END,
             attachments = ?, reply_to = COALESCE(?, reply_to)
           WHERE event_id = ?`,
        )
        .run(
          this.#next(),
          message.text,
          message.html ?? null,
          message.type,
          message.replaces ? 1 : existing.edited,
          message.sender,
          message.isMe ? 1 : 0,
          message.ts,
          message.attachments ?? 0,
          message.replyTo ?? null,
          target,
        );
      return this.#changed(target);
    }
    const position = this.#next();
    this.#db
      .prepare(
        `INSERT INTO journal (seq, rev, room_id, event_id, sender, is_me, type, text, html, ts,
           received_at, edited, reply_to, attachments)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        position,
        position,
        message.roomId,
        target,
        message.sender,
        message.isMe ? 1 : 0,
        message.type,
        message.text,
        message.html ?? null,
        message.ts,
        now,
        message.replaces ? 1 : 0,
        message.replyTo ?? null,
        message.attachments ?? 0,
      );
    return this.#changed(target);
  }

  /** Notes an event that arrived but couldn't be decrypted yet. It shows up once it can be. */
  pending(roomId: string, eventId: string, sender: string, now: number = Date.now()): void {
    if (this.#row(eventId)) return;
    const position = this.#next();
    this.#db
      .prepare(
        `INSERT INTO journal (seq, rev, room_id, event_id, sender, is_me, type, text, ts, received_at, pending)
         VALUES (?, ?, ?, ?, ?, 0, '', '', ?, ?, 1)`,
      )
      .run(position, position, roomId, eventId, sender, now, now);
  }

  /** Events still waiting to be decrypted that are due another try; each call counts as one. */
  pendingDue(now: number = Date.now(), limit = 5): Array<{ roomId: string; eventId: string }> {
    const rows = this.#db
      .prepare(
        `SELECT room_id, event_id FROM journal
         WHERE pending = 1 AND attempts < ? AND received_at <= ? - (attempts + 1) * 30000
         ORDER BY seq LIMIT ?`,
      )
      .all(MAX_ATTEMPTS, now, limit) as Array<{ room_id: string; event_id: string }>;
    for (const row of rows)
      this.#db
        .prepare("UPDATE journal SET attempts = attempts + 1 WHERE event_id = ?")
        .run(row.event_id);
    return rows.map((row) => ({ roomId: row.room_id, eventId: row.event_id }));
  }

  /** A deleted message keeps its place and loses its text. */
  redact(eventId: string): JournalEntry | null {
    const existing = this.#row(eventId);
    if (!existing || existing.redacted === 1) return null;
    this.#db
      .prepare(
        "UPDATE journal SET rev = ?, text = '', html = NULL, redacted = 1, pending = 0 WHERE event_id = ?",
      )
      .run(this.#next(), eventId);
    return this.#changed(eventId);
  }

  /**
   * Messages that arrived or changed after a position, oldest change first. `cursor` is the position
   * to ask from next time.
   */
  changes(options: { after: number; roomId?: string | undefined; limit?: number | undefined }): {
    entries: JournalEntry[];
    cursor: number;
  } {
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
    const rows = (options.roomId
      ? this.#db
          .prepare(
            "SELECT * FROM journal WHERE room_id = ? AND rev > ? AND pending = 0 ORDER BY rev LIMIT ?",
          )
          .all(options.roomId, options.after, limit)
      : this.#db
          .prepare("SELECT * FROM journal WHERE rev > ? AND pending = 0 ORDER BY rev LIMIT ?")
          .all(options.after, limit)) as unknown as Row[];
    const entries = rows.map(entry);
    return { entries, cursor: entries.at(-1)?.rev ?? options.after };
  }

  /** Like `changes`, but when there is nothing yet it waits up to `waitMs` for the first one. */
  async changesWhenAny(options: {
    after: number;
    roomId?: string | undefined;
    limit?: number | undefined;
    waitMs: number;
  }): Promise<{ entries: JournalEntry[]; cursor: number }> {
    const now = this.changes(options);
    if (now.entries.length || options.waitMs <= 0) return now;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.#listeners.delete(listener);
        resolve();
      };
      const listener = (changed: JournalEntry): void => {
        if (!options.roomId || changed.roomId === options.roomId) done();
      };
      const timer = setTimeout(done, options.waitMs);
      this.#listeners.add(listener);
    });
    return this.changes(options);
  }

  /**
   * The newest `count` messages of a room, oldest first, from the time the journal vouches for. An
   * older message can be in the journal too (reading history, or a bridge filling in the past, makes
   * sync deliver it), but there may be gaps around it, so it isn't counted as "the latest".
   */
  latest(roomId: string, count: number): JournalEntry[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM journal WHERE room_id = ? AND pending = 0 AND ts >= ?
         ORDER BY ts DESC, seq DESC LIMIT ?`,
      )
      .all(roomId, this.coveredSince(), Math.min(Math.max(count, 1), 500)) as unknown as Row[];
    return rows.map(entry).reverse();
  }

  /** A room's messages sent at or after a time, oldest first (500 at most). */
  since(roomId: string, sinceTs: number): JournalEntry[] {
    const rows = this.#db
      .prepare(
        "SELECT * FROM journal WHERE room_id = ? AND ts >= ? AND pending = 0 ORDER BY ts, seq LIMIT 500",
      )
      .all(roomId, sinceTs) as unknown as Row[];
    return rows.map(entry);
  }

  /** Every room's messages sent at or after a time, oldest first, `limit` at most (the oldest). */
  recent(sinceTs: number, limit = 2000): JournalEntry[] {
    const rows = this.#db
      .prepare("SELECT * FROM journal WHERE ts >= ? AND pending = 0 ORDER BY ts, seq LIMIT ?")
      .all(sinceTs, Math.min(Math.max(limit, 1), 5000)) as unknown as Row[];
    return rows.map(entry);
  }

  /** Drops what is older than the retention, and the oldest rows past the cap. */
  prune(now: number = Date.now()): void {
    this.#db.prepare("DELETE FROM journal WHERE received_at < ?").run(now - RETENTION_MS);
    this.#db
      .prepare(
        "DELETE FROM journal WHERE seq <= (SELECT seq FROM journal ORDER BY seq DESC LIMIT 1 OFFSET ?)",
      )
      .run(MAX_ROWS);
  }

  stats(): { head: number; coveredSince: number; entries: number; pending: number } {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS entries, COALESCE(SUM(pending), 0) AS pending FROM journal")
      .get() as { entries: number; pending: number };
    return {
      head: this.head(),
      coveredSince: this.coveredSince(),
      entries: Number(row.entries),
      pending: Number(row.pending),
    };
  }
}
