import { DatabaseSync } from "node:sqlite";

/**
 * The store's single-writer guarantee across processes. Pickle requires exactly one writer per
 * account/device store, and Hermes runs many processes (the gateway, cron runs, dashboard chats), each
 * of which may start this MCP server. Whoever holds this lock is the only process that opens the
 * crypto store.
 *
 * It is an open `BEGIN EXCLUSIVE` transaction on a SQLite file: SQLite takes a POSIX lock on the file,
 * which the kernel drops when the process dies by any cause (crash, SIGKILL, OOM, machine stop). So
 * a dead owner never leaves a stale lock behind, and there is no pid file to second-guess.
 */
export class OwnerLock {
  readonly #db: DatabaseSync;
  #released = false;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** Returns the lock, or null when another live process holds it. */
  static tryAcquire(path: string): OwnerLock | null {
    const db = new DatabaseSync(path, { timeout: 0 });
    try {
      db.exec("PRAGMA journal_mode=DELETE");
      db.exec("CREATE TABLE IF NOT EXISTS owner (pid INTEGER NOT NULL, since TEXT NOT NULL)");
      db.exec("PRAGMA locking_mode=EXCLUSIVE");
      db.exec("BEGIN EXCLUSIVE");
      // A write inside the transaction makes the exclusive lock certain on every SQLite version.
      db.prepare("INSERT INTO owner (pid, since) VALUES (?, ?)").run(
        process.pid,
        new Date().toISOString(),
      );
      return new OwnerLock(db);
    } catch (error) {
      try {
        db.close();
      } catch {
        // already closed
      }
      if (isBusy(error)) return null;
      throw error;
    }
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    try {
      this.#db.exec("ROLLBACK");
    } finally {
      this.#db.close();
    }
  }
}

export function isBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|SQLITE_BUSY|database table is locked/i.test(message);
}
