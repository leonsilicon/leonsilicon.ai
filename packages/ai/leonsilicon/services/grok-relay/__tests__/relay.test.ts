import assert from "node:assert/strict";
import { followUpBlock, handoffBlock } from "#handoff";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HOURLY_BUDGET } from "#policy";
import { createGrokRelay } from "#relay";
import { callTool } from "#tools";
import type { GrokBackend, GrokLive, GrokMessage } from "#types";

/** The Slack thread every delegated task now carries. */
const THREAD = { slack_channel: "C0TASKS001", slack_thread_ts: "1795280000.123456" };
const BLOCK = handoffBlock({ channel: "C0TASKS001", threadTs: "1795280000.123456" });

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
  const result = await relay.send({
    ...THREAD,
    bot: "Task Bot",
    text: "please do X",
    wait_seconds: 0,
  });
  assert.equal(result.ok, true);
  assert.equal(result.queued, undefined);
  assert.equal(posted.length, 1);
  assert.deepEqual(result.budget, { used: 1, limit: HOURLY_BUDGET });
  assert.match(String(posted[0]?.key), /^send-[0-9a-f-]{36}$/);
});

test("queued requests without a thread stay available for readback and never go out", async () => {
  const { stateDir, open, posted } = setup();
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const legacy = { text: "old request", at };
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "outbox.json"),
    JSON.stringify({
      "c-task": {
        bot: "Task Bot",
        items: [
          legacy,
          {
            text: "threaded request",
            at,
            thread: { channel: THREAD.slack_channel, threadTs: THREAD.slack_thread_ts },
          },
        ],
      },
    }),
  );
  const relay = open();
  await relay.flushOnce();
  assert.equal(posted.length, 1);
  assert.match(posted[0]!.text, /threaded request[\s\S]*Slack thread for this task/);
  assert.doesNotMatch(posted[0]!.text, /old request/);
  const queued = (await relay.read({ bot: "Task Bot" })).queued as {
    preview: string;
    needsSlackThread?: boolean;
  }[];
  assert.deepEqual(
    queued.map(({ preview, needsSlackThread }) => ({ preview, needsSlackThread })),
    [{ preview: legacy.text, needsSlackThread: true }],
  );
  await relay.flushOnce();
  assert.equal(posted.length, 1);
});

test("busy bot: queued, merged into one message on flush once idle", async () => {
  const { relay, posted, add, stateDir } = setup();
  add("c-task", true, "first ask", 30_000); // no reply yet: busy
  const first = await relay.send({ ...THREAD, bot: "Task", text: "also do Y", wait_seconds: 0 });
  const second = await relay.send({ ...THREAD, bot: "Task", text: "and Z", wait_seconds: 0 });
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
  // Both carry the same thread, so its handoff block follows once.
  assert.equal(
    posted[0]?.text,
    `a few more things, in order:\n\n1. also do Y\n\n2. and Z\n\n${BLOCK}`,
  );
  assert.equal((await relay.read({ bot: "Task Bot" })).queued, undefined);
  assert.equal(relay.budget().used, 1);
});

test("a flush retried after a lost answer reuses its key, so it can't post twice", async () => {
  const { relay, posted, add, calls, logs } = setup();
  add("c-task", true, "first ask", 30_000);
  await relay.send({ ...THREAD, bot: "Task Bot", text: "also do Y", wait_seconds: 0 });
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
    ...THREAD,
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
    relay.send({ ...THREAD, bot: "Linear Bot", text: "read back LEON-6", wait_seconds: 0 }),
    /linear\/todoist MCP tools/,
  );
  assert.equal(posted.length, 0);
  const result = await relay.send({
    ...THREAD,
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
    relay.send({ ...THREAD, bot: "Task Bot", text: "one more", wait_seconds: 0 }),
    /Ask Leon in Slack/,
  );
  const refused = await callTool(relay, "grok_bot_send", { bot: "Task Bot", text: "one more" });
  assert.equal(refused.ok, false);
  assert.equal((refused.error as { code: string }).code, "grok_relay_error");
  const result = await relay.send({
    ...THREAD,
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
  const result = await relay.send({
    ...THREAD,
    bot: "Task Bot",
    text: "submit the form",
    wait_seconds: 0.2,
  });
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
  await relay.send({ ...THREAD, bot: "Task Bot", text: "from Hermes", wait_seconds: 0 });
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

/** The relay with a journal: a fake one that hands out positions and wakes waiters like the real one. */
function setupLive({ coveredMinutes = 60 }: { coveredMinutes?: number } = {}) {
  const stateDir = join(mkdtempSync(join(tmpdir(), "grok-relay-live-")), "state");
  const chatID = "!task:beeper.local";
  const rows: Array<{ rev: number; message: GrokMessage }> = [];
  let head = 0;
  let id = 1;
  const calls = { history: 0, waits: [] as number[] };
  const posted: string[] = [];
  /** A message arrives, or an earlier one changes (same id). */
  const arrive = (isSender: boolean, text: string, ago = 0, existing?: string): GrokMessage => {
    const ts = Date.now() - ago;
    const known = existing ? rows.find((row) => row.message.id === existing) : undefined;
    const eventId = existing ?? `$j${id++}`;
    const message: GrokMessage = known
      ? { ...known.message, text }
      : {
          id: eventId,
          chatID,
          sortKey: `${ts}:${eventId}`,
          isSender,
          text,
          timestamp: new Date(ts).toISOString(),
        };
    if (known) rows.splice(rows.indexOf(known), 1);
    rows.push({ rev: ++head, message });
    return message;
  };
  const live: GrokLive = {
    coveredSince: async () => Date.now() - coveredMinutes * 60_000,
    latest: async (_chat, count) => rows.map((row) => row.message).slice(-count),
    since: async (_chat, sinceMs) =>
      rows.map((row) => row.message).filter((message) => Date.parse(message.timestamp) >= sinceMs),
    cursor: async () => head,
    changes: async (_chat, cursor, waitMs) => {
      calls.waits.push(waitMs);
      const deadline = Date.now() + waitMs;
      for (;;) {
        const found = rows.filter((row) => row.rev > cursor);
        if (found.length || Date.now() >= deadline)
          return { messages: found.map((row) => row.message), cursor: found.at(-1)?.rev ?? cursor };
        await new Promise((resolve) => setTimeout(resolve, 3));
      }
    },
  };
  const backend: GrokBackend = {
    live,
    bots: async () => [{ name: "Task Bot", chatID, lastActivity: null }],
    messages: async () => {
      calls.history++;
      return [];
    },
    send: async (_chat, text) => {
      posted.push(text);
      return { id: arrive(true, text).id };
    },
  };
  const relay = createGrokRelay({
    stateDir,
    backend,
    log: () => undefined,
    flush: false,
    quietMs: 60,
  });
  return { relay, arrive, calls, posted };
}

test("with the journal: a send reads no history, and returns the reply as it finally reads", async () => {
  const { relay, arrive, calls, posted } = setupLive();
  arrive(true, "earlier ask", 50 * 60_000); // older than the busy window: not even looked at
  setTimeout(() => {
    arrive(false, "Something the bot said last week, surfacing only now.", 7 * 24 * 3600_000);
    const reply = arrive(false, "Working");
    setTimeout(() => arrive(false, "Working… done: submitted.", 0, reply.id), 25);
    setTimeout(() => arrive(false, "Anything else?"), 40);
  }, 20);
  const result = await relay.send({
    ...THREAD,
    bot: "Task Bot",
    text: "submit the form",
    wait_seconds: 5,
  });
  assert.deepEqual(posted, [`submit the form\n\n${BLOCK}`]);
  assert.deepEqual(
    (result.replies as Array<{ from: string; text: string }>).map((reply) => [
      reply.from,
      reply.text,
    ]),
    [
      ["Task Bot", "Working… done: submitted."],
      ["Task Bot", "Anything else?"],
    ],
  );
  assert.equal(calls.history, 0, "no page of history was read");
  assert.ok(calls.waits.length <= 6, "it waits on the journal instead of polling");
  assert.ok((calls.waits[0] ?? 0) > 4000, "first for the whole time it was given");
  assert.ok((calls.waits.at(-1) ?? 99) <= 60, "then only for the quiet after a reply");
  assert.match(String(result.cursor), /^\d{13}:\$j/);
});

test("with the journal: busy is judged from the last minutes alone", async () => {
  // The bot is mid-answer to something Leon asked before the window: still busy.
  const first = setupLive();
  first.arrive(false, "Here is part one of the long answer you asked for earlier today.", 30_000);
  const queued = await first.relay.send({
    ...THREAD,
    bot: "Task Bot",
    text: "one more thing",
    wait_seconds: 0,
  });
  assert.equal(queued.queued, true);
  assert.match(String(queued.reason), /posted 30s ago/);
  assert.equal(first.calls.history, 0);

  // Quiet for the whole window: idle, whatever happened before it.
  const second = setupLive();
  second.arrive(false, "All done.", 20 * 60_000);
  assert.equal(
    (await second.relay.send({ ...THREAD, bot: "Task Bot", text: "hi", wait_seconds: 0 })).queued,
    undefined,
  );

  // Leon asked two minutes ago and nothing came back yet: busy, and the queue flushes from the journal too.
  const third = setupLive();
  third.arrive(true, "do the thing", 2 * 60_000);
  assert.equal(
    (await third.relay.send({ ...THREAD, bot: "Task Bot", text: "and this", wait_seconds: 0 }))
      .queued,
    true,
  );
  third.arrive(false, "Done, here are the full results and the readback you wanted.", 90_000);
  await third.relay.flushOnce();
  assert.deepEqual(third.posted, [`and this\n\n${BLOCK}`]);
  assert.equal(third.calls.history, 0);
});

test("with the journal: reads come from it when it holds what is asked, from history when not", async () => {
  const { relay, arrive, calls } = setupLive({ coveredMinutes: 60 });
  const a = arrive(false, "first", 10 * 60_000);
  arrive(false, "second", 5 * 60_000);
  const later = await relay.read({ bot: "Task Bot", after: a.sortKey });
  assert.deepEqual(
    (later.messages as Array<{ text: string }>).map((line) => line.text),
    ["second"],
  );
  assert.equal(calls.history, 0, "a cursor inside the journal's coverage needs no history");
  assert.equal(((await relay.read({ bot: "Task Bot", limit: 2 })).messages as unknown[]).length, 2);
  assert.equal(calls.history, 0, "the latest two are in the journal");
  await relay.read({ bot: "Task Bot", limit: 10 });
  assert.equal(calls.history, 1, "more than the journal holds: one page of history");
  await relay.read({ bot: "Task Bot", after: `${Date.now() - 3 * 3600_000}:$old` });
  assert.equal(calls.history, 2, "a cursor from before the coverage: history too");
});

test("a journal younger than the busy window isn't trusted yet", async () => {
  const { relay, calls } = setupLive({ coveredMinutes: 5 });
  await relay.send({ ...THREAD, bot: "Task Bot", text: "hi", wait_seconds: 0 });
  assert.equal(
    calls.history,
    1,
    "one small page of history decides busy until the journal is old enough",
  );
});

test("one task bot per Slack thread: a task for a thread that has one goes to it", async () => {
  const { relay, chats, posted } = setup();
  // The thread's task bot, made earlier with the channel written as a name.
  chats["c-thread"] = { title: "Task slack:#leon-42-fix/1795280000.123456", messages: [] };
  const result = await relay.send({
    ...THREAD,
    bot: "Task Bot",
    text: "one more thing",
    wait_seconds: 0,
  });
  assert.equal(posted.length, 1);
  assert.equal(posted[0]?.chatID, "c-thread", "not the bot that was named");
  assert.equal(
    posted[0]?.text,
    `one more thing\n\n${followUpBlock({ channel: "C0TASKS001", threadTs: "1795280000.123456" })}`,
  );
  assert.equal(result.task_bot, "Task slack:#leon-42-fix/1795280000.123456");
  assert.equal(result.redirected_from, "Task Bot");
  // Another thread still gets a new task bot from the bot that was named.
  const other = await relay.send({
    bot: "Task Bot",
    text: "a new task",
    slack_channel: "C0TASKS001",
    slack_thread_ts: "1795280099.000001",
    wait_seconds: 0,
  });
  assert.equal(posted.at(-1)?.chatID, "c-task");
  assert.match(
    posted.at(-1)?.text ?? "",
    /Create a new bot for it named exactly "Task slack:C0TASKS001\/1795280099\.000001"/,
  );
  assert.equal(other.redirected_from, undefined);
});
