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
  /** The latest messages of one chat, in any order: at least `wanted` of them when the chat has that many. */
  messages(chatID: string, wanted?: number): Promise<GrokMessage[]>;
  /** Sends as Leon. `key` names this one send, so retrying it can never post twice. */
  send(chatID: string, text: string, key: string): Promise<{ id: string }>;
}

export type RelayLog = (entry: Record<string, unknown>) => void;

export interface QueuedItem {
  text: string;
  at: string;
}

export interface BudgetState {
  sends: string[];
  urgent: string[];
  extensions: Array<{ at: string; quote: string }>;
}
