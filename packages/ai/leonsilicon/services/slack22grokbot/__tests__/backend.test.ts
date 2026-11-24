import assert from "node:assert/strict";
import { test } from "node:test";
import { HISTORY_MAX, inboxBackend, sortKeyOf } from "#backend";

type Call = { name: string; args: Record<string, unknown> };

function fakeInbox(answers: Record<string, Array<Record<string, unknown>>>) {
  const calls: Call[] = [];
  const tool = async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    const next = answers[name]?.shift();
    if (!next) throw new Error(`unexpected ${name}`);
    return next;
  };
  return { calls, backend: inboxBackend(tool) };
}

test("bots: the Grok network's one-to-one chats, across pages, refreshing only when asked", async () => {
  const { calls, backend } = fakeInbox({
    list_conversations: [
      {
        conversations: [
          {
            room_id: "!a:beeper.local",
            name: "Google Bot",
            last_activity: "2026-11-20T20:43:56.205Z",
          },
          { room_id: "!b:beeper.local", name: null },
        ],
        next_offset: 2,
      },
      { conversations: [{ room_id: "!c:beeper.local", name: "UofT Bot" }], next_offset: null },
    ],
  });
  assert.deepEqual(await backend.bots({ refresh: true }), [
    { name: "Google Bot", chatID: "!a:beeper.local", lastActivity: "2026-11-20T20:43:56.205Z" },
    { name: "!b:beeper.local", chatID: "!b:beeper.local", lastActivity: null },
    { name: "UofT Bot", chatID: "!c:beeper.local", lastActivity: null },
  ]);
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      { network: "grok", direct_only: true, limit: 100, offset: 0, refresh: true },
      { network: "grok", direct_only: true, limit: 100, offset: 2 },
    ],
  );
});

test("messages: one page of history, capped, mapped and keyed by time then event ID", async () => {
  const event = (id: string, ts: number, extra: Record<string, unknown> = {}) => ({
    event_id: id,
    ts,
    timestamp: new Date(ts).toISOString(),
    type: "m.text",
    text: id,
    is_me: false,
    ...extra,
  });
  const { calls, backend } = fakeInbox({
    list_messages: [
      {
        messages: [
          event("$new", 1795000002000, { type: "m.notice" }),
          { event_id: "$broken" },
          event("$old", 1795000001000, { is_me: true }),
        ],
        next_cursor: "older",
      },
      { messages: [] },
    ],
  });
  assert.deepEqual(await backend.messages("!a:beeper.local", 500), [
    {
      id: "$new",
      chatID: "!a:beeper.local",
      sortKey: "1795000002000:$new",
      isSender: false,
      text: "$new",
      timestamp: new Date(1795000002000).toISOString(),
      type: "m.notice",
    },
    {
      id: "$old",
      chatID: "!a:beeper.local",
      sortKey: "1795000001000:$old",
      isSender: true,
      text: "$old",
      timestamp: new Date(1795000001000).toISOString(),
    },
  ]);
  await backend.messages("!a:beeper.local", 3);
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      { room_id: "!a:beeper.local", limit: HISTORY_MAX },
      { room_id: "!a:beeper.local", limit: 3 },
    ],
    "never more than one capped page: history costs about half a second a message",
  );
  assert.ok(
    sortKeyOf(999, "$z") < sortKeyOf(1000, "$a"),
    "an earlier time sorts first as a string",
  );
});

test("live: the inbox's journal, as the relay's messages", async () => {
  const entry = {
    seq: 4,
    rev: 9,
    roomId: "!a:beeper.local",
    eventId: "$j",
    sender: "@bot:beeper.local",
    isMe: false,
    type: "m.notice",
    text: "working",
    html: null,
    ts: 1795000003000,
    receivedAt: 1795000003500,
    edited: true,
    redacted: false,
    replyTo: null,
    attachments: 0,
  };
  const asked: unknown[] = [];
  const { backend } = fakeInbox({});
  assert.equal(backend.live, undefined, "no journal, no live path");
  const live = inboxBackend(async () => ({}), {
    head: async () => 9,
    coveredSince: async () => 1795000000000,
    latest: async () => [entry],
    since: async () => [{ ...entry, redacted: true, text: "" }],
    recent: async () => [],
    changes: async (options) => {
      asked.push(options);
      return { entries: [entry], cursor: 9 };
    },
  }).live;
  assert.ok(live);
  const mapped = {
    id: "$j",
    chatID: "!a:beeper.local",
    sortKey: "1795000003000:$j",
    isSender: false,
    text: "working",
    timestamp: new Date(1795000003000).toISOString(),
    type: "m.notice",
  };
  assert.deepEqual(await live.latest("!a:beeper.local", 5), [mapped]);
  assert.deepEqual(await live.since("!a:beeper.local", 0), [
    { ...mapped, text: "", isDeleted: true },
  ]);
  assert.deepEqual(await live.changes("!a:beeper.local", 3, 1500), {
    messages: [mapped],
    cursor: 9,
  });
  assert.deepEqual(asked, [{ after: 3, roomId: "!a:beeper.local", waitMs: 1500 }]);
  assert.deepEqual([await live.cursor(), await live.coveredSince()], [9, 1795000000000]);
});

test("send: passes the key through, and a bridge failure is an error", async () => {
  const { calls, backend } = fakeInbox({
    send_message: [
      { event_id: "$sent", bridge_status: { status: "SUCCESS" } },
      { event_id: "$lost", bridge_status: { status: "FAIL_PERMANENT", message: "bot is gone" } },
      { bridge_status: { status: "not_observed" } },
    ],
  });
  assert.deepEqual(await backend.send("!a:beeper.local", "hi", "send-1"), { id: "$sent" });
  assert.deepEqual(calls[0]?.args, {
    room_id: "!a:beeper.local",
    text: "hi",
    idempotency_key: "send-1",
  });
  await assert.rejects(
    backend.send("!a:beeper.local", "hi", "send-2"),
    /FAIL_PERMANENT: bot is gone/,
  );
  await assert.rejects(backend.send("!a:beeper.local", "hi", "send-3"), /no event ID/);
});
