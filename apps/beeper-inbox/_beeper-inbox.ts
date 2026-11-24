#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { linearIssueMetadataExtension, runCli } from "@-/ai.leonsilicon.services.beeper-inbox";
import { discord2slackExtension } from "@-/ai.leonsilicon.services.discord2slack";
import { instagram2slackExtension } from "@-/ai.leonsilicon.services.instagram2slack";
import { linkedin2slackExtension } from "@-/ai.leonsilicon.services.linkedin2slack";
import { reddit2slackExtension } from "@-/ai.leonsilicon.services.reddit2slack";
import { slack22GrokBotExtension } from "@-/ai.leonsilicon.services.slack22grokbot";
import { wechat2slackExtension } from "@-/ai.leonsilicon.services.wechat2slack";
import { whatsapp2slackExtension } from "@-/ai.leonsilicon.services.whatsapp2slack";
import { x2slackExtension } from "@-/ai.leonsilicon.services.x2slack";

// One entrypoint for everything: Hermes runs `beeper-inbox.mjs mcp`, which starts `… daemon` itself,
// and `beeper-inbox.mjs mcp slack22grokbot` for the relay served by the same daemon.
const code = await runCli(process.argv.slice(2), fileURLToPath(import.meta.url), process.env, {
  extensions: [
    slack22GrokBotExtension(),
    discord2slackExtension(),
    instagram2slackExtension(),
    linkedin2slackExtension(),
    reddit2slackExtension(),
    wechat2slackExtension(),
    whatsapp2slackExtension(),
    x2slackExtension(),
    linearIssueMetadataExtension(),
  ],
});
if (code >= 0) process.exit(code);
