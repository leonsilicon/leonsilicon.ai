/**
 * The slice of Pickle (`@beeper/pickle`, pinned in apps/beeper-inbox/@assets/pickle.json) this service
 * uses. Pickle isn't published to npm, so it isn't a workspace dependency: the daemon loads the vendored
 * build at run time (#pickle) and these types describe what it gets back. They follow Pickle's
 * `client-types.ts` and `types.ts` at the pinned revision.
 */

export interface MatrixStore {
  delete(key: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  list(prefix: string): Promise<string[]>;
  set(key: string, value: Uint8Array): Promise<void>;
}

export interface MatrixEncryptedFile {
  hashes: { sha256: string };
  iv: string;
  key: Record<string, unknown>;
  url: string;
  v: string;
}

export interface MatrixAttachment {
  contentType?: string;
  contentUri?: string;
  duration?: number;
  encryptedFile?: MatrixEncryptedFile;
  filename?: string;
  height?: number;
  kind: "image" | "video" | "audio" | "file";
  size?: number;
  width?: number;
}

export interface MatrixMessageEvent {
  attachments: MatrixAttachment[];
  content: Record<string, unknown>;
  edited: boolean;
  encrypted: boolean;
  eventId: string;
  html?: string;
  kind: "message";
  messageType: string;
  relation?: { eventId: string; type: string; key?: string };
  replaces?: string;
  replyTo?: string;
  roomId: string;
  sender: { isMe: boolean; userId: string };
  text: string;
  threadRoot?: string;
  timestamp?: number;
  type: string;
}

export interface MatrixCryptoStatus {
  deviceId?: string;
  hasRecoveryKey: boolean;
  keyBackupVersion?: string;
  pendingDecryptionCount: number;
  state: string;
  storeBacked: boolean;
  userId?: string;
}

export interface MatrixClientEvent {
  kind: string;
  [key: string]: unknown;
}

export interface MatrixSubscription {
  catchUp(): Promise<void>;
  done: Promise<void>;
  stop(): Promise<void>;
}

export interface SentEvent {
  eventId: string;
  roomId: string;
}

export interface RawRequestResult {
  body?: unknown;
  status: number;
}

export interface PickleClient {
  boot(): Promise<{ deviceId: string; userId: string }>;
  close(): Promise<void>;
  whoami(): Promise<{ deviceId: string; userId: string }>;
  crypto: { status(): Promise<MatrixCryptoStatus> };
  media: {
    download(options: { contentUri: string }): Promise<{ bytes: Uint8Array }>;
    downloadEncrypted(options: { file: MatrixEncryptedFile }): Promise<{ bytes: Uint8Array }>;
  };
  messages: {
    get(options: {
      eventId: string;
      roomId: string;
    }): Promise<{ message: MatrixMessageEvent | null }>;
    list(options: {
      cursor?: string;
      direction?: "backward" | "forward";
      limit?: number;
      roomId: string;
    }): Promise<{ messages: MatrixMessageEvent[]; nextCursor?: string }>;
    send(options: {
      content?: Record<string, unknown>;
      replyTo?: string;
      roomId: string;
      text: string;
    }): Promise<SentEvent>;
    sendMedia(options: {
      bytes: Uint8Array;
      caption?: string;
      contentType?: string;
      filename?: string;
      kind?: "image" | "video" | "audio" | "file";
      roomId: string;
      size?: number;
    }): Promise<SentEvent>;
  };
  reactions: {
    send(options: { eventId: string; key: string; roomId: string }): Promise<SentEvent>;
  };
  raw: {
    request(options: {
      body?: unknown;
      method?: string;
      path: string;
      query?: Record<string, string>;
    }): Promise<RawRequestResult>;
  };
  rooms: {
    get(options: { roomId: string }): Promise<{
      encrypted: boolean;
      id: string;
      memberCount?: number;
      name?: string;
      directUserId?: string;
    }>;
    listJoined(): Promise<{ roomIds: string[] }>;
  };
  subscribe(
    filter: { kind?: string | string[] } | undefined,
    handler: (event: MatrixClientEvent) => void | Promise<void>,
    options?: { retryDelayMs?: number; timeoutMs?: number },
  ): Promise<MatrixSubscription>;
}

export interface PickleClientOptions {
  account: { accessToken: string; deviceId: string; homeserver: string; userId: string };
  beeper?: boolean;
  fetch?: typeof fetch;
  logger?: (level: "debug" | "info" | "warn" | "error", message: string, data?: unknown) => void;
  pickleKey: string;
  recoveryKey?: string;
  store: MatrixStore;
  verifyRecoveryOnStart?: boolean;
}

export type LogLevel = "debug" | "info" | "warn" | "error";
export type Logger = (level: LogLevel, message: string, fields?: Record<string, unknown>) => void;

/** The device this service signs in as. Not secret: the secrets are in Hermes's `.env`. */
export interface InboxAccount {
  homeserver: string;
  userId: string;
  deviceId: string;
  createdAt: string;
  displayName?: string;
}

/** An error the tools report to Hermes as-is: a bad argument or a state it can act on. */
export class InboxError extends Error {
  readonly code: string;
  readonly data: Record<string, unknown> | undefined;

  constructor(code: string, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = "InboxError";
    this.code = code;
    this.data = data;
  }
}
