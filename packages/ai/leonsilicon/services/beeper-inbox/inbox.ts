import { createHash, randomUUID } from "node:crypto";
import {
  codexHandoffBlock,
  DOT_NETWORKS,
  slackIdentifier,
  slackThread,
  taskName,
} from "#slack-handoff";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DIRECTORY_FILTER,
  RoomDirectory,
  roomsFromSync,
  type RoomRecord,
  type SyncBody,
} from "#directory";
import {
  accountPage,
  attachmentRefs,
  contentTypeFor,
  formatMessage,
  mediaKind,
  reactionsByTarget,
  refusedUploadReason,
  safeFilename,
  type FormattedMessage,
  type RawEvent,
} from "#format";
import {
  DERIVED_KEY_WINDOW_MS,
  idempotencyKey,
  payloadHash,
  SAFE_RESEND_WINDOW_MS,
  SendLedger,
  txnIdFor,
  type SendKind,
  type SendRecord,
} from "#ledger";
import { MatrixFetch, type SendGuard } from "#fetch";
import { MessageJournal } from "#journal";
import type { InboxPaths } from "#paths";
import type { PickleRuntime } from "#pickle";
import {
  loadPickleKey,
  pickleKeyFile,
  readAccount,
  readEnvSecrets,
  storeHasCrypto,
  writeJsonAtomic,
} from "#secrets";
import { TracedStore } from "#store-trace";
import {
  InboxError,
  type InboxAccount,
  type Logger,
  type MatrixClientEvent,
  type MatrixCryptoStatus,
  type MatrixMessageEvent,
  type MatrixSubscription,
  type PickleClient,
} from "#types";

export const VERSION = "0.1.1";

export interface RoomInfo {
  roomId: string;
  name: string | null;
  /** Short network name, as the feed channels use it: whatsapp, instagram, grok… */
  network: string;
  /** The bridge's own name for the network: "WhatsApp", "Instagram"… */
  networkName: string | null;
  /** The bridge, e.g. "instagramgo"; null for a plain Matrix room. */
  protocolId: string | null;
  networkId: string | null;
  isDirect: boolean;
  isMuted: boolean;
}
/** A page of history that takes longer than this is logged with where its time went. */
const SLOW_READ_MS = 3000;

export const LIMITS = {
  defaultPage: 30,
  maxPage: 100,
  maxTextChars: 4000,
  maxSendChars: 20_000,
  /** Decrypted media is held in memory twice (WASM and Node) on a 4 GB machine shared with Hermes. */
  maxDownloadBytes: 64 * 1024 * 1024,
  /** WhatsApp documents top out at 100 MB and most networks lower; Beeper's media limit applies too. */
  maxUploadBytes: 50 * 1024 * 1024,
  roundTripVerifyBytes: 16 * 1024 * 1024,
  directoryMaxAgeMs: 6 * 60 * 60_000,
  bridgeStatusWaitMs: 8_000,
  syncStaleMs: 5 * 60_000,
} as const;

export type InboxState = "starting" | "needs_login" | "ready" | "error" | "stopped";

/** Serializes async work: one history read at a time (raw capture), one send at a time (ledger). */
class Mutex {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(fn, fn);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

export interface InboxOptions {
  paths: InboxPaths;
  log: Logger;
  pickle: () => Promise<PickleRuntime>;
  baseFetch?: typeof fetch;
  now?: () => number;
  /** How long a send waits for the bridge's delivery status. */
  bridgeStatusWaitMs?: number;
}

interface BridgeStatus {
  status: string;
  reason?: string;
  message?: string;
  network?: string;
  at: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** A field from an event as text; objects aren't text. */
function text(value: unknown, fallback = ""): string {
  return typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : fallback;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function roomIdOf(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new InboxError("bad_argument", "room_id is required");
  const roomId = value.trim();
  // Opaque: "!abc:beeper.local", "!abc:beeper.com", and room v12 IDs with no server part ("!<hash>").
  if (!/^![^\s/]{3,255}$/.test(roomId)) {
    throw new InboxError(
      "bad_argument",
      `"${roomId.slice(0, 80)}" is not a Matrix room ID (they start with "!", like !abc123:beeper.local). Use list_conversations to find one; the chat IDs in the Slack #feed- posts are room IDs.`,
    );
  }
  return roomId;
}

function eventIdOf(value: unknown, field = "event_id"): string {
  if (typeof value !== "string" || !value.trim())
    throw new InboxError("bad_argument", `${field} is required`);
  const eventId = value.trim();
  if (!eventId.startsWith("$")) {
    throw new InboxError(
      "bad_argument",
      `${field} "${eventId.slice(0, 80)}" is not a Matrix event ID (they start with $). A Slack ts like 1793918187.574419 is not one; get event IDs from list_messages.`,
    );
  }
  return eventId;
}

export class Inbox {
  readonly #paths: InboxPaths;
  readonly #log: Logger;
  readonly #pickle: () => Promise<PickleRuntime>;
  readonly #baseFetch: typeof fetch;
  readonly #now: () => number;
  readonly #bridgeStatusWaitMs: number;
  readonly #read = new Mutex();
  readonly #send = new Mutex();
  readonly #download = new Mutex();
  readonly #directoryRefresh = new Mutex();
  readonly #decryptErrors = new Map<string, string>();
  readonly #bridgeStatus = new Map<string, BridgeStatus>();
  readonly #profiles = new Map<string, { name: string | null; at: number }>();
  readonly #fetch: MatrixFetch;
  #db: DatabaseSync | null = null;
  #pickleDb: DatabaseSync | null = null;
  #store: TracedStore | null = null;
  #directory: RoomDirectory | null = null;
  #ledger: SendLedger | null = null;
  #journal: MessageJournal | null = null;
  /** Rooms Leon muted, from his push rules; null until they have been read. */
  #muted: Set<string> | null = null;
  #mutedAt = 0;
  #client: PickleClient | null = null;
  #subscription: MatrixSubscription | null = null;
  #account: InboxAccount | null = null;
  #accessToken: string | null = null;
  #state: InboxState = "starting";
  #stateError: string | null = null;
  #secretsFingerprint: string | null = null;
  #rejectedFingerprint: string | null = null;
  #secretProblems: string[] = [];
  #startedAt: number;
  #bootedAt: number | null = null;
  #verifiedAt: string | null = null;
  #cryptoEvents: Array<{ state: string; at: string; error?: string }> = [];
  #syncState: { state: string; at: number; error?: string } = { state: "idle", at: 0 };
  #resubscribeTimer: NodeJS.Timeout | null = null;

  constructor(options: InboxOptions) {
    this.#paths = options.paths;
    this.#log = options.log;
    this.#pickle = options.pickle;
    this.#baseFetch = options.baseFetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#bridgeStatusWaitMs = options.bridgeStatusWaitMs ?? LIMITS.bridgeStatusWaitMs;
    this.#startedAt = this.#now();
    this.#fetch = new MatrixFetch(this.#baseFetch, options.log);
  }

  get state(): InboxState {
    return this.#state;
  }

  /** Opens the stores and signs in. Never throws: failures leave the state at needs_login or error. */
  async start(): Promise<void> {
    this.#state = "starting";
    this.#stateError = null;
    try {
      this.#openDatabases();
      const account = readAccount(this.#paths.account);
      const env = readEnvSecrets(this.#paths.hermesEnv);
      this.#secretsFingerprint = this.#fingerprint();
      this.#rejectedFingerprint = null;
      this.#secretProblems = env.problems;
      for (const problem of env.problems) this.#log("warn", "secret problem", { problem });
      if (!account || !env.accessToken) {
        this.#state = "needs_login";
        this.#stateError = !account
          ? `no device yet: ${this.#paths.account} is missing`
          : "BEEPER_INBOX_ACCESS_TOKEN is missing from Hermes's .env";
        this.#log("warn", "beeper-inbox needs a login", { reason: this.#stateError });
        return;
      }
      if (env.fatal.length) throw new InboxError("bad_secret", env.fatal.join("; "));
      const key = loadPickleKey(
        pickleKeyFile(this.#paths.state, account.deviceId),
        storeHasCrypto(this.#pickleDb as DatabaseSync, account.deviceId),
        env.legacyPickleKey,
      );
      if (key.source !== "file")
        this.#log("info", "pickle key ready", { source: key.source, deviceId: account.deviceId });
      this.#secretsFingerprint = this.#fingerprint();
      const secrets = {
        accessToken: env.accessToken,
        pickleKey: key.pickleKey,
        ...(env.recoveryKey ? { recoveryKey: env.recoveryKey } : {}),
      };
      this.#account = account;
      this.#accessToken = secrets.accessToken;
      const verifiedPath = join(this.#paths.state, "verified.json");
      const verified = existsSync(verifiedPath)
        ? (JSON.parse(readFileSync(verifiedPath, "utf8")) as {
            verifiedAt?: string;
            deviceId?: string;
          })
        : null;
      const needsVerification =
        Boolean(secrets.recoveryKey) && verified?.deviceId !== account.deviceId;
      const runtime = await this.#pickle();
      const store = new TracedStore(runtime.createStore(this.#pickleDb as DatabaseSync));
      this.#store = store;
      const client = runtime.createMatrixClient({
        account: {
          accessToken: secrets.accessToken,
          deviceId: account.deviceId,
          homeserver: account.homeserver,
          userId: account.userId,
        },
        fetch: this.#fetch.fetch,
        logger: (level, message) => {
          if (level === "warn" || level === "error") this.#log(level, `pickle: ${message}`);
        },
        pickleKey: secrets.pickleKey,
        ...(secrets.recoveryKey ? { recoveryKey: secrets.recoveryKey } : {}),
        store,
        verifyRecoveryOnStart: needsVerification,
      });
      this.#client = client;
      const whoami = await client.boot();
      if (whoami.deviceId !== account.deviceId || whoami.userId !== account.userId) {
        throw new InboxError(
          "device_mismatch",
          `the access token belongs to ${whoami.userId} device ${whoami.deviceId}, but the store is for ${account.userId} device ${account.deviceId}`,
        );
      }
      const crypto = await client.crypto.status();
      if (needsVerification) {
        if (crypto.state === "recoveryRestored" || crypto.state === "keyBackupUpdated") {
          this.#verifiedAt = new Date(this.#now()).toISOString();
          writeJsonAtomic(verifiedPath, {
            deviceId: account.deviceId,
            verifiedAt: this.#verifiedAt,
            keyBackupVersion: crypto.keyBackupVersion ?? null,
            cryptoState: crypto.state,
          });
          this.#log("info", "device cross-signed from the recovery key", {
            deviceId: account.deviceId,
            keyBackupVersion: crypto.keyBackupVersion,
          });
        } else {
          this.#log("warn", "recovery did not complete", { cryptoState: crypto.state });
        }
      } else {
        this.#verifiedAt = verified?.verifiedAt ?? null;
      }
      this.#bootedAt = this.#now();
      await this.#subscribe();
      void this.refreshMuted();
      this.#state = "ready";
      this.#log("info", "beeper-inbox ready", {
        userId: account.userId,
        deviceId: account.deviceId,
        cryptoState: crypto.state,
      });
      const refreshedAt = this.#directory?.refreshedAt() ?? null;
      if (!refreshedAt || this.#now() - refreshedAt > LIMITS.directoryMaxAgeMs) {
        void this.refreshDirectory().catch((error: unknown) =>
          this.#log("warn", "directory refresh failed", { error: String(error) }),
        );
      }
    } catch (error) {
      this.#state = "error";
      this.#stateError = error instanceof Error ? error.message : String(error);
      this.#log("error", "beeper-inbox failed to start", { error: this.#stateError });
      await this.#closeClient();
    }
  }

  /** Stops syncing and closes the stores. The device stays signed in: no logout. */
  async stop(): Promise<void> {
    if (this.#resubscribeTimer) clearTimeout(this.#resubscribeTimer);
    this.#resubscribeTimer = null;
    await this.#closeClient();
    this.#db?.close();
    this.#pickleDb?.close();
    this.#db = null;
    this.#pickleDb = null;
    this.#directory = null;
    this.#ledger = null;
    this.#journal = null;
    this.#state = "stopped";
  }

  /** Re-reads the account and secrets (after a login) and starts again in the same process. */
  async reload(): Promise<void> {
    await this.stop();
    await this.start();
  }

  #openDatabases(): void {
    if (this.#db && this.#pickleDb) return;
    const open = (path: string) => {
      const db = new DatabaseSync(path, { timeout: 0 });
      // Only the lock holder opens these; EXCLUSIVE makes any second opener fail instead of racing.
      db.exec("PRAGMA locking_mode=EXCLUSIVE");
      db.exec("PRAGMA journal_mode=WAL");
      db.exec("PRAGMA synchronous=FULL");
      return db;
    };
    this.#db = open(this.#paths.inboxDb);
    this.#pickleDb = open(this.#paths.pickleDb);
    this.#directory = new RoomDirectory(this.#db);
    this.#journal = new MessageJournal(this.#db, this.#now());
    this.#journal.prune(this.#now());
    this.#ledger = new SendLedger(this.#db);
    this.#ledger.prune(30 * 24 * 60 * 60_000, this.#now());
  }

  async #closeClient(): Promise<void> {
    const subscription = this.#subscription;
    const client = this.#client;
    this.#subscription = null;
    this.#client = null;
    try {
      await subscription?.stop();
    } catch (error) {
      this.#log("warn", "stopping sync failed", { error: String(error) });
    }
    try {
      await client?.close();
    } catch (error) {
      this.#log("warn", "closing the Matrix client failed", { error: String(error) });
    }
  }

  /**
   * Background sync: keeps to-device room keys, device lists and the directory current. It only updates
   * local state; nothing here creates Hermes tasks or contacts anyone.
   */
  async #subscribe(): Promise<void> {
    const client = this.#client;
    if (!client) return;
    const subscription = await client.subscribe(undefined, (event) => this.#onEvent(event), {
      timeoutMs: 30_000,
      retryDelayMs: 2_000,
    });
    this.#subscription = subscription;
    // Only an unplanned end restarts sync: stop() and restartSync() clear #subscription first.
    subscription.done.then(
      () => {
        if (this.#subscription === subscription) this.#scheduleResubscribe("sync stopped");
      },
      (error: unknown) => {
        if (this.#subscription === subscription) this.#scheduleResubscribe(String(error));
      },
    );
  }

  #scheduleResubscribe(reason: string): void {
    if (!this.#client || this.#resubscribeTimer) return;
    this.#subscription = null;
    this.#log("warn", "sync ended; restarting it", { reason });
    this.#resubscribeTimer = setTimeout(() => {
      this.#resubscribeTimer = null;
      void this.#subscribe().catch((error: unknown) => {
        this.#log("error", "sync restart failed", { error: String(error) });
        this.#scheduleResubscribe(String(error));
      });
    }, 10_000);
    this.#resubscribeTimer.unref();
  }

  #onEvent(event: MatrixClientEvent): void {
    const kind = event.kind;
    if (kind === "sync") {
      this.#syncState = {
        state: String(event.state),
        at: this.#now(),
        ...(event.error ? { error: text(event.error) } : {}),
      };
      return;
    }
    if (kind === "accountData" && event.type === "m.push_rules") {
      this.#setMuted((event.content as { global?: unknown } | undefined)?.global);
      return;
    }
    if (kind === "crypto") {
      this.#cryptoEvents.push({
        state: String(event.state),
        at: new Date(this.#now()).toISOString(),
        ...(event.error ? { error: text(event.error) } : {}),
      });
      if (this.#cryptoEvents.length > 20) this.#cryptoEvents.shift();
      return;
    }
    if (kind === "decryptionError") {
      const target = event.event as
        | { eventId?: string; roomId?: string; senderId?: string }
        | undefined;
      if (target?.eventId && target.roomId) {
        try {
          this.#journal?.pending(target.roomId, target.eventId, target.senderId ?? "", this.#now());
        } catch (error) {
          this.#log("debug", "journal update failed", { error: String(error) });
        }
      }
      if (target?.eventId) {
        this.#decryptErrors.set(target.eventId, text(event.error));
        if (this.#decryptErrors.size > 5000) {
          const oldest = this.#decryptErrors.keys().next().value;
          if (oldest) this.#decryptErrors.delete(oldest);
        }
      }
      return;
    }
    const roomId = typeof event.roomId === "string" ? event.roomId : null;
    if (!roomId) return;
    const type = typeof event.type === "string" ? event.type : "";
    const content = (event.content ?? {}) as Record<string, unknown>;
    if (type === "com.beeper.message_send_status") {
      const rel = content["m.relates_to"] as { event_id?: string } | undefined;
      if (rel?.event_id) {
        this.#bridgeStatus.set(rel.event_id, {
          status: text(content.status, "unknown"),
          ...(content.reason ? { reason: text(content.reason) } : {}),
          ...(content.message ? { message: text(content.message) } : {}),
          ...(content.network ? { network: text(content.network) } : {}),
          at: this.#now(),
        });
        if (this.#bridgeStatus.size > 500) {
          const oldest = this.#bridgeStatus.keys().next().value;
          if (oldest) this.#bridgeStatus.delete(oldest);
        }
      }
      return;
    }
    try {
      if (kind === "message") this.#journalMessage(event as unknown as MatrixMessageEvent);
      else if (kind === "redaction") {
        const redacts =
          content.redacts ?? (event.raw as { redacts?: unknown } | undefined)?.redacts;
        if (typeof redacts === "string") this.#journal?.redact(redacts);
      }
    } catch (error) {
      // The journal must never get in sync's way.
      this.#log("warn", "journal update failed", { error: String(error) });
    }
    try {
      if (type === "m.room.name" && typeof content.name === "string" && content.name.trim())
        this.#directory?.rename(roomId, content.name.trim());
      const ts = typeof event.timestamp === "number" ? event.timestamp : null;
      if (ts && (kind === "message" || type === "m.room.encrypted" || type === "m.room.message")) {
        const sender = (event.sender as { userId?: string } | undefined)?.userId ?? null;
        this.#directory?.touch(roomId, ts, sender);
      }
    } catch (error) {
      this.#log("debug", "directory update failed", { error: String(error) });
    }
  }

  /** Writes one message from sync (or from a late decryption) into the journal. */
  #journalMessage(message: MatrixMessageEvent): void {
    const journal = this.#journal;
    if (!journal || !message.eventId || !message.roomId) return;
    // An edit carries the new text in m.new_content; its own body is a "* …" fallback.
    const fresh = message.replaces
      ? (message.content?.["m.new_content"] as
          | { body?: unknown; formatted_body?: unknown; msgtype?: unknown }
          | undefined)
      : undefined;
    journal.record(
      {
        roomId: message.roomId,
        eventId: message.eventId,
        sender: message.sender.userId,
        isMe: message.sender.isMe,
        type: typeof fresh?.msgtype === "string" ? fresh.msgtype : message.messageType,
        text:
          typeof fresh?.body === "string"
            ? fresh.body
            : message.replaces
              ? (message.text ?? "").replace(/^\* /, "")
              : (message.text ?? ""),
        html: fresh
          ? typeof fresh.formatted_body === "string"
            ? fresh.formatted_body
            : undefined
          : message.html,
        ts: typeof message.timestamp === "number" ? message.timestamp : this.#now(),
        replaces: message.replaces,
        replyTo: message.replyTo,
        attachments: message.attachments?.length ?? 0,
      },
      this.#now(),
    );
  }

  /**
   * Beeper keeps a muted chat as a Matrix push rule for the room with no "notify" action
   * (measured 2026-11-21: 213 room rules, actions [] or ["dont_notify"], and no Beeper-specific field).
   */
  #setMuted(global: unknown): void {
    const rules = (global as { room?: unknown } | undefined)?.room;
    if (!Array.isArray(rules)) return;
    const muted = new Set<string>();
    for (const rule of rules as Array<{
      rule_id?: unknown;
      actions?: unknown;
      enabled?: unknown;
    }>) {
      if (typeof rule.rule_id !== "string" || rule.enabled === false) continue;
      const actions = Array.isArray(rule.actions) ? rule.actions : [];
      if (!actions.includes("notify")) muted.add(rule.rule_id);
    }
    this.#muted = muted;
    this.#mutedAt = this.#now();
  }

  /** Reads Leon's muted chats from the homeserver. Sync also brings changes to them as they happen. */
  async refreshMuted(): Promise<void> {
    try {
      const response = await this.#matrix("/_matrix/client/v3/pushrules/", { timeoutMs: 20_000 });
      if (response.status === 200)
        this.#setMuted((response.body as { global?: unknown } | null)?.global);
      else this.#log("warn", "couldn't read the muted chats", { status: response.status });
    } catch (error) {
      this.#log("warn", "couldn't read the muted chats", { error: String(error) });
    }
  }

  /** What an extension needs to know about rooms: name, network, connection, direct, muted. */
  rooms(roomIds: readonly string[]): RoomInfo[] {
    const { directory } = this.#ready();
    const out: RoomInfo[] = [];
    for (const roomId of new Set(roomIds)) {
      const record = directory.get(roomId);
      if (!record) continue;
      out.push({
        roomId,
        name: record.name,
        network: record.network,
        networkName: record.bridge?.protocolName ?? null,
        protocolId: record.bridge?.protocolId ?? null,
        networkId: record.bridge?.networkId ?? null,
        isDirect: record.isDirect,
        isMuted: this.#muted?.has(roomId) ?? false,
      });
    }
    return out;
  }

  /** Each connection Leon's rooms belong to (see RoomDirectory.connections). */
  connections(): ReturnType<RoomDirectory["connections"]> {
    return this.#ready().directory.connections();
  }

  /** Display names for Matrix user IDs, where the homeserver has one. */
  async names(userIds: readonly string[]): Promise<Record<string, string>> {
    this.#ready();
    return Object.fromEntries(await this.#senderNames(userIds));
  }

  /** The journal of messages as sync delivered them (see journal.ts). */
  get journal(): MessageJournal {
    if (!this.#journal)
      throw new InboxError("not_ready", "beeper-inbox's stores aren't open (it is stopping)");
    return this.#journal;
  }

  /**
   * Once a minute: keeps the journal's coverage current, drops what is past its retention, and tries
   * again to read events that arrived before their keys did.
   */
  async journalTick(): Promise<void> {
    const journal = this.#journal;
    const client = this.#client;
    if (!journal) return;
    journal.alive(this.#now());
    journal.prune(this.#now());
    if (!client || this.#state !== "ready") return;
    if (this.#now() - this.#mutedAt > 10 * 60_000) await this.refreshMuted();
    for (const due of journal.pendingDue(this.#now())) {
      try {
        const { message } = await this.#read.run(() =>
          client.messages.get({ roomId: due.roomId, eventId: due.eventId }),
        );
        if (message) this.#journalMessage(message);
      } catch (error) {
        this.#log("debug", "late decryption failed", {
          eventId: due.eventId,
          error: String(error),
        });
      }
    }
  }

  #ready(): {
    client: PickleClient;
    account: InboxAccount;
    directory: RoomDirectory;
    ledger: SendLedger;
  } {
    if (this.#state === "needs_login") {
      throw new InboxError(
        "not_logged_in",
        `beeper-inbox isn't signed in yet (${this.#stateError}). Ask Leon; the login steps are in the beeper-inbox README.`,
      );
    }
    if (
      this.#state !== "ready" ||
      !this.#client ||
      !this.#account ||
      !this.#directory ||
      !this.#ledger
    ) {
      throw new InboxError(
        "unavailable",
        `beeper-inbox is ${this.#state}${this.#stateError ? `: ${this.#stateError}` : ""}`,
      );
    }
    return {
      client: this.#client,
      account: this.#account,
      directory: this.#directory,
      ledger: this.#ledger,
    };
  }

  /** A Matrix request made directly (not through Pickle): metadata only, never anything encrypted. */
  async #matrix(
    path: string,
    init: { method?: string; query?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<{ status: number; body: unknown }> {
    const account = this.#account;
    if (!account || !this.#accessToken) throw new InboxError("unavailable", "not signed in");
    const url = new URL(path, account.homeserver);
    for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
    const response = await this.#baseFetch(url, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${this.#accessToken}` },
      signal: AbortSignal.timeout(init.timeoutMs ?? 60_000),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text.slice(0, 500);
    }
    return { status: response.status, body };
  }

  async #isJoined(roomId: string): Promise<boolean> {
    if (this.#directory?.get(roomId)) return true;
    const membership = await this.#matrix(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(this.#account?.userId ?? "")}`,
    );
    return (
      membership.status === 200 &&
      (membership.body as { membership?: string } | null)?.membership === "join"
    );
  }

  async #requireJoined(roomId: string): Promise<void> {
    if (!(await this.#isJoined(roomId))) {
      throw new InboxError(
        "not_found",
        `${roomId} isn't one of Leon's joined conversations on this account. Room IDs are used exactly as given (a :beeper.local suffix is normal); find the right one with list_conversations.`,
      );
    }
  }

  async #roomEncrypted(roomId: string): Promise<boolean> {
    const known = this.#directory?.get(roomId);
    if (known?.encrypted) return true;
    const state = await this.#matrix(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.encryption/`,
    );
    if (state.status === 200) return true;
    if (state.status === 404) return false;
    throw new InboxError(
      "unavailable",
      `couldn't read ${roomId}'s encryption state (HTTP ${state.status})`,
    );
  }

  async #senderNames(userIds: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const now = this.#now();
    const missing: string[] = [];
    for (const userId of new Set(userIds)) {
      const cached = this.#profiles.get(userId);
      if (cached && now - cached.at < 60 * 60_000) {
        if (cached.name) out.set(userId, cached.name);
      } else missing.push(userId);
    }
    for (let i = 0; i < Math.min(missing.length, 40); i += 8) {
      await Promise.all(
        missing.slice(i, i + 8).map(async (userId) => {
          try {
            const profile = await this.#matrix(
              `/_matrix/client/v3/profile/${encodeURIComponent(userId)}/displayname`,
              { timeoutMs: 10_000 },
            );
            const name =
              profile.status === 200
                ? ((profile.body as { displayname?: string } | null)?.displayname ?? null)
                : null;
            this.#profiles.set(userId, { name, at: now });
            if (name) out.set(userId, name);
          } catch {
            // a name is a convenience
          }
        }),
      );
    }
    return out;
  }

  // ── Conversations ────────────────────────────────────────────────────────────────────────────────

  async refreshDirectory(): Promise<{ rooms: number; refreshed_at: string; ms: number }> {
    return this.#directoryRefresh.run(async () => {
      const { account, directory } = this.#ready();
      const started = this.#now();
      // A sync without `since` is a stateless snapshot: it doesn't acknowledge to-device messages or
      // move Pickle's cursor, so it can't take room keys away from the owner's own sync.
      const response = await this.#matrix("/_matrix/client/v3/sync", {
        query: { filter: JSON.stringify(DIRECTORY_FILTER), timeout: "0", set_presence: "offline" },
        timeoutMs: 180_000,
      });
      if (response.status !== 200)
        throw new InboxError("unavailable", `directory sync failed: HTTP ${response.status}`);
      const records = roomsFromSync(response.body as SyncBody, account.userId, this.#now());
      directory.replaceAll(records, this.#now());
      const ms = this.#now() - started;
      this.#log("info", "directory refreshed", { rooms: records.length, ms });
      return { rooms: records.length, refreshed_at: new Date(this.#now()).toISOString(), ms };
    });
  }

  #conversation(record: RoomRecord): Record<string, unknown> {
    return {
      room_id: record.roomId,
      name: record.name,
      network: record.network,
      network_display_name: record.bridge?.protocolName ?? null,
      bridge: record.bridge
        ? {
            protocol_id: record.bridge.protocolId,
            bridge_bot: record.bridge.bridgeBot,
            channel_name: record.bridge.channelName,
            channel_id: record.bridge.channelId,
            network_id: record.bridge.networkId ?? null,
            account: record.bridge.receiver,
            room_type: record.bridge.roomType,
          }
        : null,
      is_direct: record.isDirect,
      ...(this.#muted ? { is_muted: this.#muted.has(record.roomId) } : {}),
      member_count: record.memberCount,
      encrypted: record.encrypted,
      last_activity: record.lastEventTs ? new Date(record.lastEventTs).toISOString() : null,
      ...(record.heroes.length && record.name !== record.heroes.join(", ")
        ? { participants: record.heroes }
        : {}),
      ...(record.tags.length ? { tags: record.tags } : {}),
    };
  }

  async listConversations(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { directory } = this.#ready();
    if (args.refresh === true || directory.count() === 0) await this.refreshDirectory();
    const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 100);
    const offset = Math.max(Number(args.offset ?? 0) || 0, 0);
    const query = typeof args.query === "string" ? args.query.trim() : "";
    const network =
      typeof args.network === "string" && args.network.trim() ? args.network.trim() : undefined;
    const isDirect = typeof args.direct_only === "boolean" && args.direct_only ? true : undefined;
    const result = directory.search({
      ...(query ? { query } : {}),
      ...(network ? { network } : {}),
      ...(isDirect !== undefined ? { isDirect } : {}),
      limit,
      offset,
    });
    const refreshedAt = directory.refreshedAt();
    return {
      conversations: result.rooms.map((room) => this.#conversation(room)),
      total: result.total,
      offset,
      next_offset:
        offset + result.rooms.length < result.total ? offset + result.rooms.length : null,
      directory_refreshed_at: refreshedAt ? new Date(refreshedAt).toISOString() : null,
      note: "Sorted by last activity. Names come from room state; search matches names, participants and bridge channel names. Use the exact room_id with the other tools.",
    };
  }

  async getConversation(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { client, directory } = this.#ready();
    const roomId = roomIdOf(args.room_id);
    await this.#requireJoined(roomId);
    let record = directory.get(roomId);
    if (!record) {
      await this.refreshDirectory();
      record = directory.get(roomId);
    }
    const info = await client.rooms.get({ roomId });
    return {
      ...(record ? this.#conversation(record) : { room_id: roomId, network: "unknown" }),
      name: record?.name ?? info.name ?? null,
      member_count: info.memberCount ?? record?.memberCount ?? null,
      encrypted: info.encrypted || Boolean(record?.encrypted),
      ...(info.directUserId ? { direct_user_id: info.directUserId } : {}),
    };
  }

  // ── Messages ─────────────────────────────────────────────────────────────────────────────────────

  async listMessages(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { client, directory } = this.#ready();
    const roomId = roomIdOf(args.room_id);
    await this.#requireJoined(roomId);
    const limit = Math.min(
      Math.max(Number(args.limit ?? LIMITS.defaultPage) || LIMITS.defaultPage, 1),
      LIMITS.maxPage,
    );
    const cursor = typeof args.cursor === "string" && args.cursor ? args.cursor : undefined;
    const direction = args.direction === "forward" ? "forward" : "backward";
    if (direction === "forward" && !cursor)
      throw new InboxError("bad_argument", "direction forward needs a cursor from an earlier page");
    const requested = Date.now();
    const { page, raw, readMs, trace, stored } = await this.#read.run(async () => {
      const started = Date.now();
      const capture = this.#fetch.beginCapture("messages", roomId);
      const requests = this.#fetch.beginTrace();
      const stored = this.#store?.begin() ?? null;
      try {
        const result = await client.messages.list({
          roomId,
          limit,
          direction,
          ...(cursor ? { cursor } : {}),
        });
        await this.#fetch.endCapture();
        const first = capture.bodies[0] as { chunk?: RawEvent[] } | undefined;
        return {
          page: result,
          raw: first?.chunk ?? null,
          readMs: Date.now() - started,
          trace: requests,
          stored,
        };
      } catch (error) {
        await this.#fetch.endCapture();
        throw error;
      } finally {
        this.#fetch.endTrace(requests);
        if (stored) this.#store?.end(stored);
      }
    });
    const elapsed = Date.now() - requested;
    if (elapsed > SLOW_READ_MS) {
      // Where a slow page spent its time: waiting its turn, on the homeserver, or decrypting.
      const kinds = new Map<string, { count: number; ms: number }>();
      for (const request of trace.requests) {
        const kind = kinds.get(request.kind) ?? { count: 0, ms: 0 };
        kind.count += 1;
        kind.ms += request.ms;
        kinds.set(request.kind, kind);
      }
      this.#log("warn", "slow read", {
        roomId,
        limit,
        events: raw?.length ?? null,
        messages: page.messages.length,
        ms: elapsed,
        queuedMs: elapsed - readMs,
        requests: trace.requests.length,
        requestMs: trace.requests.reduce((sum, request) => sum + request.ms, 0),
        byKind: Object.fromEntries([...kinds].sort((a, b) => b[1].ms - a[1].ms).slice(0, 6)),
        storeMs: Math.round([...(stored?.ops.values() ?? [])].reduce((sum, op) => sum + op.ms, 0)),
        store: Object.fromEntries(
          [...(stored?.ops ?? [])]
            .sort((a, b) => b[1].bytes - a[1].bytes)
            .slice(0, 8)
            .map(([kind, op]) => [kind, { ...op, ms: Math.round(op.ms) }]),
        ),
      });
    }
    const returned = new Set(page.messages.map((message) => message.eventId));
    const accounting = raw ? accountPage(raw, returned, this.#decryptErrors) : null;
    const reactions = raw ? reactionsByTarget(raw) : new Map();
    const names = await this.#senderNames(page.messages.map((message) => message.sender.userId));
    const messages: FormattedMessage[] = page.messages.map((message) => {
      const formatted = formatMessage(message, {
        maxText: LIMITS.maxTextChars,
        senderName: names.get(message.sender.userId),
      });
      const byKey = reactions.get(message.eventId);
      if (byKey)
        formatted.reactions = [...byKey].map(([key, senders]) => ({
          key,
          count: senders.size,
          senders: [...senders],
        }));
      return formatted;
    });
    const record = directory.get(roomId);
    const undecryptable = accounting?.undecryptable ?? [];
    return {
      conversation: {
        room_id: roomId,
        name: record?.name ?? null,
        network: record?.network ?? null,
      },
      messages,
      order: "oldest first",
      next_cursor: page.nextCursor ?? null,
      direction,
      complete: accounting ? undecryptable.length === 0 : false,
      undecryptable,
      omitted: accounting
        ? {
            thread_replies: accounting.thread_replies,
            other_events: accounting.other.slice(0, 20),
            other_count: accounting.other.length,
            edits_merged: accounting.edits_merged,
            reactions: accounting.reactions,
            redacted: accounting.redacted,
            state_events: accounting.state_events,
          }
        : null,
      raw_event_count: accounting?.raw_events ?? null,
      ...(accounting
        ? {}
        : { warning: "the raw page wasn't captured, so omitted events can't be accounted for" }),
      ...(undecryptable.length
        ? {
            decryption_note: `${undecryptable.length} event(s) in this page could not be decrypted; their text is unavailable. See inbox_status for key backup state.`,
          }
        : {}),
    };
  }

  async #getMessage(
    roomId: string,
    eventId: string,
  ): Promise<{ message: MatrixMessageEvent | null; raw: RawEvent | null }> {
    const { client } = this.#ready();
    return this.#read.run(async () => {
      const capture = this.#fetch.beginCapture("event", roomId, eventId);
      try {
        const result = await client.messages.get({ roomId, eventId });
        await this.#fetch.endCapture();
        return {
          message: result.message,
          raw: (capture.bodies[0] as RawEvent | undefined) ?? null,
        };
      } catch (error) {
        await this.#fetch.endCapture();
        const text = String(error);
        if (/M_NOT_FOUND|404/.test(text))
          throw new InboxError("not_found", `event ${eventId} wasn't found in ${roomId}`);
        throw error;
      }
    });
  }

  async getMessage(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.#ready();
    const roomId = roomIdOf(args.room_id);
    const eventId = eventIdOf(args.event_id);
    await this.#requireJoined(roomId);
    const { message, raw } = await this.#getMessage(roomId, eventId);
    if (!message) {
      const type = raw?.type ?? "unknown";
      const error = this.#decryptErrors.get(eventId);
      const base = {
        room_id: roomId,
        event_id: eventId,
        type,
        sender: raw?.sender ?? null,
        timestamp:
          typeof raw?.origin_server_ts === "number"
            ? new Date(raw.origin_server_ts).toISOString()
            : null,
      };
      if (type === "m.room.encrypted" && error)
        return { ...base, decrypted: false, error: `could not decrypt: ${error}` };
      return {
        ...base,
        decrypted: type !== "m.room.encrypted",
        note: "this event isn't a message (or decrypts to a non-message type)",
        ...(raw && type !== "m.room.encrypted" ? { content: raw.content ?? null } : {}),
      };
    }
    const names = await this.#senderNames([message.sender.userId]);
    return {
      ...formatMessage(message, {
        maxText: LIMITS.maxSendChars,
        senderName: names.get(message.sender.userId),
        includeHtml: true,
      }),
      raw_type: raw?.type ?? null,
      decrypted: true,
    };
  }

  // ── Attachments ──────────────────────────────────────────────────────────────────────────────────

  async downloadAttachment(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { client } = this.#ready();
    const roomId = roomIdOf(args.room_id);
    const eventId = eventIdOf(args.event_id);
    const index = Math.max(Number(args.attachment_index ?? 0) || 0, 0);
    await this.#requireJoined(roomId);
    const { message, raw } = await this.#getMessage(roomId, eventId);
    if (!message) {
      const error = this.#decryptErrors.get(eventId);
      throw new InboxError(
        error ? "undecryptable" : "not_found",
        error
          ? `event ${eventId} could not be decrypted (${error}), so its attachment keys are unavailable`
          : `event ${eventId} isn't a message with attachments`,
        { raw_type: raw?.type ?? null },
      );
    }
    const attachment = message.attachments[index];
    if (!attachment) {
      throw new InboxError(
        "not_found",
        `event ${eventId} has ${message.attachments.length} attachment(s); index ${index} doesn't exist`,
        {
          attachments: attachmentRefs(message.attachments),
        },
      );
    }
    if (typeof attachment.size === "number" && attachment.size > LIMITS.maxDownloadBytes) {
      throw new InboxError(
        "too_large",
        `the attachment is ${attachment.size} bytes; the limit is ${LIMITS.maxDownloadBytes}`,
      );
    }
    if (!attachment.encryptedFile && !attachment.contentUri)
      throw new InboxError("not_found", "the attachment has no media URI");
    const bytes = await this.#download.run(async () => {
      const result = attachment.encryptedFile
        ? await client.media.downloadEncrypted({ file: attachment.encryptedFile })
        : await client.media.download({ contentUri: attachment.contentUri as string });
      return result.bytes;
    });
    if (bytes.byteLength > LIMITS.maxDownloadBytes)
      throw new InboxError("too_large", `downloaded ${bytes.byteLength} bytes, over the limit`);
    const digest = sha256(bytes);
    const filename = safeFilename(
      attachment.filename ?? (message.messageType !== "m.text" ? message.text : null),
      `attachment-${index}`,
    );
    const day = new Date(message.timestamp ?? this.#now()).toISOString().slice(0, 10);
    const dir = join(this.#paths.downloads, day);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${digest.slice(0, 12)}-${filename}`);
    if (!existsSync(path) || statSync(path).size !== bytes.byteLength) {
      const temp = `${path}.${randomUUID()}.part`;
      writeFileSync(temp, bytes, { mode: 0o644 });
      renameSync(temp, path);
    }
    const warnings: string[] = [];
    if (typeof attachment.size === "number" && attachment.size !== bytes.byteLength) {
      warnings.push(
        `the event says ${attachment.size} bytes but ${bytes.byteLength} were downloaded`,
      );
    }
    return {
      path,
      filename,
      content_type: attachment.contentType ?? contentTypeFor(filename),
      bytes: bytes.byteLength,
      sha256: digest,
      encrypted: Boolean(attachment.encryptedFile),
      mxc: attachment.encryptedFile?.url ?? attachment.contentUri ?? null,
      room_id: roomId,
      event_id: eventId,
      sender: message.sender.userId,
      timestamp: message.timestamp ? new Date(message.timestamp).toISOString() : null,
      ...(warnings.length ? { warnings } : {}),
      note: "Saved on Hermes's persistent volume; open it with your file or vision tools at this path.",
    };
  }

  // ── Sending ──────────────────────────────────────────────────────────────────────────────────────

  /**
   * Runs one ledgered send. Under the send mutex, so overlapping requests with the same key wait for
   * the first and get its result instead of sending again.
   */
  async #ledgered(
    roomId: string,
    kind: SendKind,
    hash: string,
    explicitKey: string | undefined,
    expectEncrypted: boolean,
    send: () => Promise<{ eventId: string }>,
  ): Promise<{ record: SendRecord; deduplicated: boolean; resent: boolean }> {
    const { ledger } = this.#ready();
    let keyed: { key: string; derived: boolean };
    try {
      keyed = idempotencyKey(explicitKey, roomId, kind, hash);
    } catch (error) {
      throw new InboxError("bad_argument", (error as Error).message);
    }
    return this.#send.run(async () => {
      const now = this.#now();
      let existing = ledger.get(keyed.key);
      if (existing && !keyed.derived && existing.payloadHash !== hash) {
        throw new InboxError(
          "bad_argument",
          "this idempotency_key was already used for different content; use a new key",
        );
      }
      if (
        existing &&
        keyed.derived &&
        now - existing.createdAt > DERIVED_KEY_WINDOW_MS &&
        existing.status !== "pending" &&
        existing.status !== "unknown"
      ) {
        ledger.retire(keyed.key, now);
        existing = null;
      }
      if (existing?.status === "sent")
        return { record: existing, deduplicated: true, resent: false };
      if (
        existing &&
        (existing.status === "unknown" || existing.status === "pending") &&
        now - existing.updatedAt > SAFE_RESEND_WINDOW_MS
      ) {
        throw new InboxError(
          "delivery_unknown",
          `an earlier attempt with this key (${existing.attempts} attempt(s), last ${new Date(existing.updatedAt).toISOString()}) may or may not have been delivered, and it is too old to resend safely. Check list_messages; to send anyway, pass a new idempotency_key.`,
          { txn_id: existing.txnId, status: existing.status },
        );
      }
      const txnId = existing?.txnId ?? txnIdFor(keyed.key);
      const record = ledger.begin(
        { key: keyed.key, derived: keyed.derived, roomId, kind, payloadHash: hash, txnId },
        now,
      );
      let guard: SendGuard | null = null;
      try {
        guard = this.#fetch.beginSend({ roomId, txnId, expectEncrypted });
        const sent = await send();
        this.#fetch.endSend();
        return {
          record: ledger.finish(record.key, "sent", sent.eventId, null, this.#now()),
          deduplicated: false,
          resent: Boolean(existing),
        };
      } catch (error) {
        this.#fetch.endSend();
        const message = error instanceof Error ? error.message : String(error);
        const attempts = guard?.attempts ?? [];
        const last = attempts.at(-1);
        const definite =
          attempts.length === 0 ||
          (last?.status !== undefined &&
            last.status >= 400 &&
            last.status < 500 &&
            last.status !== 429);
        const status = definite ? "failed" : "unknown";
        const finished = ledger.finish(
          record.key,
          status,
          null,
          message.slice(0, 500),
          this.#now(),
        );
        this.#log("warn", "send did not complete", {
          roomId,
          kind,
          status,
          attempts: attempts.length,
          lastStatus: last?.status,
          error: message.slice(0, 300),
        });
        throw new InboxError(
          status === "failed" ? "send_failed" : "delivery_unknown",
          status === "failed"
            ? `the homeserver did not accept the ${kind}: ${message}`
            : `the ${kind} may or may not have been delivered (${message}). Calling again with the same arguments (or idempotency_key) within ${SAFE_RESEND_WINDOW_MS / 60_000} minutes is safe: it reuses the same transaction ID, so the homeserver won't post it twice.`,
          {
            txn_id: finished.txnId,
            attempts: attempts.map((attempt) => ({
              type: attempt.eventType,
              status: attempt.status ?? null,
              error: attempt.error ?? null,
              blocked: attempt.blocked ?? false,
            })),
          },
        );
      }
    });
  }

  async #awaitBridgeStatus(eventId: string): Promise<BridgeStatus | null> {
    const deadline = this.#now() + this.#bridgeStatusWaitMs;
    while (this.#now() < deadline) {
      const status = this.#bridgeStatus.get(eventId);
      if (status) return status;
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, this.#bridgeStatusWaitMs)));
    }
    return this.#bridgeStatus.get(eventId) ?? null;
  }

  async #readBack(
    roomId: string,
    eventId: string,
    expectEncrypted: boolean,
  ): Promise<{ message: MatrixMessageEvent | null; readback: Record<string, unknown> }> {
    try {
      const { message, raw } = await this.#getMessage(roomId, eventId);
      return {
        message,
        readback: {
          found: Boolean(raw),
          decrypted: Boolean(message),
          sent_encrypted: raw?.type === "m.room.encrypted",
          encryption_as_expected: expectEncrypted ? raw?.type === "m.room.encrypted" : true,
          sender_is_me: message?.sender.isMe ?? raw?.sender === this.#account?.userId,
        },
      };
    } catch (error) {
      return { message: null, readback: { found: false, error: String(error) } };
    }
  }

  async #sendResult(
    roomId: string,
    result: { record: SendRecord; deduplicated: boolean; resent: boolean },
    expectEncrypted: boolean,
    extra: (
      message: MatrixMessageEvent | null,
    ) => Promise<Record<string, unknown>> = async () => ({}),
  ): Promise<Record<string, unknown>> {
    const eventId = result.record.eventId as string;
    const { message, readback } = await this.#readBack(roomId, eventId, expectEncrypted);
    const bridge = result.deduplicated
      ? (this.#bridgeStatus.get(eventId) ?? null)
      : await this.#awaitBridgeStatus(eventId);
    return {
      status: "sent",
      room_id: roomId,
      event_id: eventId,
      txn_id: result.record.txnId,
      deduplicated: result.deduplicated,
      ...(result.deduplicated
        ? { note: "an identical send with this key already went through; nothing was sent again" }
        : {}),
      ...(result.resent ? { resent_after_unknown: true } : {}),
      encrypted_room: expectEncrypted,
      readback,
      bridge_status: bridge
        ? {
            status: bridge.status,
            ...(bridge.reason ? { reason: bridge.reason } : {}),
            ...(bridge.message ? { message: bridge.message } : {}),
          }
        : {
            status: "not_observed",
            note: `no bridge delivery status within ${this.#bridgeStatusWaitMs / 1000}s; the homeserver accepted the event`,
          },
      ...(await extra(message)),
    };
  }

  async #sendNetwork(roomId: string): Promise<string> {
    const { directory } = this.#ready();
    await this.#requireJoined(roomId);
    if (!directory.get(roomId)) await this.refreshDirectory();
    const room = directory.get(roomId);
    if (!room)
      throw new InboxError(
        "unavailable",
        `Couldn't identify the network for ${roomId}; try again after the conversation appears in list_conversations.`,
      );
    return room.network;
  }

  #requireGrokRelay(network: string, fromGrokRelay = false): void {
    if (network === "grok" && !fromGrokRelay)
      throw new InboxError(
        "refused",
        "Grok Bot requests must use grok_bot_send with slack_channel and slack_thread_ts. Use the task's Slack thread, or the ts of Leon's message when there is no thread. For a task bot already talking to you in Slack, answer it in that thread.",
      );
  }

  async sendMessage(
    args: Record<string, unknown>,
    fromGrokRelay = false,
  ): Promise<Record<string, unknown>> {
    const { client } = this.#ready();
    const roomId = roomIdOf(args.room_id);
    const given = typeof args.text === "string" ? args.text : "";
    if (!given.trim()) throw new InboxError("bad_argument", "text is required");
    // A message to Silicon Dot is a task: it carries the Slack thread Hermes works in, and Dot's
    // Codex session for it talks to Hermes there (slack-handoff.ts).
    const network = await this.#sendNetwork(roomId);
    this.#requireGrokRelay(network, fromGrokRelay);
    const dot = DOT_NETWORKS.has(network);
    const hasThread = args.slack_channel !== undefined || args.slack_thread_ts !== undefined;
    if (!dot && hasThread)
      throw new InboxError(
        "bad_argument",
        "slack_channel and slack_thread_ts are only for Silicon Dot's chats; for a Grok bot use grok_bot_send",
      );
    let text = given;
    let handoff: Record<string, string> | undefined;
    if (dot) {
      let thread;
      try {
        thread = slackThread(args.slack_channel, args.slack_thread_ts);
      } catch (error) {
        throw new InboxError(
          "bad_argument",
          `This is Silicon Dot's chat. ${(error as Error).message}`,
        );
      }
      text = `${given.trim()}\n\n${codexHandoffBlock(thread)}`;
      handoff = {
        slack_identifier: slackIdentifier(thread),
        codex_session_title: taskName(thread),
      };
    }
    if (text.length > LIMITS.maxSendChars)
      throw new InboxError("bad_argument", `text is over ${LIMITS.maxSendChars} characters`);
    const replyTo =
      args.reply_to === undefined || args.reply_to === null || args.reply_to === ""
        ? undefined
        : eventIdOf(args.reply_to, "reply_to");
    if (replyTo) {
      const target = await this.#matrix(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(replyTo)}`,
      );
      if (target.status !== 200)
        throw new InboxError(
          "not_found",
          `reply_to ${replyTo} isn't an event in ${roomId} (HTTP ${target.status})`,
        );
    }
    const encrypted = await this.#roomEncrypted(roomId);
    const explicit = typeof args.idempotency_key === "string" ? args.idempotency_key : undefined;
    const hash = payloadHash(["text", text, replyTo ?? ""]);
    const result = await this.#ledgered(roomId, "text", hash, explicit, encrypted, () =>
      client.messages.send({ roomId, text, ...(replyTo ? { replyTo } : {}) }),
    );
    return this.#sendResult(roomId, result, encrypted, async (message) => ({
      ...(replyTo
        ? { reply_to: replyTo, reply_linked: message ? message.replyTo === replyTo : null }
        : {}),
      text_matches: message ? message.text === text : null,
      ...handoff,
    }));
  }

  async sendFile(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { client } = this.#ready();
    const roomId = roomIdOf(args.room_id);
    const inputPath = typeof args.path === "string" ? args.path.trim() : "";
    if (!inputPath || !isAbsolute(inputPath))
      throw new InboxError(
        "bad_argument",
        "path must be an absolute path to a file on Hermes's machine",
      );
    let realPath: string;
    try {
      realPath = realpathSync(inputPath);
    } catch {
      throw new InboxError("not_found", `${inputPath} doesn't exist`);
    }
    const refused = refusedUploadReason(realPath, realpathSync(this.#paths.state));
    if (refused) throw new InboxError("refused", `won't send ${realPath}: ${refused}`);
    const stats = statSync(realPath);
    if (!stats.isFile()) throw new InboxError("bad_argument", `${realPath} isn't a regular file`);
    if (stats.size === 0) throw new InboxError("bad_argument", `${realPath} is empty`);
    if (stats.size > LIMITS.maxUploadBytes)
      throw new InboxError(
        "too_large",
        `${realPath} is ${stats.size} bytes; the limit is ${LIMITS.maxUploadBytes}`,
      );
    const filename = safeFilename(
      typeof args.filename === "string" && args.filename.trim()
        ? args.filename
        : basename(realPath),
      "file",
    );
    const contentType =
      typeof args.content_type === "string" && args.content_type.includes("/")
        ? args.content_type.trim()
        : contentTypeFor(filename);
    const caption =
      typeof args.caption === "string" && args.caption.trim() ? args.caption : undefined;
    const sendAs = args.send_as === "file" ? "file" : "auto";
    this.#requireGrokRelay(await this.#sendNetwork(roomId));
    const encrypted = await this.#roomEncrypted(roomId);
    const bytes = new Uint8Array(readFileSync(realPath));
    const digest = sha256(bytes);
    const explicit = typeof args.idempotency_key === "string" ? args.idempotency_key : undefined;
    const hash = payloadHash(["file", digest, filename, contentType, caption ?? "", sendAs]);
    const result = await this.#ledgered(roomId, "file", hash, explicit, encrypted, () =>
      client.messages.sendMedia({
        roomId,
        bytes,
        filename,
        contentType,
        kind: mediaKind(contentType, sendAs),
        size: bytes.byteLength,
        ...(caption ? { caption } : {}),
      }),
    );
    return this.#sendResult(roomId, result, encrypted, async (message) => {
      const attachment = message?.attachments[0];
      const out: Record<string, unknown> = {
        file: {
          path: realPath,
          filename,
          content_type: contentType,
          bytes: bytes.byteLength,
          sha256: digest,
        },
        sent_attachment: attachment ? attachmentRefs([attachment])[0] : null,
      };
      if (attachment && bytes.byteLength <= LIMITS.roundTripVerifyBytes) {
        try {
          const back = attachment.encryptedFile
            ? await client.media.downloadEncrypted({ file: attachment.encryptedFile })
            : await client.media.download({ contentUri: attachment.contentUri as string });
          out.round_trip = {
            bytes: back.bytes.byteLength,
            sha256_matches: sha256(back.bytes) === digest,
          };
        } catch (error) {
          out.round_trip = { error: String(error) };
        }
      }
      return out;
    });
  }

  async sendReaction(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { client } = this.#ready();
    const roomId = roomIdOf(args.room_id);
    const eventId = eventIdOf(args.event_id);
    const key = typeof args.key === "string" ? args.key.trim() : "";
    if (!key || key.length > 64)
      throw new InboxError(
        "bad_argument",
        "key must be an emoji or short text (up to 64 characters)",
      );
    await this.#requireJoined(roomId);
    const target = await this.#matrix(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`,
    );
    if (target.status !== 200)
      throw new InboxError(
        "not_found",
        `event ${eventId} isn't in ${roomId} (HTTP ${target.status})`,
      );
    const hash = payloadHash(["reaction", eventId, key]);
    const explicit = typeof args.idempotency_key === "string" ? args.idempotency_key : undefined;
    // Reactions go out unencrypted by design (mautrix and most clients), so no plaintext guard.
    const result = await this.#ledgered(roomId, "reaction", hash, explicit, false, () =>
      client.reactions.send({ roomId, eventId, key }),
    );
    const bridge = result.deduplicated
      ? null
      : await this.#awaitBridgeStatus(result.record.eventId as string);
    return {
      status: "sent",
      room_id: roomId,
      reacted_to: eventId,
      key,
      event_id: result.record.eventId,
      txn_id: result.record.txnId,
      deduplicated: result.deduplicated,
      bridge_status: bridge
        ? { status: bridge.status, ...(bridge.reason ? { reason: bridge.reason } : {}) }
        : { status: "not_observed" },
    };
  }

  // ── Health ───────────────────────────────────────────────────────────────────────────────────────

  async status(): Promise<Record<string, unknown>> {
    let crypto: MatrixCryptoStatus | { error: string } | null = null;
    if (this.#client && this.#state === "ready") {
      try {
        crypto = await withTimeout(this.#client.crypto.status(), 15_000, "crypto status timed out");
      } catch (error) {
        crypto = { error: String(error) };
      }
    }
    const stats = this.#fetch.stats;
    const lastSync = stats.lastSyncOkAt;
    const syncHealthy = lastSync !== null && this.#now() - lastSync < LIMITS.syncStaleMs;
    const refreshedAt = this.#directory?.refreshedAt() ?? null;
    return {
      service: "beeper-inbox",
      version: VERSION,
      state: this.#state,
      ...(this.#stateError ? { state_error: this.#stateError } : {}),
      healthy: this.#state === "ready" && syncHealthy,
      pid: process.pid,
      started_at: new Date(this.#startedAt).toISOString(),
      booted_at: this.#bootedAt ? new Date(this.#bootedAt).toISOString() : null,
      account: this.#account
        ? {
            user_id: this.#account.userId,
            device_id: this.#account.deviceId,
            homeserver: this.#account.homeserver,
            display_name: this.#account.displayName ?? null,
          }
        : null,
      crypto:
        crypto && "state" in crypto
          ? {
              state: crypto.state,
              key_backup_version: crypto.keyBackupVersion ?? null,
              pending_decryption_count: crypto.pendingDecryptionCount,
              has_recovery_key: crypto.hasRecoveryKey,
              store_backed: crypto.storeBacked,
              cross_signed_at: this.#verifiedAt,
              recent_events: this.#cryptoEvents.slice(-5),
            }
          : crypto,
      sync: {
        subscribed: Boolean(this.#subscription),
        last_state: this.#syncState.state,
        last_ok_at: lastSync ? new Date(lastSync).toISOString() : null,
        consecutive_failures: stats.consecutiveSyncFailures,
        last_error: stats.lastSyncError,
        syncs: stats.syncs,
      },
      journal: this.#journal
        ? (() => {
            const journal = this.#journal.stats();
            return {
              head: journal.head,
              covered_since: new Date(journal.coveredSince).toISOString(),
              entries: journal.entries,
              waiting_for_keys: journal.pending,
            };
          })()
        : null,
      directory: this.#directory
        ? {
            rooms: this.#directory.count(),
            refreshed_at: refreshedAt ? new Date(refreshedAt).toISOString() : null,
            networks: this.#directory.networks(),
          }
        : null,
      recent_sends: (this.#ledger?.recent(10) ?? []).map((record) => ({
        room_id: record.roomId,
        kind: record.kind,
        status: record.status,
        event_id: record.eventId,
        txn_id: record.txnId,
        attempts: record.attempts,
        updated_at: new Date(record.updatedAt).toISOString(),
      })),
      secrets: {
        recovery_key: readEnvSecrets(this.#paths.hermesEnv).recoveryKey ? "set" : "missing",
        problems: this.#secretProblems,
      },
      decryption_errors_seen: this.#decryptErrors.size,
      limits: {
        max_download_bytes: LIMITS.maxDownloadBytes,
        max_upload_bytes: LIMITS.maxUploadBytes,
        max_page: LIMITS.maxPage,
      },
      paths: {
        downloads: this.#paths.downloads,
        state: this.#paths.state,
        log: this.#paths.logFile,
      },
      not_supported: [
        "starting new conversations",
        "edits and deletions",
        "Beeper merged chats (each bridged room is listed on its own)",
        "network-specific actions",
        "thread replies in bridged rooms (Beeper refuses /relations there)",
      ],
    };
  }

  /** For the daemon's watchdog: true when the Matrix core still answers. */
  async alive(timeoutMs = 20_000): Promise<boolean> {
    if (!this.#client || this.#state !== "ready") return true;
    try {
      await withTimeout(this.#client.crypto.status(), timeoutMs, "timeout");
      return true;
    } catch {
      return false;
    }
  }

  #fingerprint(): string {
    let account: InboxAccount | null = null;
    try {
      account = readAccount(this.#paths.account);
    } catch {
      account = null;
    }
    const env = readEnvSecrets(this.#paths.hermesEnv);
    let pickleKey = "";
    if (account) {
      const file = pickleKeyFile(this.#paths.state, account.deviceId);
      pickleKey = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
    }
    return sha256(
      JSON.stringify([
        account?.deviceId ?? "",
        env.accessToken ?? "",
        env.recoveryKey ?? "",
        pickleKey,
      ]),
    );
  }

  /**
   * Checked once a minute: did account.json or the BEEPER_INBOX_* values change, say after Leon added the
   * recovery key on the Keys page? A change is checked before anything is torn down: values that can't
   * work (a malformed recovery key, a token for another device) are reported and the running session is
   * kept. Returns "reload" only for a change worth restarting the client for.
   */
  async secretsChange(): Promise<"none" | "reload" | "rejected"> {
    if (
      this.#state === "starting" ||
      this.#state === "stopped" ||
      this.#secretsFingerprint === null
    )
      return "none";
    let fingerprint: string;
    try {
      fingerprint = this.#fingerprint();
    } catch {
      return "none";
    }
    if (fingerprint === this.#secretsFingerprint || fingerprint === this.#rejectedFingerprint)
      return "none";
    const env = readEnvSecrets(this.#paths.hermesEnv);
    const reject = (reason: string): "rejected" => {
      this.#rejectedFingerprint = fingerprint;
      this.#secretProblems = [...env.problems.filter((problem) => problem !== reason), reason];
      this.#log("error", "ignored a change to the device's secrets", { reason });
      return "rejected";
    };
    if (env.fatal.length) return reject(env.fatal.join("; "));
    let account: InboxAccount | null = null;
    try {
      account = readAccount(this.#paths.account);
    } catch (error) {
      return reject(`account.json can't be read: ${String(error)}`);
    }
    if (
      this.#state === "ready" &&
      account &&
      env.accessToken &&
      env.accessToken !== this.#accessToken
    ) {
      const response = await this.#baseFetch(
        new URL("/_matrix/client/v3/account/whoami", account.homeserver),
        {
          headers: { authorization: `Bearer ${env.accessToken}` },
          signal: AbortSignal.timeout(20_000),
        },
      ).catch(() => null);
      const who = response?.ok ? ((await response.json()) as { device_id?: string }) : null;
      if (who?.device_id !== account.deviceId) {
        return reject(
          `the new BEEPER_INBOX_ACCESS_TOKEN isn't a valid token for device ${account.deviceId}`,
        );
      }
    }
    this.#secretProblems = env.problems;
    return "reload";
  }

  syncStale(): boolean {
    if (this.#state !== "ready") return false;
    const last = this.#fetch.stats.lastSyncOkAt ?? this.#bootedAt ?? this.#now();
    return this.#now() - last > LIMITS.syncStaleMs;
  }

  async restartSync(): Promise<void> {
    if (!this.#client) return;
    const subscription = this.#subscription;
    this.#subscription = null;
    try {
      await subscription?.stop();
    } catch {
      // restarting anyway
    }
    await this.#subscribe();
  }
}
