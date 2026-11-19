export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;

/** One SQL statement against SQLite: a Durable Object's `storage.sql`, or `node:sqlite` in tests. */
export interface Sql {
  exec(query: string, ...params: SqlValue[]): Row[];
}

export type Status = "pending" | "done" | "skipped" | "dead";

export interface QueuedMessage {
  id: string;
  attempts: number;
  firstSeen: number;
  /** Found by a backfill rather than as it arrived, so it never wakes Hermes. */
  backfill: boolean;
  /** The screener's verdict once there is one, as JSON, so a retry doesn't ask again. */
  verdict: string | null;
  /** Where the post went and its ts, once the top-level post is up. */
  channel: string | null;
  ts: string | null;
  /** Thread replies already posted. */
  chunksDone: number;
}

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    not_before INTEGER NOT NULL, first_seen INTEGER NOT NULL, backfill INTEGER NOT NULL DEFAULT 0,
    verdict TEXT, route TEXT, channel TEXT, ts TEXT, chunks_done INTEGER NOT NULL DEFAULT 0,
    last_error TEXT, finished_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS messages_due ON messages (status, not_before)`,
];

/** Finished rows are kept this long, so a message seen twice (a backfill, say) is posted once. */
const KEEP_MS = 45 * 24 * 3600_000;
/** A message that still can't be posted after this long is given up on. */
export const GIVE_UP_MS = 24 * 3600_000;

const backoff = (attempts: number): number => Math.min(10 * 60_000, 30_000 * 2 ** (attempts - 1));

export class Store {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
    for (const statement of MIGRATIONS) sql.exec(statement);
  }

  get(key: string): string | null {
    const row = this.#sql.exec(`SELECT value FROM state WHERE key = ?`, key)[0];
    return row ? (row.value as string) : null;
  }

  getNumber(key: string): number | null {
    const value = this.get(key);
    return value === null ? null : Number(value);
  }

  set(key: string, value: string | number | null): void {
    if (value === null) this.#sql.exec(`DELETE FROM state WHERE key = ?`, key);
    else
      this.#sql.exec(
        `INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        key,
        String(value),
      );
  }

  /** Queues a message unless it was seen before. True when it's new. */
  enqueue(id: string, now: number, backfill = false): boolean {
    const before = this.#sql.exec(`SELECT 1 AS x FROM messages WHERE id = ?`, id).length;
    if (before) return false;
    this.#sql.exec(
      `INSERT INTO messages (id, status, not_before, first_seen, backfill) VALUES (?, 'pending', ?, ?, ?)`,
      id,
      now,
      now,
      backfill ? 1 : 0,
    );
    return true;
  }

  /** Pending messages that are due, in the order they arrived. */
  due(now: number, limit: number): QueuedMessage[] {
    return this.#sql
      .exec(
        `SELECT id, attempts, first_seen, backfill, verdict, channel, ts, chunks_done FROM messages
         WHERE status = 'pending' AND not_before <= ? ORDER BY rowid LIMIT ?`,
        now,
        limit,
      )
      .map((r) => ({
        id: r.id as string,
        attempts: r.attempts as number,
        firstSeen: r.first_seen as number,
        backfill: r.backfill === 1,
        verdict: r.verdict as string | null,
        channel: r.channel as string | null,
        ts: r.ts as string | null,
        chunksDone: r.chunks_done as number,
      }));
  }

  /** When the next pending message is due, or null. */
  nextDue(): number | null {
    const row = this.#sql.exec(
      `SELECT MIN(not_before) AS due FROM messages WHERE status = 'pending'`,
    )[0];
    return typeof row?.due === "number" ? row.due : null;
  }

  saveVerdict(id: string, verdict: string, route: string): void {
    this.#sql.exec(`UPDATE messages SET verdict = ?, route = ? WHERE id = ?`, verdict, route, id);
  }

  posted(id: string, channel: string, ts: string): void {
    this.#sql.exec(`UPDATE messages SET channel = ?, ts = ? WHERE id = ?`, channel, ts, id);
  }

  chunkPosted(id: string, done: number): void {
    this.#sql.exec(`UPDATE messages SET chunks_done = ? WHERE id = ?`, done, id);
  }

  finish(id: string, status: "done" | "skipped", now: number, note: string | null = null): void {
    this.#sql.exec(
      `UPDATE messages SET status = ?, finished_at = ?, last_error = ? WHERE id = ?`,
      status,
      now,
      note,
      id,
    );
  }

  /** Records a failure and retries with backoff, or gives up after GIVE_UP_MS. True when it gave up. */
  fail(message: QueuedMessage, error: string, now: number): boolean {
    const attempts = message.attempts + 1;
    const dead = now - message.firstSeen >= GIVE_UP_MS;
    this.#sql.exec(
      `UPDATE messages SET attempts = ?, last_error = ?, status = ?, not_before = ?, finished_at = ? WHERE id = ?`,
      attempts,
      error.slice(0, 500),
      dead ? "dead" : "pending",
      now + backoff(attempts),
      dead ? now : null,
      message.id,
    );
    return dead;
  }

  prune(now: number): void {
    this.#sql.exec(
      `DELETE FROM messages WHERE status != 'pending' AND finished_at < ?`,
      now - KEEP_MS,
    );
  }

  /** Counts for /healthz and /admin/status. Message IDs only, never content. */
  stats(now: number) {
    const count = (where: string, ...params: SqlValue[]) =>
      (this.#sql.exec(`SELECT COUNT(*) AS n FROM messages WHERE ${where}`, ...params)[0]
        ?.n as number) ?? 0;
    const oldest = this.#sql.exec(
      `SELECT MIN(first_seen) AS t FROM messages WHERE status = 'pending'`,
    )[0]?.t as number | null;
    const day = now - 24 * 3600_000;
    const routes = Object.fromEntries(
      this.#sql
        .exec(
          `SELECT route, COUNT(*) AS n FROM messages WHERE status = 'done' AND finished_at >= ? GROUP BY route`,
          day,
        )
        .map((r) => [String(r.route), r.n as number]),
    );
    const dead = this.#sql
      .exec(
        `SELECT id, last_error, finished_at FROM messages WHERE status = 'dead' ORDER BY finished_at DESC LIMIT 20`,
      )
      .map((r) => ({
        id: r.id as string,
        error: r.last_error as string,
        at: r.finished_at as number,
      }));
    return {
      pending: count(`status = 'pending'`),
      oldestPendingMs: oldest === null || oldest === undefined ? null : now - oldest,
      postedLastDay: routes,
      skippedLastDay: count(`status = 'skipped' AND finished_at >= ?`, day),
      deadLastDay: count(`status = 'dead' AND finished_at >= ?`, day),
      dead,
    };
  }
}
