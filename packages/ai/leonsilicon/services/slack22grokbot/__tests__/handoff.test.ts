import assert from "node:assert/strict";
import { test } from "node:test";
import { handoffBlock, slackIdentifier, slackThread, taskName } from "#handoff";
import { compose } from "#policy";
import { createGrokDelegation } from "#relay";

const T1 = { channel: "C0TASKS001", threadTs: "1795280000.123456" };
const T2 = { channel: "#leon-42-fix-the-thing", threadTs: "1795280001.000001" };

test("the thread is checked, and becomes the identifier and the task bot's name", () => {
  assert.deepEqual(slackThread(" C0TASKS001 ", "1795280000.123456"), T1);
  assert.deepEqual(slackThread("#leon-42-fix-the-thing", "1795280001.000001"), T2);
  assert.equal(slackIdentifier(T1), "slack:C0TASKS001/1795280000.123456");
  assert.equal(taskName(T1), "Task slack:C0TASKS001/1795280000.123456");
  assert.throws(() => slackThread(undefined, undefined), /are required/);
  assert.throws(() => slackThread("C0TASKS001", ""), /are required/);
  assert.throws(() => slackThread("D0LEONDM01", "1795280000.123456"), /not a DM/);
  assert.throws(() => slackThread("@Leon", "1795280000.123456"), /not a DM/);
  assert.throws(() => slackThread("general", "1795280000.123456"), /channel ID/);
  assert.throws(() => slackThread("C0TASKS001", "yesterday"), /Slack ts/);
});

test("the block tells the bot to spawn the task bot, and how it talks to Hermes", () => {
  const block = handoffBlock(T1);
  assert.match(block, /^---\nSlack thread for this task: slack:C0TASKS001\/1795280000\.123456/);
  assert.match(block, /named exactly "Task slack:C0TASKS001\/1795280000\.123456"/);
  assert.match(
    block,
    /Beeper copies each reply to Slack thread slack:C0TASKS001\/1795280000\.123456/,
  );
  assert.match(block, /Hermes retires the task bot/);
});

test("merged messages carry one block per thread, naming their items when there are several", () => {
  const at = "2026-11-21T18:00:00.000Z";
  assert.equal(compose([{ text: "one", at, thread: T1 }]), `one\n\n${handoffBlock(T1)}`);
  const same = compose([
    { text: "one", at, thread: T1 },
    { text: "two", at, thread: T1 },
  ]);
  assert.equal(same.split("Slack thread for").length - 1, 1);
  const mixed = compose([
    { text: "one", at, thread: T1 },
    { text: "two", at, thread: T2 },
    { text: "three", at, thread: T1 },
  ]);
  assert.match(mixed, /Slack thread for items 1, 3: slack:C0TASKS001/);
  assert.match(mixed, /Slack thread for item 2: slack:#leon-42-fix-the-thing/);
});

test("grok_bot_send refuses a task without its Slack thread", async () => {
  const relay = createGrokDelegation({
    stateDir: (await import("node:fs")).mkdtempSync(`${(await import("node:os")).tmpdir()}/relay-`),
    backend: {
      bots: async () => [{ name: "Task Bot", chatID: "!task:beeper" }],
      send: async () => ({ id: "$x" }),
      messages: async () => ({ messages: [], cursor: 0 }),
    } as never,
    log: () => {},
  } as never);
  await assert.rejects(
    relay.send({ bot: "Task Bot", text: "do it", wait_seconds: 0 }),
    /slack_channel and slack_thread_ts are required/,
  );
});
