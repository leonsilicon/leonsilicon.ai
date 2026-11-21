import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "#config";
import { linkBotMentions, type SlackUser } from "#directory";
import { CLIENT_MSG_ID_PREFIX, isMarked, newClientMsgId } from "#marker";
import { createHandler } from "#mcp";
import { memoryRateStore, Refused, SlackAsLeon, tsKey } from "#service";
import { SlackError, sessionClient, type SlackCall, type SlackParams } from "#slack";

const LEON = "U0LEON00001";
const TASK_BOT = "U0TASKBOT01";
const DOT = "U0SILICON01";
const FRIEND = "U0FRIEND01";
const TODO = "C0TODO0001";
const TASK_DM = "D0TASKBOT01";
const FRIEND_DM = "D0FRIEND01";

interface Message {
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  client_msg_id?: string;
  text: string;
  bot_profile?: { name: string };
  edited?: { ts: string };
}

/** A tiny Slack: users, channels, DMs, and a clock that bots answer on. */
function fakeSlack(clock: { t: number }) {
  const calls: { method: string; params: SlackParams }[] = [];
  const messages = new Map<string, Message[]>([
    [TODO, []],
    [TASK_DM, []],
    [FRIEND_DM, []],
  ]);
  /** Scheduled answers: [at ms, channel, message]. */
  const scheduled: [number, string, Message][] = [];
  let seq = 0;
  const nextTs = () =>
    `${1794500000 + Math.floor(clock.t / 1000)}.${String(++seq).padStart(6, "0")}`;
  const users = [
    { id: LEON, name: "leon", real_name: "Leon Si", profile: { display_name: "Leon" } },
    { id: TASK_BOT, name: "task_bot", real_name: "Task Bot", is_bot: true, profile: {} },
    { id: DOT, name: "silicon_dot", real_name: "Silicon Dot", is_bot: true, profile: {} },
    { id: FRIEND, name: "friend", real_name: "Friend Person", profile: { display_name: "Fri" } },
  ];
  const deliver = () => {
    for (let i = scheduled.length - 1; i >= 0; i--) {
      const [at, channel, message] = scheduled[i]!;
      if (clock.t < at) continue;
      messages.get(channel)!.push(message);
      scheduled.splice(i, 1);
    }
  };
  const slack: SlackCall = async (method, params = {}) => {
    calls.push({ method, params });
    deliver();
    switch (method) {
      case "auth.test":
        return { ok: true, user_id: LEON };
      case "users.list":
        return { ok: true, members: users };
      case "users.info":
        return { ok: true, user: users.find((u) => u.id === params.user) };
      case "conversations.list":
        return params.types === "im"
          ? {
              ok: true,
              channels: [
                { id: TASK_DM, user: TASK_BOT },
                { id: FRIEND_DM, user: FRIEND },
              ],
            }
          : { ok: true, channels: [{ id: TODO, name: "todo" }] };
      case "conversations.open": {
        const id = params.users === TASK_BOT ? TASK_DM : params.users === FRIEND ? FRIEND_DM : "";
        return { ok: true, channel: { id } };
      }
      case "conversations.info": {
        const user =
          params.channel === TASK_DM ? TASK_BOT : params.channel === FRIEND_DM ? FRIEND : undefined;
        return { ok: true, channel: user ? { is_im: true, user } : { is_im: false } };
      }
      case "chat.postMessage": {
        const channel = String(params.channel);
        const message: Message = {
          ts: nextTs(),
          user: LEON,
          text: String(params.text),
          client_msg_id: String(params.client_msg_id),
          ...(params.thread_ts ? { thread_ts: String(params.thread_ts) } : {}),
        };
        messages.get(channel)!.push(message);
        // Task Bot answers mentions in the thread after 6 s, and DMs at the top level after 4 s.
        const text = String(params.text);
        if (channel === TODO && text.includes(`<@${TASK_BOT}>`))
          scheduled.push([
            clock.t + 6000,
            channel,
            {
              ts: `${1794500000 + Math.floor((clock.t + 6000) / 1000)}.900000`,
              thread_ts: message.thread_ts ?? message.ts,
              user: TASK_BOT,
              bot_id: "B0TASKBOT01",
              bot_profile: { name: "Task Bot" },
              text: "Added it to your list.",
            },
          ]);
        if (channel === TASK_DM)
          scheduled.push([
            clock.t + 4000,
            channel,
            {
              ts: `${1794500000 + Math.floor((clock.t + 4000) / 1000)}.900000`,
              user: TASK_BOT,
              bot_id: "B0TASKBOT01",
              bot_profile: { name: "Task Bot" },
              text: "You have 3 tasks today.",
            },
          ]);
        return { ok: true, channel, ts: message.ts };
      }
      case "chat.getPermalink":
        return {
          ok: true,
          permalink: `https://leonsilicon.slack.com/archives/${params.channel}/p1`,
        };
      case "conversations.replies": {
        const root = String(params.ts);
        const all = messages.get(String(params.channel)) ?? [];
        return {
          ok: true,
          messages: all.filter((m) => m.ts === root || m.thread_ts === root),
        };
      }
      case "conversations.history": {
        const all = messages.get(String(params.channel)) ?? [];
        return { ok: true, messages: all.filter((m) => !m.thread_ts || m.thread_ts === m.ts) };
      }
      default:
        throw new SlackError(method, "unknown_method");
    }
  };
  return { slack, calls, messages };
}

function setup(overrides: { maxPerHour?: number } = {}) {
  const clock = { t: 0 };
  const fake = fakeSlack(clock);
  const settings = {
    maxPerHour: overrides.maxPerHour ?? 30,
    blockedUsers: [DOT],
    maxWaitSeconds: 150,
  };
  const options = {
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.t += ms;
    },
    pollMs: 1000,
    settleMs: 3000,
  };
  const service = new SlackAsLeon(settings, fake.slack, memoryRateStore(), options);
  return { clock, service, settings, options, ...fake };
}

test("client_msg_id carries the marker and still looks like a UUID", () => {
  const id = newClientMsgId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(id.startsWith(`${CLIENT_MSG_ID_PREFIX}-`));
  assert.ok(isMarked(id));
  assert.ok(!isMarked("3f2b1c4d-1111-4222-8333-944455556666"));
  assert.ok(!isMarked(undefined));
  assert.notEqual(newClientMsgId(), newClientMsgId());
});

test("tsKey orders Slack timestamps exactly", () => {
  assert.ok(tsKey("1794500000.000010") > tsKey("1794500000.000009"));
  assert.ok(tsKey("1794500001.000000") > tsKey("1794500000.999999"));
  assert.equal(tsKey("1794500000.5"), tsKey("1794500000.500000"));
});

test("linkBotMentions links written-out bot names only", () => {
  const bots: SlackUser[] = [
    { id: "UTASK", name: "Task Bot", names: ["Task Bot", "task_bot"], isBot: true },
    { id: "UTASKPRO", name: "Task Bot Pro", names: ["Task Bot Pro"], isBot: true },
  ];
  assert.equal(linkBotMentions("@Task Bot add milk", bots), "<@UTASK> add milk");
  assert.equal(linkBotMentions("hey @task bot, add milk", bots), "hey <@UTASK>, add milk");
  assert.equal(linkBotMentions("@Task Bot Pro ping", bots), "<@UTASKPRO> ping");
  assert.equal(linkBotMentions("(@task_bot)", bots), "(<@UTASK>)");
  assert.equal(linkBotMentions("mail me@Task Bot", bots), "mail me@Task Bot");
  assert.equal(linkBotMentions("@Task Botany", bots), "@Task Botany");
  assert.equal(linkBotMentions("<@UTASK> already", bots), "<@UTASK> already");
});

test("send posts as Leon with the marker, then waits for the bot's answer in the thread", async () => {
  const { service, calls } = setup();
  const result = await service.send({ channel: "#todo", text: "@Task Bot add milk to my list" });
  const post = calls.find((c) => c.method === "chat.postMessage")!;
  assert.equal(post.params.channel, TODO);
  assert.equal(post.params.text, `<@${TASK_BOT}> add milk to my list`);
  assert.ok(isMarked(post.params.client_msg_id));
  assert.equal(post.params.thread_ts, undefined);
  assert.equal(result.addressed_to_bot, true);
  assert.equal(result.answered, true);
  assert.deepEqual(
    result.replies.map((r) => [r.from, r.author, r.text]),
    [["bot", "Task Bot", "Added it to your list."]],
  );
  assert.equal(result.cursor, result.replies[0]!.ts);
  assert.equal(result.thread_ts, result.ts);
  assert.ok(result.permalink);
  assert.ok(
    result.waited_seconds >= 9 && result.waited_seconds <= 12,
    String(result.waited_seconds),
  );
});

test("a message to people returns at once, and replies in a thread keep their thread", async () => {
  const { service, calls } = setup();
  const result = await service.send({
    channel: FRIEND,
    text: "running 5 min late",
    thread_ts: "1794400000.000100",
  });
  assert.equal(result.channel, FRIEND_DM);
  assert.equal(result.addressed_to_bot, false);
  assert.equal(result.waited_seconds, 0);
  assert.equal(result.thread_ts, "1794400000.000100");
  assert.equal(calls.filter((c) => c.method === "conversations.replies").length, 1);
  assert.equal(
    calls.find((c) => c.method === "chat.postMessage")!.params.thread_ts,
    "1794400000.000100",
  );
});

test("a DM to a bot counts its top-level answer", async () => {
  const { service } = setup();
  const result = await service.send({ channel: TASK_BOT, text: "what's on my list today?" });
  assert.equal(result.channel, TASK_DM);
  assert.equal(result.addressed_to_bot, true);
  assert.deepEqual(
    result.replies.map((r) => [r.from, r.text, r.topLevel]),
    [["bot", "You have 3 tasks today.", true]],
  );
});

test("read returns only newer answers, and only for messages sent here", async () => {
  const { service, clock } = setup();
  const sent = await service.send({
    channel: TODO,
    text: `<@${TASK_BOT}> add eggs`,
    wait_seconds: 0,
  });
  assert.equal(sent.answered, false);
  assert.deepEqual(sent.replies, []);
  clock.t += 10_000;
  const first = await service.read({ channel: TODO, ts: sent.ts });
  assert.equal(first.replies.length, 1);
  const again = await service.read({ channel: TODO, ts: sent.ts, after: first.cursor });
  assert.deepEqual(again.replies, []);
  await assert.rejects(service.read({ channel: TODO, ts: "1794400000.000001" }), Refused);
  await assert.rejects(service.read({ channel: TASK_DM, ts: sent.ts }), Refused);
});

test("refuses Silicon Dot, broadcasts, bad input and too many messages", async () => {
  const { service, calls } = setup({ maxPerHour: 2 });
  await assert.rejects(service.send({ channel: DOT, text: "do this" }), /Silicon Dot/);
  await assert.rejects(service.send({ channel: "@Silicon Dot", text: "do this" }), /Silicon Dot/);
  await assert.rejects(service.send({ channel: TODO, text: `<@${DOT}> do this` }), /Silicon Dot/);
  await assert.rejects(service.send({ channel: TODO, text: "<!here> lunch" }), /@here/);
  await assert.rejects(service.send({ channel: TODO, text: "hey @channel lunch" }), /@here/);
  await assert.rejects(service.send({ channel: TODO, text: "   " }), /empty/);
  await assert.rejects(service.send({ channel: "todo", text: "x" }), /conversation ID/);
  await assert.rejects(service.send({ channel: "#nope", text: "x" }), /no channel named/);
  await assert.rejects(
    service.send({ channel: TODO, text: "x", thread_ts: "yesterday" }),
    /thread_ts/,
  );
  assert.equal(calls.filter((c) => c.method === "chat.postMessage").length, 0);
  await service.send({ channel: TODO, text: "one" });
  await service.send({ channel: TODO, text: "two" });
  await assert.rejects(service.send({ channel: TODO, text: "three" }), /last hour/);
});

test("Slack is the record: another instance reads answers, but never Leon's own messages", async () => {
  const { service, slack, settings, options, messages, clock } = setup();
  const sent = await service.send({
    channel: TODO,
    text: `<@${TASK_BOT}> add eggs`,
    wait_seconds: 0,
  });
  const inThread = await service.send({ channel: TODO, text: "and bread", thread_ts: sent.ts });
  clock.t += 10_000;
  const other = new SlackAsLeon(settings, slack, memoryRateStore(), options);
  const read = await other.read({ channel: TODO, ts: sent.ts });
  assert.deepEqual(
    read.replies.map((r) => r.from),
    ["you", "bot"],
  );
  // A reply posted inside a thread is found too, and reads that thread.
  const fromReply = await other.read({ channel: TODO, ts: inThread.ts });
  assert.deepEqual(
    fromReply.replies.map((r) => r.from),
    ["bot"],
  );
  messages.get(TODO)!.push({
    ts: "1794500099.000001",
    user: LEON,
    text: "typed by Leon himself",
    client_msg_id: "3f2b1c4d-1111-4222-8333-944455556666",
  });
  await assert.rejects(other.read({ channel: TODO, ts: "1794500099.000001" }), Refused);
});

test("sessionClient sends the session like the web client and surfaces Slack errors", async () => {
  const seen: { url: string; body: string; cookie: string }[] = [];
  let reply = () => Response.json({ ok: true, user_id: LEON });
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({
      url,
      body: (init.body as URLSearchParams).toString(),
      cookie: new Headers(init.headers).get("cookie") ?? "",
    });
    return reply();
  }) as typeof fetch;
  const call = sessionClient({ token: "xoxc-abc", cookie: "xoxd-d%2Fe" }, fetchImpl);
  assert.equal((await call("auth.test")).user_id, LEON);
  assert.equal(seen[0]!.url, "https://slack.com/api/auth.test");
  assert.equal(new URLSearchParams(seen[0]!.body).get("token"), "xoxc-abc");
  assert.equal(seen[0]!.cookie, "d=xoxd-d%2Fe");
  await call("chat.postMessage", { channel: TODO, text: "hi", thread_ts: undefined });
  assert.equal(new URLSearchParams(seen[1]!.body).has("thread_ts"), false);
  reply = () => Response.json({ ok: false, error: "invalid_auth" });
  await assert.rejects(
    call("auth.test"),
    (e) => e instanceof SlackError && e.code === "invalid_auth",
  );
});

test("the MCP endpoint needs the bearer token, lists three tools and streams tool calls", async () => {
  const { service } = setup();
  const token = "k".repeat(64);
  const handle = createHandler(
    { token, publicOrigin: "https://ai.example.com" },
    service,
    "/slack-as-leon",
  );
  const url = "https://ai.example.com/slack-as-leon";
  const rpc = (body: unknown, auth = `Bearer ${token}`, headers: Record<string, string> = {}) =>
    handle(
      new Request(url, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  const call = async (name: string, args: unknown) => {
    const response = await rpc({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name, arguments: args },
    });
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const data = (await response.text()).split("\n").find((l) => l.startsWith("data: "))!;
    const message = JSON.parse(data.slice(6)) as {
      id: number;
      result: { isError: boolean; content: { text: string }[] };
    };
    assert.equal(message.id, 7);
    return { isError: message.result.isError, text: message.result.content[0]!.text };
  };

  assert.equal((await rpc({}, "Bearer wrong")).status, 401);
  assert.equal((await rpc({}, `Bearer ${token}x`)).status, 401);
  assert.equal((await rpc({}, undefined, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await handle(new Request("https://ai.example.com/other"))).status, 404);
  assert.equal((await handle(new Request(`${url}/secret`))).status, 404);
  const health = await handle(new Request(`${url}/healthz`));
  assert.equal(((await health.json()) as { session: string }).session, "ok");

  const init = (await (
    await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    })
  ).json()) as { result: { protocolVersion: string; instructions: string } };
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.match(init.result.instructions, /Write as Leon/);
  assert.equal((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const list = (await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as {
    result: { tools: { name: string }[] };
  };
  assert.deepEqual(list.result.tools.map((t) => t.name).sort(), [
    "slack_bots",
    "slack_read_as_leon",
    "slack_send_as_leon",
  ]);

  const bots = JSON.parse((await call("slack_bots", {})).text) as { bots: unknown[] };
  assert.deepEqual(bots.bots, [
    { id: TASK_BOT, name: "Task Bot", mention: `<@${TASK_BOT}>`, dm_channel: TASK_DM },
  ]);
  const refused = await call("slack_send_as_leon", { channel: DOT, text: "hi" });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /Silicon Dot/);
  const sent = await call("slack_send_as_leon", { channel: TASK_BOT, text: "what's on today?" });
  assert.match(sent.text, /You have 3 tasks today/);
  const unknown = (await (
    await rpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "nope" } })
  ).json()) as { error: { code: number } };
  assert.equal(unknown.error.code, -32602);
});

test("loadConfig needs the blocked-users list, which has no built-in default", () => {
  const base = {
    SLACK_AS_LEON_MCP_TOKEN: "t".repeat(40),
    SLACK_SESSION_TOKEN: "xoxc-session",
    SLACK_SESSION_COOKIE: "cookie",
  };
  assert.throws(() => loadConfig(base), /SLACK_AS_LEON_BLOCKED_USERS is required/);
  const config = loadConfig({ ...base, SLACK_AS_LEON_BLOCKED_USERS: ` ${DOT}, ${FRIEND} ,` });
  assert.deepEqual(config.blockedUsers, [DOT, FRIEND]);
  assert.deepEqual(loadConfig({ ...base, SLACK_AS_LEON_BLOCKED_USERS: "" }).blockedUsers, []);
});
