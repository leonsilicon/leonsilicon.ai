import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  boxSettings,
  createBoxKeeper,
  REPAIR_BOT,
  setupCommand,
  type BoxDeps,
  type BoxSettings,
} from "#grok-box";

const COMMIT = "7508f60af76104d31450f3b599138d0581ea8179";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function world() {
  const home = mkdtempSync(join(tmpdir(), "grok-box-"));
  const settings: BoxSettings = {
    token: "tok",
    host: "grok-box",
    port: 9400,
    tailscale: "/ts",
    socket: "/ts.sock",
    oauthId: "cid",
    oauthSecret: "csecret",
    pluginDir: "/opt/data/plugins/grok-box-browser",
    shared: join(home, "shared"),
  };
  const files: Record<string, string> = {
    "/opt/data/plugins/grok-box-browser/box/up.sh": "up",
    "/opt/data/plugins/grok-box-browser/box/broker.mjs": "broker",
  };
  const box = { healthy: false, online: true, keys: 0, now: 1_800_000_000_000 };
  const deps: BoxDeps = {
    exec: async (file, args) => {
      if (file === "git") return `${COMMIT}\n`;
      assert.deepEqual(args, ["--socket=/ts.sock", "status", "--json"]);
      return JSON.stringify({
        Peer: box.online ? { k: { HostName: "grok-box", Online: true } } : {},
      });
    },
    nc: async () => (box.healthy ? 'HTTP/1.1 200 OK\r\n\r\n{"ok":true}' : ""),
    fetch: (async (input: string) => {
      if (input.endsWith("/oauth/token")) return Response.json({ access_token: "at" });
      box.keys++;
      return Response.json({ key: `tskey-auth-${box.keys}` });
    }) as typeof fetch,
    readFile: (path) => {
      if (path in files) return files[path]!;
      return readFileSync(path, "utf8");
    },
    now: () => box.now,
  };
  const logs: Array<Record<string, unknown>> = [];
  const keeper = createBoxKeeper({
    stateFile: join(home, "state", "grok-box.json"),
    log: (entry) => logs.push(entry),
    settings: () => settings,
    deps,
  });
  return { home, settings, box, keeper, logs };
}

test("the setup pins the mirror commit and checksums, with a join key only when needed", () => {
  const release = { commit: COMMIT, up: sha("up"), broker: sha("broker") };
  const plain = setupCommand(release, "tok");
  assert.match(plain, /^bash -euo pipefail <<'SETUP'\n/);
  assert.ok(plain.includes(`/leonsiliconAI/hermes-plugin-grok-box-browser/${COMMIT}/box`));
  assert.ok(plain.includes(`${sha("up")} ${sha("broker")} | sha256sum -c -`));
  assert.ok(plain.includes("printf %s 'tok' > ../token\n"));
  assert.ok(!plain.includes("tailscale-authkey"));
  assert.ok(
    setupCommand(release, "tok", "tskey-1").includes("printf %s 'tskey-1' > ../tailscale-authkey"),
  );
});

test("settings come from Hermes's .env, and nothing happens without the token", () => {
  const home = mkdtempSync(join(tmpdir(), "grok-box-env-"));
  writeFileSync(join(home, ".env"), "GROK_BOX_BROWSER_HOST=grok-box-2\n");
  assert.equal(boxSettings({ HERMES_HOME: home }), null);
  writeFileSync(
    join(home, ".env"),
    "GROK_BOX_BROWSER_TOKEN=tok\nGROK_BOX_TS_OAUTH_CLIENT_ID=cid\n",
  );
  const settings = boxSettings({ HERMES_HOME: home });
  assert.equal(settings?.host, "grok-box");
  assert.equal(settings?.oauthId, "cid");
  assert.equal(settings?.tailscale, join(home, "orca-device/tailscale/bin/tailscale"));
  assert.equal(boxSettings({ HERMES_HOME: join(home, "missing") }), null);
});

test("while the box is down, one message every 30 minutes carries the setup", async () => {
  const { box, keeper } = world();
  box.healthy = true;
  assert.equal(await keeper.upkeep(), "");
  box.healthy = false;
  box.now += 2 * 60_000; // past the health cache
  const block = await keeper.upkeep();
  assert.match(block, /^\[Before anything else, yourself\]/);
  assert.ok(block.includes(COMMIT));
  assert.ok(!block.includes("tailscale-authkey"), "the box is still on the tailnet");
  assert.equal(await keeper.upkeep(), "");
  // Off the tailnet: the setup carries a fresh one-time key.
  box.now += 31 * 60_000;
  box.online = false;
  assert.ok((await keeper.upkeep()).includes("printf %s 'tskey-auth-1' > ../tailscale-authkey"));
});

test("a repair request from the plugin sends the setup to the parent bot, once an hour, and is verified", async () => {
  const { box, keeper, settings } = world();
  const sent: Array<[string, string]> = [];
  const send = async (bot: string, text: string) => {
    sent.push([bot, text]);
  };
  await keeper.tick(send);
  assert.equal(sent.length, 0, "no request, no repair");

  const request = join(settings.shared, "repair-request.json");
  const status = () =>
    JSON.parse(readFileSync(join(settings.shared, "repair-status.json"), "utf8")) as Record<
      string,
      unknown
    >;
  mkdirSync(settings.shared, { recursive: true }); // the plugin makes it with its first request
  writeFileSync(request, JSON.stringify({ at: box.now }));
  box.now += 1000;
  await keeper.tick(send);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.[0], REPAIR_BOT);
  assert.match(String(sent[0]?.[1]), /^Run this in your own cloud computer's terminal/);
  assert.equal(status().result, "sent");

  // Still down five minutes later: a failure. Another request within the hour waits.
  box.now += 5 * 60_000;
  writeFileSync(request, JSON.stringify({ at: box.now }));
  await keeper.tick(send);
  assert.equal(status().failures, 1);
  assert.equal(sent.length, 1);

  // An hour on, the next request repairs again, and this time it works.
  box.now += 60 * 60_000;
  writeFileSync(request, JSON.stringify({ at: box.now }));
  await keeper.tick(send);
  assert.equal(sent.length, 2);
  box.healthy = true;
  box.now += 5 * 60_000;
  await keeper.tick(send);
  assert.equal(status().failures, 0);
  assert.equal(status().result, "ok");
});

test("a repair the bot can't take now is retried in a few minutes, and a healthy box needs none", async () => {
  const { box, keeper, settings } = world();
  const request = join(settings.shared, "repair-request.json");
  await keeper.upkeep(); // creates the shared folder
  writeFileSync(request, JSON.stringify({ at: box.now }));
  let busy = true;
  const sent: string[] = [];
  const send = async (_bot: string, text: string) => {
    if (busy) throw new Error("Grok Bot is busy: waiting for a reply");
    sent.push(text);
  };
  box.now += 1000;
  await keeper.tick(send);
  assert.equal(keeper.status().result, "skipped");
  busy = false;
  box.now += 60_000;
  await keeper.tick(send);
  assert.equal(sent.length, 0, "waits out the retry delay");
  box.now += 5 * 60_000;
  await keeper.tick(send);
  assert.equal(sent.length, 1);

  // The box came back by itself: the request is dropped.
  box.now += 2 * 60 * 60_000;
  writeFileSync(request, JSON.stringify({ at: box.now }));
  box.healthy = true;
  box.now += 1000;
  await keeper.tick(send);
  assert.equal(sent.length, 1);
  assert.throws(() => readFileSync(request));
});
