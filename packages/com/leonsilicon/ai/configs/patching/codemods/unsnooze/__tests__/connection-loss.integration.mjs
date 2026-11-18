import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Exercise the installed monitor against a fake pane, with isolated state and
// zero-length backoff. No keys, hooks, notifications, or agents run for real.
const root = resolve(
  process.env.UNSNOOZE_TEST_ROOT || join(homedir(), ".bun/install/global/node_modules/unsnooze"),
);
const stateDir = mkdtempSync(join(tmpdir(), "unsnooze-connection-loss-"));
process.env.UNSNOOZE_STATE_DIR = stateDir;
process.env.UNSNOOZE_OVERLOAD_BACKOFF_S = "0";
const source = (name) => import(pathToFileURL(join(root, "src", name)).href);
const { createMonitor } = await source("monitor.js");
const { default: claude, patterns } = await source("agents/claude.js");
const { overloadMatch, isBusy } = await source("patterns.js");
const { addressHash } = await source("lease.js");
const { EVENTS_DIR } = await source("config.js");
after(() => rmSync(stateDir, { recursive: true, force: true }));

const error = "API Error: Connection lost mid-response. The response above may be incomplete.";
const waiting = "✻ Waiting for API response · will retry in 1m 40s · check your network";
function screen(banner = error) {
  return [
    "⏺ Updating the two READMEs to match.",
    "",
    `⏺ ${banner}`,
    "",
    "✻ Worked for 4m 51s · done 2:24 PM",
    "",
    "────────────────────────",
    "❯",
    "────────────────────────",
    "",
    " ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents",
  ].join("\n");
}

let sequence = 0;
function fakeMonitor(frames, { marker = false } = {}) {
  const pane = `connection-loss-test-${++sequence}`;
  let captures = 0;
  const messages = [];
  const monitor = createMonitor({
    pane,
    cwd: stateDir,
    agent: { ...claude, latestSessionId: () => null },
    versionSkewed: () => false,
    notifier: () => assert.fail("unexpected notification"),
    spawner: () => assert.fail("unexpected child process"),
    mux: {
      paneAlive: async () => true,
      capturePane: async () => frames[Math.min(captures++, frames.length - 1)],
      capturePaneVisible: async () => frames[0],
      sendText: async (target, text) => {
        assert.equal(target, pane);
        messages.push(text);
      },
    },
  });
  const markerFile = join(
    EVENTS_DIR,
    `${addressHash({ mux: "tmux", paneOwner: null, pane })}.json`,
  );
  if (marker) {
    mkdirSync(EVENTS_DIR, { recursive: true });
    writeFileSync(markerFile, JSON.stringify({ kind: "overload", at: Date.now() }));
  }
  return {
    monitor,
    messages,
    markerFile,
    get captures() {
      return captures;
    },
  };
}

test("the screenshot error triggers a continuation after the backoff recheck", async () => {
  const fake = fakeMonitor([screen()]);
  await fake.monitor._tick();
  assert.equal(fake.captures, 2, "the monitor must recheck after waiting");
  assert.deepEqual(fake.messages, [
    "Continue where you left off. The previous attempt failed with a transient API error.",
  ]);
});

test("a StopFailure overload marker survives the banner recheck", async () => {
  const fake = fakeMonitor([screen()], { marker: true });
  await fake.monitor._tick();
  assert.equal(fake.captures, 2);
  assert.equal(fake.messages.length, 1);
  assert.equal(existsSync(fake.markerFile), false);
});

test("bare, bullet-prefixed, ANSI-coloured, and wrapped error banners match", () => {
  for (const text of [
    error,
    `● ${error}`,
    `  ⏺ ${error}`,
    `• ${error}`,
    `\x1b[31m⏺ ${error}\x1b[0m`,
    "⏺ API Error: Connection lost\n  mid-response. The response above may be incomplete.",
  ]) {
    assert.ok(overloadMatch(text, patterns.overloadPatterns), text);
  }
});

test("quoted error text, ordinary prose, unrelated errors, and stale scrollback do not match", async () => {
  for (const text of [
    `> ${error}`,
    `\`${error}\``,
    `"${error}"`,
    `The terminal said ${error}`,
    "API Error: Authentication failed",
    "API Error: Invalid request",
    `${error}\n${Array.from({ length: 13 }, (_, i) => `Completed step ${i}`).join("\n")}`,
  ]) {
    assert.equal(overloadMatch(text, patterns.overloadPatterns), null, text);
    const fake = fakeMonitor([text]);
    await fake.monitor._tick();
    assert.equal(fake.messages.length, 0);
  }
});

test("Claude automatic retries are busy and receive no continuation", async () => {
  for (const status of [waiting, "Retrying in 5s · attempt 3/10", "esc to interrupt"]) {
    const text = `${screen()}\n${status}`;
    assert.equal(isBusy(text, patterns.busyPatterns), true, status);
    const fake = fakeMonitor([text]);
    await fake.monitor._tick();
    assert.equal(fake.messages.length, 0);
    assert.equal(fake.captures, 1, "busy pane should not start a retry");
  }
});

test("Claude starting its own retry during backoff cancels the continuation", async () => {
  const fake = fakeMonitor([screen(), `${screen()}\n${waiting}`]);
  await fake.monitor._tick();
  assert.equal(fake.captures, 2);
  assert.equal(fake.messages.length, 0);
});

test("a hook marker does not override Claude automatic retries", async () => {
  const fake = fakeMonitor([`${screen()}\n${waiting}`], { marker: true });
  await fake.monitor._tick();
  assert.equal(fake.messages.length, 0);
});

test("a pane that recovers during backoff receives no continuation", async () => {
  const fake = fakeMonitor([screen(), "⏺ Finished the task.\n❯"]);
  await fake.monitor._tick();
  assert.equal(fake.captures, 2);
  assert.equal(fake.messages.length, 0);
});

test("existing HTTP overload and throttle errors still retry", async () => {
  for (const banner of [
    "API Error: 529 overloaded",
    "API Error: 503 unavailable",
    "API Error: 429 too many requests",
    "API Error: Server is temporarily limiting requests (not your usage limit)",
  ]) {
    const fake = fakeMonitor([screen(banner)]);
    await fake.monitor._tick();
    assert.equal(fake.messages.length, 1, banner);
  }
});
