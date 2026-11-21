import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createListener, TOOLS } from "#mcp";
import { loadConfig } from "#service";
import { WatchStore } from "#store";
import type { Logger } from "#types";
import { Watcher } from "#watcher";

const TOKEN = "t".repeat(64);
const ORIGIN = "https://mini.example.ts.net";
const quiet: Logger = () => {};
let base = "";
let close: () => Promise<void>;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "beeper-watch-mcp-"));
  const watcher = new Watcher({
    store: new WatchStore(path.join(dir, "watches.json"), quiet),
    beeper: {
      chat: async (id) => ({ id, title: "Sam", network: "Instagram", type: "single" }),
      messagesSince: async () => [],
    },
    slack: {
      channel: async () => ({
        id: "C0TASKS0001",
        name: "uoft-creators",
        isPrivate: false,
        isMember: true,
      }),
      post: async () => ({ ts: "1.000000" }),
    },
    hermesUserId: "U0HERMES001",
    defaultChannel: "home",
    log: quiet,
  });
  await watcher.tick();
  const listener = createListener({ watcher, token: TOKEN, publicOrigin: ORIGIN, log: quiet });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  close = () => new Promise((resolve) => listener.close(() => resolve()));
});

after(() => close());

const rpc = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${TOKEN}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });

test("the MCP endpoint needs the bearer token and a matching origin", async () => {
  assert.equal((await rpc({}, { Authorization: "" })).status, 401);
  assert.equal((await rpc({}, { Authorization: `Bearer ${"x".repeat(64)}` })).status, 401);
  assert.equal((await rpc({}, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await fetch(`${base}/elsewhere`)).status, 404);
});

test("healthz reports counts only, without a token", async () => {
  const response = await fetch(`${base}/mcp/healthz`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), [
    "beeper",
    "lastTickAt",
    "service",
    "version",
    "watches",
  ]);
});

test("tools can be listed and called over MCP", async () => {
  const list = (await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as {
    result: { tools: Array<{ name: string }> };
  };
  assert.deepEqual(
    list.result.tools.map((tool) => tool.name),
    TOOLS.map((tool) => tool.name),
  );

  const call = async (name: string, args: Record<string, unknown>) => {
    const response = (await (
      await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } })
    ).json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    return {
      ...response.result,
      value: JSON.parse(response.result.content[0].text) as Record<string, any>,
    };
  };

  const added = await call("beeper_watch_add", {
    chat_id: "!sam:beeper.local",
    waiting_for: "utorid",
    slack_channel: "uoft-creators",
    slack_thread_ts: "1793918187.574419",
  });
  assert.equal(added.isError, undefined);
  assert.equal(added.value.ok, true);
  const id = added.value.watch.id as string;

  assert.equal((await call("beeper_watch_list", {})).value.watches[0].id, id);
  const bad = await call("beeper_watch_add", {
    chat_id: "!sam:beeper.local",
    waiting_for: "x",
    slack_channel: "D123",
  });
  assert.equal(bad.isError, true);
  assert.match(bad.value.error, /can't post in DMs/);
  assert.equal((await call("beeper_watch_remove", { id })).value.removed.id, id);
  assert.equal((await call("beeper_watch_list", {})).value.watches.length, 0);
});

test("loadConfig needs Hermes's Slack user ID, which has no built-in default", () => {
  const env = {
    BEEPER_TOKEN_FILE: "/tmp/beeper.json",
    SLACK_BOT_TOKEN: "xoxb-test",
    MCP_TOKEN: "m".repeat(40),
    PUBLIC_ORIGIN: "https://watch.example.com",
  };
  assert.throws(() => loadConfig(env), /HERMES_SLACK_USER_ID/);
  assert.equal(
    loadConfig({ ...env, HERMES_SLACK_USER_ID: "U0HERMES001" }).hermesUserId,
    "U0HERMES001",
  );
});
