#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { runCli } from "@-/com.leonsilicon.ai.services.beeper-inbox";

// One entrypoint for everything: Hermes runs `beeper-inbox.mjs mcp`, which starts `… daemon` itself.
const code = await runCli(process.argv.slice(2), fileURLToPath(import.meta.url));
if (code >= 0) process.exit(code);
