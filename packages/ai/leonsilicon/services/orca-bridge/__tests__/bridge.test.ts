import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { OrcaRunner } from "@-/com.npmjs.krzysztofkobra__orca-mcp";
import { checkArgs, CliRefused, timeoutFor } from "#cli";
import type { OrcaBridgeConfig } from "#config";
import { createListener, workerTools } from "#mcp";

const TOKEN = "t".repeat(64);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orca-bridge-test-"));
const fakeOrca = path.join(dir, "orca");
// Echoes its argv in Orca's JSON envelope.
fs.writeFileSync(
  fakeOrca,
  `#!/usr/bin/env node\nconsole.log(JSON.stringify({ ok: true, result: { argv: process.argv.slice(2) } }));\n`,
  { mode: 0o755 },
);

const config: OrcaBridgeConfig = {
  token: TOKEN,
  port: 0,
  publicOrigin: "https://ai.example.com",
  orcaBin: fakeOrca,
  workingDirectory: dir,
  environments: ["MacBook"],
  maxCallMs: 170_000,
  env: { HOME: dir, PATH: process.env.PATH, ORCA_MCP_ROOTS: dir, ORCA_MCP_CLIENT: "test" },
};

test("checkArgs refuses servers, pairing and unknown environments", () => {
  const refuse = (args: unknown) =>
    assert.throws(() => checkArgs(args, undefined, ["MacBook"]), CliRefused, JSON.stringify(args));
  refuse(["serve"]);
  refuse(["plugin", "dev", "watch", "./p"]);
  refuse(["environment", "add", "--name", "x"]);
  refuse(["pair", "--grant-desktop-control"]);
  refuse(["repo", "list", "--pairing-code", "orca://pair?code=x"]);
  refuse(["repo", "list", "--environment", "Elsewhere"]);
  refuse(["repo", "list", "--environment=Elsewhere"]);
  refuse(["repo", "list", "--environment"]);
  refuse([]);
  refuse("repo list");
  assert.deepEqual(
    checkArgs(["repo", "list", "--environment", "MacBook"], undefined, ["MacBook"]),
    ["repo", "list", "--environment", "MacBook"],
  );
  assert.deepEqual(checkArgs(["computer", "list-apps"], undefined, ["MacBook"]), [
    "computer",
    "list-apps",
  ]);
});

test("timeoutFor gives launches and explicit waits longer, never past maxCallMs", () => {
  assert.equal(timeoutFor(["repo", "list"], 170_000), 60_000);
  assert.equal(timeoutFor(["worktree", "create", "--name", "x"], 170_000), 170_000);
  assert.equal(timeoutFor(["terminal", "wait", "--timeout-ms", "90000"], 170_000), 110_000);
  assert.equal(timeoutFor(["terminal", "wait", "--timeout-ms", "600000"], 170_000), 170_000);
});

test("orca-mcp's waits are capped to fit one call", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const calls: string[][] = [];
  const run: OrcaRunner = async (args) => {
    calls.push([...args]);
    if (args[0] === "terminal" && args[1] === "show") now += 1;
    return { ok: true, result: { terminal: { handle: "t1" }, done: true } };
  };
  const tools = workerTools(config, { run });
  assert.equal(tools.length, 19);
  const wait = tools.find((t) => t.name === "orca_terminal_wait")!;
  assert.match(wait.description, /at most 165 s/);
  await wait.handler({ terminal: "t1", for: "done", timeoutMs: 600_000 } as never);
  const waitCall = calls.find((c) => c[0] === "terminal" && c[1] === "wait");
  assert.ok(waitCall?.includes("--timeout-ms=164999"), JSON.stringify(calls));
});

let base = "";
let close: () => Promise<void>;

before(async () => {
  const listener = createListener(config);
  await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  close = () => new Promise((r) => listener.close(() => r()));
});

after(async () => {
  await close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const rpc = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });

test("health is open, everything else needs the token and an allowed Origin", async () => {
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/other`)).status, 404);
  assert.equal((await rpc({}, { Authorization: "Bearer nope" })).status, 401);
  assert.equal((await rpc({}, { Origin: "https://evil.example" })).status, 403);
});

test("lists the bridge's tools and orca-mcp's together", async () => {
  const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map(
    (t) => t.name,
  );
  assert.equal(names.length, 22);
  for (const n of [
    "orca_projects",
    "orca_guide",
    "orca_cli",
    "orca_status",
    "orca_wait",
    "orca_worker_start",
  ])
    assert.ok(names.includes(n), n);
});

test("orca_cli runs the CLI with --json and refuses denied commands", async () => {
  const call = async (args: string[]) => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "orca_cli", arguments: { args } },
    });
    const { result } = (await res.json()) as {
      result: { isError?: boolean; content: { text: string }[] };
    };
    return {
      isError: result.isError,
      value: JSON.parse(result.content[0]!.text) as Record<string, unknown>,
    };
  };
  const ok = await call(["repo", "list", "--environment", "MacBook"]);
  assert.equal(ok.isError, false);
  assert.deepEqual((ok.value.result as { argv: string[] }).argv, [
    "repo",
    "list",
    "--environment",
    "MacBook",
    "--json",
  ]);
  const denied = await call(["serve"]);
  assert.equal(denied.isError, true);
  assert.equal((denied.value.error as { code: string }).code, "refused");
});
