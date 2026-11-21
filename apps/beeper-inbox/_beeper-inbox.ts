#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { runCli } from "@-/com.leonsilicon.ai.services.beeper-inbox";
import { beeperWatchExtension } from "@-/com.leonsilicon.ai.services.beeper-watch";
import { grokRelayExtension } from "@-/com.leonsilicon.ai.services.grok-relay";

// One entrypoint for everything: Hermes runs `beeper-inbox.mjs mcp`, which starts `… daemon` itself,
// and `beeper-inbox.mjs mcp grok-relay` or `mcp beeper-watch` for the Grok relay and Beeper Watch,
// which the same daemon serves.
const code = await runCli(process.argv.slice(2), fileURLToPath(import.meta.url), process.env, {
  extensions: [grokRelayExtension(), beeperWatchExtension()],
});
if (code >= 0) process.exit(code);
