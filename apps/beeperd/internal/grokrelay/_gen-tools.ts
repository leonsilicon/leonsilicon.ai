#!/usr/bin/env node
/**
 * Writes tools.json, which the Go relay embeds as its MCP server: the name, version, instructions
 * and tools of the slack22grokbot extension, exactly as the TypeScript daemon serves them. The
 * instructions and descriptions carry Leon's rules for Hermes, so the Go code never retypes them.
 * Run from the repository root after changing tools.ts or the extension's version:
 *
 *   node apps/beeperd/internal/grokrelay/_gen-tools.ts
 *
 * With --check it writes nothing and fails when tools.json is out of date.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// The Go module is not a workspace package, so the extension's package can't be named from here.
// oxlint-disable-next-line flatcap/no-workspace-import-bypass
import { slack22GrokBotExtension } from "../../../../packages/ai/leonsilicon/services/slack22grokbot/+server.ts";

const { server } = slack22GrokBotExtension();
if (!server) throw new Error("slack22grokbot has no MCP server");
const file = join(import.meta.dirname, "tools.json");
const json = `${JSON.stringify(server, null, 2)}\n`;

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(file, "utf8");
  } catch {}
  if (current !== json) {
    console.error(`${file} is out of date: run this script without --check`);
    process.exit(1);
  }
} else {
  writeFileSync(file, json);
}
