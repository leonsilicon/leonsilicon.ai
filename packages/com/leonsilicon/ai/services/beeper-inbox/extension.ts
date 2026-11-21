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
  /** The extension's own directory under the inbox home (0700), for its state. */
  home: string;
  /** The daemon's log, tagged with the extension's name. IDs and counts only, never message text. */
  log: Logger;
}

export interface RunningExtension {
  callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  stop?(): void | Promise<void>;
}

/**
 * A second set of tools served by the same daemon, such as the Grok relay. It runs inside the store's
 * one owner, so its own state has a single writer too, however many MCP server processes Hermes
 * starts. It reaches Beeper only through the inbox's tools.
 */
export interface DaemonExtension {
  /** The argument of `beeper-inbox mcp <name>`, and the name its calls carry over the socket. */
  name: string;
  /** How its MCP server introduces itself to Hermes. */
  server: {
    name: string;
    version: string;
    instructions: string;
    tools: readonly ExtensionTool[];
  };
  start(context: ExtensionContext): RunningExtension | Promise<RunningExtension>;
}
