import type { Logger } from "#types";

/**
 * The `fetch` Pickle's WASM core sends every Matrix request through (Pickle's `fetch` client option).
 * It adds what Pickle's API doesn't expose, without patching Pickle:
 *
 * - **Pinned transaction IDs.** Pickle's send retries transient failures, and each retry gets a fresh
 *   transaction ID from mautrix, so a send whose response was lost can be delivered twice. While a send
 *   is in flight, its `PUT /rooms/{room}/send/{type}/{txn}` is rewritten to one transaction ID derived
 *   from the request's idempotency key. The homeserver treats a repeated transaction ID as the same
 *   event (client-server spec, "Transaction identifiers"), so retries, and later retries of an
 *   ambiguous send, can't duplicate it.
 * - **No plaintext into encrypted rooms.** A message PUT that isn't `m.room.encrypted` while the room is
 *   known to be encrypted is refused locally.
 * - **Raw capture.** Pickle drops events it can't decrypt (and thread replies, and non-message events)
 *   from history. Capturing the raw `/messages` and `/event` responses lets the tools say exactly what
 *   was left out instead of presenting a partial page as complete.
 * - **Known-403 shortcut.** Beeper answers `/relations` with 403 in bridged rooms, and Pickle asks for
 *   each message's edits that way. After the first 403 in a room, the next ones are answered locally
 *   for ten minutes.
 * - **No room state in /sync.** Pickle's state store re-serializes and rewrites its whole room-state
 *   cache on every state event, so the full state of Leon's ~1,200 rooms in the first sync is quadratic
 *   work that doesn't finish. Pickle's inline sync filter is rewritten to leave room state out and
 *   lazy-load members; Pickle already fetches a room's encryption state and members itself before
 *   sending there, and history comes from /messages. Sync still carries to-device room keys, device
 *   lists and new timeline events.
 * - **Timeouts** on every request, and sync health for `inbox_status`.
 */

const SEND_PATH = /^\/_matrix\/client\/(?:v3|r0|unstable)\/rooms\/([^/]+)\/send\/([^/]+)\/([^/]+)$/;
const ROOM_PATH =
  /^\/_matrix\/client\/(?:v3|v1|r0|unstable)\/rooms\/([^/]+)\/(messages|event|relations)(?:\/([^/]+))?/;
const RELATIONS_TTL_MS = 10 * 60_000;

/**
 * Pickle's sync filter without room state (see above). Beeper's homeserver ignores `types: []` and
 * `limit: 0` there (measured 2026-11-18: 23,049 state events across 1,415 rooms either way) but honours
 * `not_types: ["*"]` (54). Room account data and ephemeral events aren't needed either. Exported for tests.
 */
export function slimSyncFilter(filter: Record<string, unknown>): Record<string, unknown> {
  const section = (value: unknown): Record<string, unknown> => ({
    ...(value as Record<string, unknown> | undefined),
  });
  const room = section(filter.room);
  room.state = { ...section(room.state), not_types: ["*"], lazy_load_members: true };
  room.timeline = { ...section(room.timeline), lazy_load_members: true };
  room.account_data = { ...section(room.account_data), not_types: ["*"] };
  room.ephemeral = { ...section(room.ephemeral), not_types: ["*"] };
  return { ...filter, room, presence: { not_types: ["*"] } };
}

export interface SendAttempt {
  eventType: string;
  txnId: string;
  startedAt: number;
  status?: number;
  error?: string;
  blocked?: boolean;
}

export interface SendGuard {
  roomId: string;
  txnId: string;
  /** Refuse `m.room.message` PUTs: the room is encrypted. */
  expectEncrypted: boolean;
  attempts: SendAttempt[];
}

export interface RawCapture {
  kind: "messages" | "event";
  roomId: string;
  eventId?: string;
  bodies: unknown[];
  pending: Promise<void>[];
}

export interface FetchStats {
  lastSyncOkAt: number | null;
  lastSyncErrorAt: number | null;
  lastSyncError: string | null;
  consecutiveSyncFailures: number;
  syncs: number;
  requests: number;
}

export interface MatrixFetchOptions {
  requestTimeoutMs?: number;
  mediaTimeoutMs?: number;
}

export class MatrixFetch {
  readonly #base: typeof fetch;
  readonly #log: Logger;
  readonly #requestTimeoutMs: number;
  readonly #mediaTimeoutMs: number;
  readonly #relationsBlocked = new Map<string, number>();
  #send: SendGuard | null = null;
  #capture: RawCapture | null = null;
  readonly stats: FetchStats = {
    lastSyncOkAt: null,
    lastSyncErrorAt: null,
    lastSyncError: null,
    consecutiveSyncFailures: 0,
    syncs: 0,
    requests: 0,
  };

  constructor(base: typeof fetch, log: Logger, options: MatrixFetchOptions = {}) {
    this.#base = base;
    this.#log = log;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 90_000;
    this.#mediaTimeoutMs = options.mediaTimeoutMs ?? 300_000;
  }

  /** The function handed to Pickle. */
  readonly fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    this.#fetch(input, init);

  beginSend(guard: Omit<SendGuard, "attempts">): SendGuard {
    if (this.#send) throw new Error("a send is already in flight");
    this.#send = { ...guard, attempts: [] };
    return this.#send;
  }

  endSend(): void {
    this.#send = null;
  }

  beginCapture(kind: RawCapture["kind"], roomId: string, eventId?: string): RawCapture {
    if (this.#capture) throw new Error("a capture is already active");
    this.#capture = { kind, roomId, eventId, bodies: [], pending: [] };
    return this.#capture;
  }

  async endCapture(): Promise<void> {
    const capture = this.#capture;
    this.#capture = null;
    if (capture) await Promise.allSettled(capture.pending);
  }

  async #fetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const path = url.pathname;
    this.stats.requests += 1;
    const isSync = path.endsWith("/sync");
    const isMedia = path.includes("/media/");
    if (isSync && method === "GET") {
      const filter = url.searchParams.get("filter");
      if (filter?.trimStart().startsWith("{")) {
        try {
          url.searchParams.set(
            "filter",
            JSON.stringify(slimSyncFilter(JSON.parse(filter) as Record<string, unknown>)),
          );
        } catch {
          // not JSON after all: leave it
        }
      }
    }

    const roomMatch = ROOM_PATH.exec(path);
    const roomId = roomMatch ? safeDecode(roomMatch[1] ?? "") : null;
    if (roomMatch?.[2] === "relations" && roomId) {
      const until = this.#relationsBlocked.get(roomId);
      if (until && until > Date.now()) {
        return json(403, {
          errcode: "M_FORBIDDEN",
          error: "relations are unavailable in this room (cached by beeper-inbox)",
        });
      }
    }

    let attempt: SendAttempt | null = null;
    const sendMatch = method === "PUT" ? SEND_PATH.exec(path) : null;
    if (sendMatch && this.#send && safeDecode(sendMatch[1] ?? "") === this.#send.roomId) {
      const eventType = safeDecode(sendMatch[2] ?? "");
      attempt = { eventType, txnId: this.#send.txnId, startedAt: Date.now() };
      this.#send.attempts.push(attempt);
      if (this.#send.expectEncrypted && eventType === "m.room.message") {
        attempt.blocked = true;
        attempt.status = 400;
        this.#log("error", "refused a plaintext send into an encrypted room", {
          roomId: this.#send.roomId,
        });
        return json(400, {
          errcode: "M_UNKNOWN",
          error: "beeper-inbox refused to send an unencrypted message into an encrypted room",
        });
      }
      url.pathname = `${path.slice(0, path.lastIndexOf("/") + 1)}${encodeURIComponent(attempt.txnId)}`;
    }

    const timeoutMs = isSync
      ? Number(url.searchParams.get("timeout") ?? 0) + 60_000
      : isMedia
        ? this.#mediaTimeoutMs
        : this.#requestTimeoutMs;
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (init.signal) signals.push(init.signal);
    const started = Date.now();
    let response: Response;
    try {
      response = await this.#base(url, { ...init, method, signal: AbortSignal.any(signals) });
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (attempt) attempt.error = message;
      if (isSync) this.#syncFailed(message);
      this.#log("warn", "matrix request failed", {
        method,
        path: redactPath(path),
        ms: Date.now() - started,
        error: message,
      });
      throw error;
    }
    if (attempt) attempt.status = response.status;
    if (isSync) {
      if (response.ok) {
        this.stats.syncs += 1;
        this.stats.lastSyncOkAt = Date.now();
        this.stats.consecutiveSyncFailures = 0;
      } else this.#syncFailed(`HTTP ${response.status}`);
    }
    if (roomMatch?.[2] === "relations" && roomId && response.status === 403) {
      this.#relationsBlocked.set(roomId, Date.now() + RELATIONS_TTL_MS);
    }
    const capture = this.#capture;
    if (
      capture &&
      roomId === capture.roomId &&
      method === "GET" &&
      response.ok &&
      roomMatch?.[2] === capture.kind
    ) {
      const eventId = roomMatch[3] ? safeDecode(roomMatch[3]) : undefined;
      if (capture.kind === "messages" || eventId === capture.eventId) {
        capture.pending.push(
          response
            .clone()
            .json()
            .then((body: unknown) => {
              capture.bodies.push(body);
            })
            .catch(() => undefined),
        );
      }
    }
    if (!response.ok && !isSync && response.status !== 403 && response.status !== 404) {
      this.#log("debug", "matrix request returned an error", {
        method,
        path: redactPath(path),
        status: response.status,
      });
    }
    return response;
  }

  #syncFailed(message: string): void {
    this.stats.consecutiveSyncFailures += 1;
    this.stats.lastSyncErrorAt = Date.now();
    this.stats.lastSyncError = message;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Room and event IDs are fine in logs; this only shortens them. */
function redactPath(path: string): string {
  return path.replace(/^\/_matrix\/client\/(v3|v1|r0|unstable)/, "");
}
