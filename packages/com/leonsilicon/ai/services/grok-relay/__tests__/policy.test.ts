import assert from "node:assert/strict";
import { test } from "node:test";
import {
  budgetExceededMessage,
  budgetStatus,
  busy,
  compose,
  EXTENSION,
  extendBudget,
  guardBot,
  HOUR_MS,
  HOURLY_BUDGET,
  isAck,
  plain,
  pruneBudget,
  recordSend,
  takeBatch,
  type ChatLine,
} from "#policy";
import type { BudgetState } from "#types";

const T0 = Date.parse("2026-11-07T19:00:00Z");
const s = (seconds: number): number => seconds * 1000;
let key = 100;
const msg = (isSender: boolean, offsetMs: number, text = "x"): ChatLine => ({
  isSender,
  timestamp: new Date(T0 + offsetMs).toISOString(),
  sortKey: String(key++),
  text,
});

test("idle when Leon never wrote", () => {
  assert.equal(busy([msg(false, 0, "hello")], T0 + s(5)).busy, false);
  assert.equal(busy([], T0).busy, false);
});

test("busy while the last message has no reply, idle after 10 min", () => {
  const chat = [msg(false, 0, "done"), msg(true, s(10), "do the thing")];
  assert.equal(busy(chat, T0 + s(70)).busy, true);
  assert.equal(busy(chat, T0 + s(10) + 9 * 60000).busy, true);
  assert.equal(busy(chat, T0 + s(10) + 11 * 60000).busy, false);
});

test("busy right after a reply, idle once quiet for 60s", () => {
  const chat = [
    msg(true, 0, "do it"),
    msg(
      false,
      s(30),
      "Here is the full answer with everything you asked for, finished and verified in Linear.",
    ),
  ];
  assert.equal(busy(chat, T0 + s(60)).busy, true);
  assert.equal(busy(chat, T0 + s(95)).busy, false);
});

test("only acks: busy up to 5 min of quiet, then idle", () => {
  const chat = [msg(true, 0, "check my inbox"), msg(false, s(5), "Checking your inbox now.")];
  assert.equal(busy(chat, T0 + s(5) + s(120)).busy, true);
  assert.equal(busy(chat, T0 + s(5) + s(310)).busy, false);
});

test("ack variants and non-acks", () => {
  for (const text of [
    "On it.",
    "I’ll check that now.",
    "I'm pulling the issues now.",
    "Let me look.",
    "Got it, working on it.",
    "**Checking** now",
  ])
    assert.equal(isAck(text), true, text);
  assert.equal(isAck("Done. LEON-6 is now marked Done and the readback matches."), false);
  assert.equal(isAck(`Checking ${"x".repeat(250)}`), false); // long text is a real answer
});

test("stale ack: idle once our message is over 20 min old", () => {
  const chat = [msg(true, 0, "go"), msg(false, 19 * 60000, "On it")];
  // quiet 2 min (< 5 min) but our message is 21 min old
  assert.equal(busy(chat, T0 + 21 * 60000).busy, false);
});

test("a real reply followed by Leon typing again makes it busy again", () => {
  const chat = [
    msg(true, 0, "a"),
    msg(false, s(20), "Full answer that is clearly not an acknowledgement at all, with details."),
    msg(true, s(300), "b"),
  ];
  assert.equal(busy(chat, T0 + s(330)).busy, true);
});

test("compose: one item unchanged, several numbered in order", () => {
  assert.equal(compose(["just this"]), "just this");
  assert.equal(
    compose([
      { text: " a ", at: "" },
      { text: "b", at: "" },
    ]),
    "a few more things, in order:\n\n1. a\n\n2. b",
  );
  assert.equal(compose([]), "");
});

test("takeBatch keeps under the size limit but always takes one", () => {
  const items = ["a".repeat(50), "b".repeat(50), "c".repeat(50)];
  assert.equal(takeBatch(items, 1000).length, 3);
  assert.equal(takeBatch(items, 150).length, 2);
  assert.equal(takeBatch(items, 10).length, 1);
});

test("budget: rolling hour, refuses at the limit, frees as sends age out", () => {
  let state: Partial<BudgetState> = {};
  for (let i = 0; i < HOURLY_BUDGET; i++) state = recordSend(state, T0 + i * 1000);
  assert.equal(budgetStatus(state, T0 + s(30)).remaining, 0);
  assert.match(
    budgetExceededMessage(budgetStatus(state, T0 + s(30)), "Task Bot", "do x"),
    /Ask Leon in Slack/,
  );
  // the first send ages out after an hour
  assert.equal(budgetStatus(state, T0 + HOUR_MS + 500).remaining, 1);
  assert.equal(pruneBudget(state, T0 + 2 * HOUR_MS).sends.length, 0);
});

test("budget extension: only when exhausted, adds EXTENSION for the hour, needs a quote", () => {
  let state: Partial<BudgetState> = {};
  assert.equal(extendBudget(state, "yes keep going", T0).extended, false); // not exhausted yet
  for (let i = 0; i < HOURLY_BUDGET; i++) state = recordSend(state, T0 + i);
  assert.throws(() => extendBudget(state, "ok", T0 + s(1)), /quote Leon/);
  const result = extendBudget(state, "yes, keep going with the sweep", T0 + s(1));
  assert.equal(result.extended, true);
  assert.equal(budgetStatus(result.state, T0 + s(2)).limit, HOURLY_BUDGET + EXTENSION);
  assert.equal(budgetStatus(result.state, T0 + s(2)).remaining, EXTENSION);
  assert.equal(budgetStatus(result.state, T0 + HOUR_MS + s(5)).limit, HOURLY_BUDGET);
});

test("Linear and Todoist bots need a reason of some length; other bots don't", () => {
  assert.equal(guardBot("Task Bot", undefined), null);
  assert.throws(() => guardBot("Linear Bot", "because"), /linear\/todoist MCP tools/);
  assert.equal(
    guardBot("Todoist Bot", "  the todoist MCP cannot create filters  "),
    "the todoist MCP cannot create filters",
  );
});

test("plain: HTML to text with links kept", () => {
  assert.equal(
    plain(
      '<p>See <a href="https://x.test/a">the page</a></p><ul><li>one</li><li>two &amp; 3</li></ul>',
    ),
    "See the page (https://x.test/a)\n- one\n- two & 3",
  );
});
