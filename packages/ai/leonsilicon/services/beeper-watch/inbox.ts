import type { Logger } from "#types";

/**
 * The parts of Hermes's Beeper inbox this package uses, declared here so that it doesn't depend on
 * the inbox package: the Gmail feed Worker shares this package's screener and has nothing to do with
 * the inbox, and a dependency would have every inbox change redeploy it.
 *
 * They mirror `ExtensionContext`, `JournalEntry`, `RoomInfo` and `DaemonExtension` of
 * `@-/ai.leonsilicon.services.beeper-inbox`. The inbox app passes the real ones, and TypeScript
 * checks the fit there (`apps/beeper-inbox/_beeper-inbox.ts`).
 */

/** One message as the inbox's journal recorded it when sync delivered it. */
export interface JournalEntry {
  seq: number;
  rev: number;
  roomId: string;
  eventId: string;
  sender: string;
  isMe: boolean;
  /** The Matrix message type: `m.text`, `m.notice`, `m.image`… */
  type: string;
  text: string;
  html: string | null;
  ts: number;
  receivedAt: number;
  edited: boolean;
  redacted: boolean;
  replyTo: string | null;
  attachments: number;
}

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

/** What the journal source asks of the inbox. */
export interface InboxAccess {
  tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  journal: {
    coveredSince(): Promise<number>;
    since(roomId: string, sinceTs: number): Promise<JournalEntry[]>;
    recent(sinceTs: number, limit?: number): Promise<JournalEntry[]>;
  };
  rooms(roomIds: readonly string[]): Promise<RoomInfo[]>;
  connections(): Promise<
    Array<{
      protocolId: string | null;
      networkId: string | null;
      name: string | null;
      rooms: number;
    }>
  >;
  senderNames(userIds: readonly string[]): Promise<Record<string, string>>;
}

/** What the inbox daemon hands an extension when it starts it. */
export interface InboxContext extends InboxAccess {
  /** The extension's own directory under the inbox home. */
  home: string;
  log: Logger;
}

export interface RunningInboxExtension {
  callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  status?(): Record<string, unknown>;
  stop?(): void | Promise<void>;
}

export interface InboxExtension {
  name: string;
  server: {
    name: string;
    version: string;
    instructions: string;
    tools: ReadonlyArray<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      annotations?: Record<string, unknown>;
    }>;
  };
  start(context: InboxContext): RunningInboxExtension;
}
