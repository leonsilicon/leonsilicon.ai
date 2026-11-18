export type LogLevel = "info" | "warn" | "error";
export type Logger = (level: LogLevel, message: string, fields?: Record<string, unknown>) => void;

export interface ChatInfo {
  id: string;
  title: string;
  network: string;
  type: string;
}

export interface ChatMessage {
  id: string;
  senderName: string;
  isSender: boolean;
  text: string;
  type: string;
  timestamp: string;
}

/** The slice of Beeper Desktop the watcher reads. */
export interface BeeperSource {
  chat(chatID: string): Promise<ChatInfo>;
  /** Messages newer than `sinceIso`, oldest first, without deleted or hidden ones. */
  messagesSince(chatID: string, sinceIso: string): Promise<ChatMessage[]>;
}

/** A chat as the feed needs it: who it's with, and whether Leon muted it. */
export interface FeedChat {
  id: string;
  accountID: string;
  title: string;
  network: string;
  /** "single" for a 1:1 chat, "group" otherwise. */
  type: string;
  isMuted: boolean;
}

export interface FeedMessage extends ChatMessage {
  chatID: string;
  accountID: string;
}

/** Every recent message across Beeper, for the feed channels. */
export interface BeeperFeedSource {
  /** Account IDs with their network, so the feed can leave some accounts out of the search. */
  accounts(): Promise<Array<{ accountID: string; network: string }>>;
  /**
   * Messages newer than `sinceIso` in the given accounts, oldest first, plus the chats they're in.
   * `truncated` is true when more arrived than `maxPages` pages hold (the newest are kept).
   */
  recentMessages(
    sinceIso: string,
    accountIDs: string[],
    maxPages?: number,
  ): Promise<{ messages: FeedMessage[]; chats: Record<string, FeedChat>; truncated: boolean }>;
}

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
}

/** The slice of Slack the watcher writes to, as the Beeper Watch bot. */
export interface SlackPoster {
  channel(nameOrId: string): Promise<SlackChannel>;
  /**
   * A public channel by name, created (or unarchived) when missing. `invite` and `purpose` are
   * applied only to a channel this call created or unarchived; `problems` lists what of that failed.
   * An ID is looked up like `channel`.
   */
  ensureChannel?(
    nameOrId: string,
    options: { invite: string[]; purpose?: string },
  ): Promise<SlackChannel & { created?: boolean; problems?: string[] }>;
  post(channel: string, text: string, threadTs?: string): Promise<{ ts: string }>;
}

export interface PendingMessage {
  id: string;
  from: string;
  /**
   * True when this message should wake Hermes: written by the other side, not a reaction or notice,
   * and matching the watch's `from` filter. Leon's own messages, including anything an agent sent
   * through his Beeper, are kept only as context.
   */
  wakes: boolean;
  /**
   * True when someone other than Leon wrote it, outside his agent chats: the feed sends it through
   * the screener before Hermes can see it. Missing on messages saved before screening existed.
   */
  untrusted?: boolean;
  text: string;
  type: string;
  timestamp: string;
}

export interface Watch {
  id: string;
  chatID: string;
  chatTitle: string;
  network: string;
  waitingFor: string;
  /** Only messages whose sender name contains this (case-insensitive) wake Hermes. */
  from?: string;
  slackChannel: string;
  slackChannelName: string;
  slackThreadTs?: string;
  createdAt: string;
  /** Messages at or before this time are ignored. */
  since: string;
  expiresAt: string;
  /** Message IDs already handled, so edits and re-reads never ping twice. */
  seen: string[];
  /** Messages collected since the last ping. */
  pending: PendingMessage[];
  /** Times of recent pings, for the hourly limit. */
  pings: string[];
  /** Contact messages delivered so far. */
  delivered: number;
  failures: number;
  retryAt?: string;
}

export interface AddWatchInput {
  chat_id?: unknown;
  waiting_for?: unknown;
  slack_channel?: unknown;
  slack_thread_ts?: unknown;
  since?: unknown;
  expires_in_hours?: unknown;
  from?: unknown;
}
