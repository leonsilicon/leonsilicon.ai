import assert from "node:assert/strict";
import { test } from "node:test";
import { inboxBackend, sortKeyOf } from "#backend";

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

test("messages: maps events, orders by time then event ID, and pages back until it has enough", async () => {
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
        messages: [event("$new", 1795000002000, { type: "m.notice" }), { event_id: "$broken" }],
        next_cursor: "older",
      },
      { messages: [event("$old", 1795000001000, { is_me: true })], next_cursor: "oldest" },
      { messages: [], next_cursor: null },
    ],
  });
  const found = await backend.messages("!a:beeper.local", 2);
  assert.deepEqual(found, [
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
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      { room_id: "!a:beeper.local", limit: 100 },
      { room_id: "!a:beeper.local", limit: 100, cursor: "older" },
    ],
  );
  assert.ok(
    sortKeyOf(999, "$z") < sortKeyOf(1000, "$a"),
    "an earlier time sorts first as a string",
  );
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
