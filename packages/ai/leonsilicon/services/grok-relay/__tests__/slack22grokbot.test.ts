import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionJournal, JournalEntry } from "@-/ai.leonsilicon.services.beeper-inbox";
import { taskBotName } from "#handoff";
import { Slack22GrokBot, type BridgeServices } from "#slack22grokbot";
import type { GrokBackend } from "#types";

const start = 1_795_280_001_000;
const thread = { channel: "C0TASKS001", threadTs: "1795280000.123456" };
const wrong = { channel: "C0TASKS002", threadTs: thread.threadTs };
const name = taskBotName(thread);

test("routes by the full bot name, retries across restarts, mirrors edits, and retires only the completed bot", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "slack22grokbot-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const entries: JournalEntry[] = [];
  const message = (rev: number, text: string, isMe = false): JournalEntry => ({
    seq: 1,
    rev,
    roomId: "!grok:test",
    eventId: "$grok",
    sender: "@sender:test",
    isMe,
    type: "m.text",
    text,
    html: null,
    ts: start + 1,
    receivedAt: start + 1,
    edited: rev > 1,
    redacted: false,
    replyTo: null,
    attachments: 0,
  });
  const journal = {
    head: async () => 0,
    async changes({ after, roomId }) {
      const found = entries.filter((entry) => entry.roomId === roomId && entry.rev > after);
      return { entries: found, cursor: found.at(-1)?.rev ?? after };
    },
  } satisfies Partial<ExtensionJournal> as ExtensionJournal;
  let roster = [
    { id: "1", name, created_at: null },
    { id: "2", name: taskBotName(wrong), created_at: null },
  ];
  const slackReplies = [
    {
      ts: "1795280002.001000",
      from: "bot",
      author: "Captain Claude",
      userId: "UHERMES",
      files: [],
      text: "Please check page 2.",
    },
    { ts: "1795280002.002000", from: "leon", author: "Leon", files: [], text: "Include the date." },
  ];
  const copies: Record<string, unknown>[] = [];
  let fail = true;
  const services: BridgeServices = {
    roster: {
      list: async () => roster,
      async delete(id) {
        roster = roster.filter((bot) => bot.id !== id);
      },
    },
    slack: {
      async thread(target, after) {
        if (target.channel !== thread.channel) throw new Error("thread_not_found");
        const replies = after ? slackReplies.filter((reply) => reply.ts > after) : [];
        return {
          channel: target.channel,
          cursor: replies.at(-1)?.ts ?? after ?? target.threadTs,
          replies,
        };
      },
      async mirror(target, post) {
        assert.deepEqual(target, thread);
        copies.push(post);
        if (fail) {
          fail = false;
          throw new Error("response lost");
        }
        return { ts: "1795280002.123000" };
      },
    },
  };
  const sends: { chat: string; text: string; key: string }[] = [];
  const backend: GrokBackend = {
    bots: async () => [
      { name, chatID: "!grok:test", lastActivity: null },
      { name: taskBotName(wrong), chatID: "!other:test", lastActivity: null },
    ],
    messages: async () => [],
    async send(chat, text, key) {
      sends.push({ chat, text, key });
      return { id: "$sent" };
    },
  };
  const options = {
    stateFile: join(home, "state.json"),
    now: () => start,
    hermesUserId: "UHERMES",
    journal,
    services,
    backend,
    log: () => {},
  };
  let bridge = new Slack22GrokBot(options);
  entries.push(message(1, "First Grok result"));
  await bridge.tick();
  assert.equal(bridge.status().errors[name], "response lost");
  assert.equal(bridge.status().errors[taskBotName(wrong)], "thread_not_found");
  assert.deepEqual(
    sends.map(({ chat, text }) => ({ chat, text })),
    [
      { chat: "!grok:test", text: "Slack reply from Hermes:\nPlease check page 2." },
      { chat: "!grok:test", text: "Slack reply from Leon:\nInclude the date." },
    ],
  );
  assert.notEqual(sends[0]?.key, sends[1]?.key);

  bridge = new Slack22GrokBot(options);
  await bridge.tick();
  assert.equal(copies[1]?.eventId, copies[0]?.eventId);
  assert.equal(copies[1]?.retrySince, "1795279941.000000");
  assert.equal(sends.length, 2);

  entries.push(message(2, "Edited final Grok result"));
  entries.push({ ...message(3, "Slack reply copied into Grok", true), eventId: "$owner" });
  assert.deepEqual(await bridge.complete(thread), { ok: true, deleted: name });
  assert.equal(copies[2]?.slackTs, "1795280002.123000");
  assert.equal(copies[2]?.text, "Edited final Grok result");
  assert.equal(copies.length, 3);
  assert.deepEqual(
    roster.map((bot) => bot.id),
    ["2"],
  );
  assert.equal(new Slack22GrokBot(options).retired("!grok:test"), true);
});
