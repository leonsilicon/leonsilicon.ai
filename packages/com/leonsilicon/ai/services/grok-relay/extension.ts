import { join } from "node:path";
import type { DaemonExtension } from "@-/com.leonsilicon.ai.services.beeper-inbox";
import { inboxBackend } from "#backend";
import { createGrokRelay } from "#relay";
import { callTool, INSTRUCTIONS, TOOLS } from "#tools";

export const VERSION = "1.3.0";

/**
 * The relay as an extension of Hermes's Beeper inbox daemon: `beeper-inbox.mjs mcp grok-relay` is its
 * MCP server. It runs inside the daemon because the queue, the budget and the flusher need exactly
 * one owner, and Hermes starts an MCP server in several processes at once.
 */
export function grokRelayExtension(): DaemonExtension {
  return {
    name: "grok-relay",
    server: { name: "leon-grok", version: VERSION, instructions: INSTRUCTIONS, tools: TOOLS },
    start(context) {
      const relay = createGrokRelay({
        stateDir: join(context.home, "state"),
        backend: inboxBackend((name, args) => context.tool(name, args), context.journal),
        log: ({ event, ...fields }) =>
          context.log(
            typeof event === "string" && event.endsWith("_error") ? "warn" : "info",
            typeof event === "string" ? event : "event",
            fields,
          ),
      });
      return {
        callTool: (name, args) => callTool(relay, name, args),
        stop: () => relay.stop(),
      };
    },
  };
}
