/** One message in a Grok bot's chat, as the relay needs it. */
export interface GrokMessage {
  id: string;
  chatID: string;
  /** Orders the messages of a chat. It is also the cursor `grok_bot_read` takes. */
  sortKey: string;
  /** From Leon's account: Leon himself, or Hermes writing as him. */
  isSender: boolean;
  /** Plain text. */
  text: string;
  timestamp: string;
  /** Set for anything but an ordinary text message, e.g. "m.notice". */
  type?: string;
  isDeleted?: boolean;
}

export interface GrokBot {
  name: string;
  chatID: string;
  lastActivity: string | null;
}

/** Where the relay reads and sends. On Hermes Cloud it is the Beeper inbox (`inbox-backend.ts`). */
export interface GrokBackend {
  /** Leon's Grok bots. `refresh` asks for a fresh list, for a bot created or renamed since the last one. */
  bots(options?: { refresh?: boolean }): Promise<GrokBot[]>;
  /**
   * One page of a chat's history, newest messages, in any order: `wanted` of them at most. This is the
   * slow way to read (about half a second per message through the inbox); `live` is the fast one.
   */
  messages(chatID: string, wanted?: number): Promise<GrokMessage[]>;
  /** Sends as Leon. `key` names this one send, so retrying it can never post twice. */
  send(chatID: string, text: string, key: string): Promise<{ id: string }>;
  live?: GrokLive;
}

/**
 * New messages as they arrive, from the inbox's journal. With it the relay waits for a reply, judges
 * whether a bot is busy and answers follow-up reads without reading history.
 */
export interface GrokLive {
  /** The time from which `latest` and `since` are known to hold every message. */
  coveredSince(): Promise<number>;
  /** The newest `count` messages of a chat that the journal holds. */
  latest(chatID: string, count: number): Promise<GrokMessage[]>;
  /** A chat's messages sent at or after a time. */
  since(chatID: string, sinceMs: number): Promise<GrokMessage[]>;
  /** The position for "from now on". */
  cursor(): Promise<number>;
  /** Messages of a chat that arrived or changed after a position; waits up to `waitMs` for the first. */
  changes(
    chatID: string,
    cursor: number,
    waitMs: number,
  ): Promise<{ messages: GrokMessage[]; cursor: number }>;
}

export type RelayLog = (entry: Record<string, unknown>) => void;

export interface QueuedItem {
  /** Hermes's own text, without the handoff block. */
  text: string;
  at: string;
  /** The task's Slack thread; the block for it is added when the queue goes out. */
  thread: { channel: string; threadTs: string };
  /** For the thread's task bot itself: a follow-up note instead of the "make a task bot" block. */
  followUp?: boolean;
}

export interface BudgetState {
  sends: string[];
  urgent: string[];
  extensions: Array<{ at: string; quote: string }>;
}
