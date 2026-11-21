import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HOURLY_BUDGET } from "#policy";
import { createGrokRelay } from "#relay";
import { callTool } from "#tools";
import type { GrokBackend, GrokMessage } from "#types";

/** The relay against a fake Beeper: offline, sends nothing real. */
function setup() {
  const stateDir = join(mkdtempSync(join(tmpdir(), "grok-relay-test-")), "state");
  let key = 1000;
  let id = 1;
  const chats: Record<string, { title: string; messages: GrokMessage[] }> = {
    "c-task": { title: "Task Bot", messages: [] },
    "c-linear": { title: "Linear Bot", messages: [] },
  };
  const messagesOf = (chatID: string): GrokMessage[] => {
    const chat = chats[chatID];
    if (!chat) throw new Error(`no chat ${chatID}`);
    return chat.messages;
  };
  const posted: Array<{ chatID: string; text: string; key: string }> = [];
  const calls = { bots: 0, refreshes: 0, failNextSend: false };
  const add = (chatID: string, isSender: boolean, text: string, ago = 0): GrokMessage => {
    const message: GrokMessage = {
      id: `$e${id++}`,
      chatID,
      sortKey: `${1795000000000 + key++}:$e`,
      timestamp: new Date(Date.now() - ago).toISOString(),
      isSender,
      text,
    };
    messagesOf(chatID).push(message);
    return message;
  };
  const backend: GrokBackend = {
    bots: async (options) => {
      calls.bots++;
      if (options?.refresh) calls.refreshes++;
      return Object.entries(chats).map(([chatID, chat]) => ({
        name: chat.title,
        chatID,
        lastActivity: null,
      }));
    },
    messages: async (chatID) => [...messagesOf(chatID)].reverse(),
    send: async (chatID, text, sendKey) => {
      posted.push({ chatID, text, key: sendKey });
      if (calls.failNextSend) {
        calls.failNextSend = false;
        throw new Error("timed out after the request went out");
      }
      return { id: add(chatID, true, text).id };
    },
  };
  const logs: Array<Record<string, unknown>> = [];
  const open = () =>
    createGrokRelay({
      stateDir,
      backend,
      log: (entry) => logs.push(entry),
      flush: false,
      pollMs: 5,
    });
  return { stateDir, relay: open(), open, chats, add, posted, logs, calls };
}

test("idle bot: sends directly and counts against the budget", async () => {
  const { relay, posted, add } = setup();
  add("c-task", true, "earlier", 3600_000);
  add("c-task", false, "Earlier full answer, done and verified.", 3500_000);
  const result = await relay.send({ bot: "Task Bot", text: "please do X", wait_seconds: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.queued, undefined);
  assert.equal(posted.length, 1);
  assert.deepEqual(result.budget, { used: 1, limit: HOURLY_BUDGET });
  assert.match(String(posted[0]?.key), /^send-[0-9a-f-]{36}$/);
});

test("busy bot: queued, merged into one message on flush once idle", async () => {
  const { relay, posted, add, stateDir } = setup();
  add("c-task", true, "first ask", 30_000); // no reply yet: busy
  const first = await relay.send({ bot: "Task", text: "also do Y", wait_seconds: 0 });
  const second = await relay.send({ bot: "Task", text: "and Z", wait_seconds: 0 });
  assert.equal(first.queued, true);
  assert.equal(second.position, 2);
  assert.equal(posted.length, 0);
  const outbox = JSON.parse(readFileSync(join(stateDir, "outbox.json"), "utf8")) as Record<
    string,
    { items: unknown[] }
  >;
  assert.equal(outbox["c-task"]?.items.length, 2);
  const read = await relay.read({ bot: "Task Bot" });
  assert.equal((read.queued as unknown[]).length, 2);
  assert.equal((await relay.bots()).find((bot) => bot.chatID === "c-task")?.queued, 2);
  await relay.flushOnce(); // still busy: nothing goes out
  assert.equal(posted.length, 0);
  // the bot answers and goes quiet for over a minute
  add(
    "c-task",
    false,
    "Done with the first ask, here are the full results and the readback.",
    90_000,
  );
  await relay.flushOnce();
  assert.equal(posted.length, 1);
  assert.equal(posted[0]?.text, "a few more things, in order:\n\n1. also do Y\n\n2. and Z");
  assert.equal((await relay.read({ bot: "Task Bot" })).queued, undefined);
  assert.equal(relay.budget().used, 1);
});

test("a flush retried after a lost answer reuses its key, so it can't post twice", async () => {
  const { relay, posted, add, calls, logs } = setup();
  add("c-task", true, "first ask", 30_000);
  await relay.send({ bot: "Task Bot", text: "also do Y", wait_seconds: 0 });
  add(
    "c-task",
    false,
    "Done with the first ask, here are the full results and the readback.",
    90_000,
  );
  calls.failNextSend = true;
  await relay.flushOnce();
  assert.ok(logs.some((entry) => entry.event === "grok_flush_error"));
  assert.equal((await relay.read({ bot: "Task Bot" })).queued !== undefined, true, "still queued");
  await relay.flushOnce();
  assert.equal(posted.length, 2);
  assert.match(String(posted[0]?.key), /^flush-[0-9a-f]{40}$/);
  assert.equal(posted[0]?.key, posted[1]?.key);
  assert.equal(relay.budget().used, 1, "only the send that went through counts");
});

test("urgent goes straight out even when busy", async () => {
  const { relay, posted, add } = setup();
  add("c-task", true, "first ask", 10_000);
  const result = await relay.send({
    bot: "Task Bot",
    text: "stop, wrong account",
    urgent: true,
    wait_seconds: 0,
  });
  assert.equal(result.queued, undefined);
  assert.equal(posted.length, 1);
});

test("Linear Bot needs a reason; with one it is allowed and logged", async () => {
  const { relay, posted, logs } = setup();
  await assert.rejects(
    relay.send({ bot: "Linear Bot", text: "read back LEON-6", wait_seconds: 0 }),
    /linear\/todoist MCP tools/,
  );
  assert.equal(posted.length, 0);
  const result = await relay.send({
    bot: "Linear Bot",
    text: "create the workflow status",
    needs_bot_because: "the linear MCP cannot create workflow states",
    wait_seconds: 0,
  });
  assert.equal(result.ok, true);
  assert.ok(logs.some((entry) => entry.event === "grok_bot_justified"));
});

test("budget: refused at the limit with ask-Leon text; Leon's quote extends it", async () => {
  const { open, stateDir } = setup();
  const sends = Array.from({ length: HOURLY_BUDGET }, (_, i) =>
    new Date(Date.now() - 60_000 + i).toISOString(),
  );
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "budget.json"), JSON.stringify({ sends }));
  // a new relay picks the saved budget up, as after a restart
  const relay = open();
  await assert.rejects(
    relay.send({ bot: "Task Bot", text: "one more", wait_seconds: 0 }),
    /Ask Leon in Slack/,
  );
  const refused = await callTool(relay, "grok_bot_send", { bot: "Task Bot", text: "one more" });
  assert.equal(refused.ok, false);
  assert.equal((refused.error as { code: string }).code, "grok_relay_error");
  const result = await relay.send({
    bot: "Task Bot",
    text: "one more",
    wait_seconds: 0,
    leon_approved_more: "yes keep going, send it",
  });
  assert.equal(result.ok, true);
  assert.equal(relay.budget().limit, HOURLY_BUDGET * 2);
});

test("waits for the reply and returns it as it finally reads", async () => {
  const { relay, add } = setup();
  setTimeout(() => {
    const reply = add("c-task", false, "Working");
    setTimeout(() => {
      reply.text = "Working… done: the form is submitted.";
    }, 30);
  }, 20);
  const result = await relay.send({ bot: "Task Bot", text: "submit the form", wait_seconds: 0.2 });
  const replies = result.replies as Array<{ from: string; text: string; sortKey: string }>;
  assert.deepEqual(
    replies.map((reply) => [reply.from, reply.text]),
    [["Task Bot", "Working… done: the form is submitted."]],
  );
  assert.equal(result.cursor, replies[0]?.sortKey);
  assert.equal((result.sent as { sentAs: string }).sentAs, "Leon");
});

test("read: tells Hermes's messages from Leon's, pages by cursor, drops a pre-move cursor", async () => {
  const { relay, add } = setup();
  add("c-task", true, "typed by Leon himself", 400_000);
  add("c-task", false, "An answer to Leon.", 390_000);
  await relay.send({ bot: "Task Bot", text: "from Hermes", wait_seconds: 0 });
  add("c-task", false, "An answer to Hermes.");
  const all = await relay.read({ bot: "task" });
  const lines = all.messages as Array<{ from: string; text: string; sortKey: string }>;
  assert.deepEqual(
    lines.map((line) => line.from),
    ["Leon", "Task Bot", "Hermes (as Leon)", "Task Bot"],
  );
  const later = await relay.read({ bot: "Task Bot", after: lines[2]?.sortKey });
  assert.deepEqual(
    (later.messages as Array<{ text: string }>).map((line) => line.text),
    ["An answer to Hermes."],
  );
  // Beeper Desktop's cursors were plain numbers.
  const stale = await relay.read({ bot: "Task Bot", after: "26965" });
  assert.equal((stale.messages as unknown[]).length, 4);
  assert.match(String(stale.cursorNote), /can't be used any more/);
});

test("an unknown bot refreshes the list once, then names the ones there are", async () => {
  const { relay, calls, chats } = setup();
  await assert.rejects(
    relay.read({ bot: "Nope" }),
    /No Grok bot called "Nope"\. Available: Task Bot, Linear Bot/,
  );
  assert.equal(calls.refreshes, 1);
  chats["c-new"] = { title: "Brand New Bot", messages: [] };
  assert.equal((await relay.read({ bot: "brand new" })).bot, "Brand New Bot");
});
