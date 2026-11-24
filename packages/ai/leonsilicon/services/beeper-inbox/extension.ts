import type { RoomInfo } from "#inbox";
import type { JournalEntry } from "#journal";
import type { Logger } from "#types";

/** A tool as MCP lists it. */
export interface ExtensionTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/** What an extension gets from the daemon it runs in. */
export interface ExtensionContext {
  /** Runs one of the inbox's own tools (`list_conversations`, `list_messages`, `send_message`…). */
  tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  /**
   * New messages as sync delivers them (see journal.ts): the way to follow a chat. Reading history
   * with `list_messages` costs about half a second per message, so nothing should do that in a loop.
   */
  journal: ExtensionJournal;
  /** What the inbox knows about rooms: name, network, connection, whether Leon muted them. */
  rooms(roomIds: readonly string[]): Promise<RoomInfo[]>;
  /** Each connection Leon's rooms belong to: a bridge and, where it has one, the network's ID. */
  connections(): Promise<
    Array<{
      protocolId: string | null;
      networkId: string | null;
      name: string | null;
      rooms: number;
    }>
  >;
  /** Write and verify a Linear issue snapshot in this account's room data. */
  publishLinearIssue(roomId: string, record: Record<string, unknown>): Promise<void>;
  /** Write and verify closed Slack project channels in this account's global data. */
  publishProjectVisibility(record: Record<string, unknown>): Promise<void>;
  /** Display names for Matrix user IDs, where the homeserver has one. */
  senderNames(userIds: readonly string[]): Promise<Record<string, string>>;
  /** The extension's own directory under the inbox home (0700), for its state. */
  home: string;
  /** The daemon's log, tagged with the extension's name. IDs and counts only, never message text. */
  log: Logger;
}

export interface ExtensionJournal {
  /** The latest position: "after this" means from now on. */
  head(): Promise<number>;
  /** The time from which the journal has every message sync delivered. */
  coveredSince(): Promise<number>;
  /** The newest `count` messages of a room that the journal holds, oldest first. */
  latest(roomId: string, count: number): Promise<JournalEntry[]>;
  /** A room's messages sent at or after a time, oldest first. */
  since(roomId: string, sinceTs: number): Promise<JournalEntry[]>;
  /** Every room's messages sent at or after a time, oldest first. */
  recent(sinceTs: number, limit?: number): Promise<JournalEntry[]>;
  /**
   * Messages that arrived or changed after a position, in one room or in all. With `waitMs`, it waits
   * that long for the first one when there is nothing yet.
   */
  changes(options: {
    after: number;
    roomId?: string;
    limit?: number;
    waitMs?: number;
  }): Promise<{ entries: JournalEntry[]; cursor: number }>;
}

export interface RunningExtension {
  callTool?(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** A few facts about its health, shown under its name in the daemon's status. */
  status?(): Record<string, unknown>;
  stop?(): void | Promise<void>;
}

/**
 * A service inside the inbox's single-writer daemon. An extension with an MCP server can also
 * expose tools through a separate stateless MCP adapter.
 */
export interface DaemonExtension {
  /** The extension's directory and status name. */
  name: string;
  server?: ExtensionServer;
  start(context: ExtensionContext): RunningExtension | Promise<RunningExtension>;
}

interface ExtensionServer {
  name: string;
  version: string;
  instructions: string;
  tools: readonly ExtensionTool[];
}

export type McpExtension = DaemonExtension & { server: ExtensionServer };
