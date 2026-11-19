#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { runCli } from "@-/com.leonsilicon.ai.services.orca-device";

// Hermes runs `orca-device.mjs mcp`, which starts `… link` itself.
const code = await runCli(process.argv.slice(2), fileURLToPath(import.meta.url));
if (code >= 0) process.exit(code);
