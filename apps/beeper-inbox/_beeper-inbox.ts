#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { linearIssueMetadataExtension, runCli } from "@-/ai.leonsilicon.services.beeper-inbox";
import { grokRelayExtension } from "@-/ai.leonsilicon.services.grok-relay";
import { instagram2slackExtension } from "@-/ai.leonsilicon.services.instagram2slack";
import { whatsapp2slackExtension } from "@-/ai.leonsilicon.services.whatsapp2slack";

// One entrypoint for everything: Hermes runs `beeper-inbox.mjs mcp`, which starts `… daemon` itself,
// and `beeper-inbox.mjs mcp slack22grokbot` for the relay served by the same daemon.
const code = await runCli(process.argv.slice(2), fileURLToPath(import.meta.url), process.env, {
  extensions: [
    grokRelayExtension(),
    instagram2slackExtension(),
    whatsapp2slackExtension(),
    linearIssueMetadataExtension(),
  ],
});
if (code >= 0) process.exit(code);
