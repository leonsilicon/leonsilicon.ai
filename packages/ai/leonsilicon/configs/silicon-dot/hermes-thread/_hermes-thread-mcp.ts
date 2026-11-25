#!/usr/bin/env node
// The stdio MCP server Codex launches as `slack-puppet`: forwards each message to slack-puppet with
// the Codex token from the login Keychain. `--check` connects once and lists the tools.
import { createInterface } from "node:readline";
import { forward, keychainToken, KEYCHAIN_SERVICE } from "#hermes-thread";

const token = keychainToken();
if (!token) {
  process.stderr.write(
    `hermes-thread: no slack-puppet token in the login Keychain (${KEYCHAIN_SERVICE}); run the installer (configs/silicon-dot/hermes-thread)\n`,
  );
  process.exit(1);
}

if (process.argv.includes("--check")) {
  const init = await forward(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    token,
  );
  const list = await forward(
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    token,
  );
  const server = (JSON.parse(init[0] ?? "{}") as { result?: { serverInfo?: unknown } }).result
    ?.serverInfo;
  const tools = (
    JSON.parse(list[0] ?? "{}") as { result?: { tools?: { name: string }[] } }
  ).result?.tools?.map((t) => t.name);
  console.log(JSON.stringify({ server, tools }));
  process.exit(server && tools?.length ? 0 : 1);
}

// Each message is forwarded on its own, so a call waiting for Hermes doesn't hold up the others.
const pending = new Set<Promise<void>>();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  const work = forward(line, token)
    .then((out) => {
      for (const reply of out) process.stdout.write(`${reply}\n`);
    })
    .finally(() => pending.delete(work));
  pending.add(work);
});
lines.on("close", () => {
  void Promise.allSettled(pending).then(() => process.exit(0));
});
