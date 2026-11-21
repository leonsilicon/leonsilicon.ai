import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Every send, keyed by its idempotency key, so a retried or overlapping request can't post twice.
 *
 * - `pending`: being sent now, or the daemon died mid-send.
 * - `sent`: the homeserver returned an event ID.
 * - `failed`: the homeserver definitely refused it (a 4xx on the send itself, or it never got that far).
 * - `unknown`: the send PUT went out and no definite answer came back (timeout, connection loss, 5xx).
 *
 * Each key has one transaction ID for life, so resending a `failed` or `unknown` key reuses it and the
 * homeserver deduplicates the event if it already has it.
 */

export type SendStatus = "pending" | "sent" | "failed" | "unknown";
export type SendKind = "text" | "file" | "reaction";

export interface SendRecord {
  key: string;
  derived: boolean;
  roomId: string;
  kind: SendKind;
  payloadHash: string;
  txnId: string;
  status: SendStatus;
  eventId: string | null;
  error: string | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

/** How long an identical message with no explicit key counts as a repeat of the earlier one. */
export const DERIVED_KEY_WINDOW_MS = 15 * 60_000;
/** Homeservers keep transaction IDs for a limited time; past this a resend may not be deduplicated. */
export const SAFE_RESEND_WINDOW_MS = 30 * 60_000;

export function payloadHash(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(`${part.length}:${part}`);
  return hash.digest("hex");
}

/**
 * The ledger key. An explicit key is the caller's; without one, the payload itself is the key, in a
 * time bucket, so the same text sent again within about DERIVED_KEY_WINDOW_MS is treated as a retry.
 */
export function idempotencyKey(
  explicit: string | undefined,
  roomId: string,
  kind: SendKind,
  hash: string,
): { key: string; derived: boolean } {
  if (explicit !== undefined) {
    const trimmed = explicit.trim();
    if (!/^[\w.:@!#+=-]{1,128}$/.test(trimmed)) {
      throw new Error(
        "idempotency_key must be 1-128 characters of letters, digits and . : @ ! # + = _ -",
      );
    }
    return { key: `k:${roomId}:${trimmed}`, derived: false };
  }
  return { key: `h:${roomId}:${kind}:${hash}`, derived: true };
}

/** The Matrix transaction ID for a key: stable, opaque, URL-safe. */
export function txnIdFor(key: string, generation = 0): string {
  const digest = createHash("sha256").update(`${generation}:${key}`).digest("base64url");
  return `bi${generation ? `${generation}.` : ""}${digest.slice(0, 26)}`;
}

interface Row {
  key: string;
  derived: number;
  room_id: string;
  kind: string;
  payload_hash: string;
  txn_id: string;
  status: string;
  event_id: string | null;
  error: string | null;
  attempts: number;
  created_at: number;
  updated_at: number;
}

export class SendLedger {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS sends (
      key TEXT PRIMARY KEY,
      derived INTEGER NOT NULL,
      room_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      txn_id TEXT NOT NULL,
      status TEXT NOT NULL,
      event_id TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  }

  get(key: string): SendRecord | null {
    const row = this.#db.prepare("SELECT * FROM sends WHERE key = ?").get(key) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  /** Records an attempt starting. Creates the record, or bumps an existing one back to pending. */
  begin(
    record: Pick<SendRecord, "key" | "derived" | "roomId" | "kind" | "payloadHash" | "txnId">,
    now = Date.now(),
  ): SendRecord {
    this.#db
      .prepare(
        `INSERT INTO sends (key, derived, room_id, kind, payload_hash, txn_id, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)
         ON CONFLICT(key) DO UPDATE SET status = 'pending', attempts = attempts + 1, updated_at = excluded.updated_at, error = NULL`,
      )
      .run(
        record.key,
        record.derived ? 1 : 0,
        record.roomId,
        record.kind,
        record.payloadHash,
        record.txnId,
        now,
        now,
      );
    return this.get(record.key) as SendRecord;
  }

  finish(
    key: string,
    status: Exclude<SendStatus, "pending">,
    eventId: string | null,
    error: string | null,
    now = Date.now(),
  ): SendRecord {
    this.#db
      .prepare(
        "UPDATE sends SET status = ?, event_id = COALESCE(?, event_id), error = ?, updated_at = ? WHERE key = ?",
      )
      .run(status, eventId, error, now, key);
    return this.get(key) as SendRecord;
  }

  /** A derived key past its window is retired so the same text can be sent again on purpose. */
  retire(key: string, now = Date.now()): void {
    this.#db.prepare("UPDATE sends SET key = ? WHERE key = ?").run(`${key}#retired@${now}`, key);
  }

  recent(limit = 20): SendRecord[] {
    return (
      this.#db
        .prepare("SELECT * FROM sends ORDER BY updated_at DESC LIMIT ?")
        .all(limit) as unknown as Row[]
    ).map(fromRow);
  }

  prune(olderThanMs: number, now = Date.now()): number {
    const result = this.#db
      .prepare("DELETE FROM sends WHERE updated_at < ?")
      .run(now - olderThanMs);
    return Number(result.changes);
  }
}

function fromRow(row: Row): SendRecord {
  return {
    key: row.key,
    derived: row.derived === 1,
    roomId: row.room_id,
    kind: row.kind as SendKind,
    payloadHash: row.payload_hash,
    txnId: row.txn_id,
    status: row.status as SendStatus,
    eventId: row.event_id,
    error: row.error,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
