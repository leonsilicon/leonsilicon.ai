import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import {
  MessageJournal,
  runCli,
  type JournalMessage,
  type RoomInfo,
} from "@-/ai.leonsilicon.services.beeper-inbox";
import {
  screenRequest,
  type Route,
  type SlackPoster,
} from "@-/ai.leonsilicon.services.feed-common";
import { beeperToSlackExtension } from "#extension";
import { BeeperFeed } from "#feed";

const NOW = Date.parse("2026-11-21T21:00:00Z");
const rooms = ["whatsapp", "instagram", "slack", "beeper", "telegram", "other-group"].map(
  (id): RoomInfo => ({
    roomId: `!${id}:example.test`,
    network: id === "other-group" ? "whatsapp" : id,
    name: `${id} contact`,
    networkName: null,
    protocolId: id === "slack" ? "slackgo" : null,
    networkId: null,
    isDirect: true,
    isMuted: false,
  }),
);

function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "beeper-to-slack-"));
  const db = new DatabaseSync(":memory:");
  t.after(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  let now = NOW;
  const journal = new MessageJournal(db, now);
  const posts: Array<{ channel: string; text: string }> = [];
  const destinations: Array<{ channel: string; create: boolean }> = [];
  const screened: string[] = [];
  const failures = new Set<string>();
  const directory = new Map(rooms.map((room) => [room.roomId, room]));
  let refreshes = 0;
  const slack: SlackPoster = {
    async ensureChannel(channel, { create }) {
      destinations.push({ channel, create });
      return { id: channel, created: false, problems: [] };
    },
    async post(channel, text) {
      if (failures.has(channel)) throw new Error("temporary Slack failure");
      posts.push({ channel, text });
      return { ts: String(posts.length) };
    },
  };
  const make = (network = "whatsapp", roomIds?: ReadonlySet<string>) =>
    new BeeperFeed({
      network,
      roomIds,
      source: {
        journal: {
          head: async () => journal.head(),
          changes: async (options) => journal.changes(options),
        },
        rooms: async (ids) => [...directory.values()].filter((room) => ids.includes(room.roomId)),
        senderNames: async () => ({ "@alice:example.test": "Alice" }),
        async refreshRooms() {
          refreshes += 1;
          for (const room of rooms) directory.set(room.roomId, room);
        },
      },
      slack,
      screener: {
        async screen(input) {
          const text = input.messages[0].text;
          screened.push(text);
          const leading = text.split(":")[0];
          const route: Route =
            leading === "spam" ? "spam" : leading === "unsafe" ? "unsafe" : "safe";
          return {
            route,
            reason: route === "spam" ? "promotion" : route === "unsafe" ? "prompt_injection" : "ok",
            by: "model",
            wake: true,
          };
        },
      },
      flaggedChannel: "feed-flagged",
      spamChannel: "feed-spam",
      invite: [],
      stateFile: join(home, `${network}.json`),
      log: () => {},
      now: () => now,
    });
  const record = (
    id: string,
    text: string,
    room = "whatsapp",
    changes: Partial<JournalMessage> = {},
  ) =>
    journal.record(
      {
        eventId: `$${id}`,
        roomId: `!${room}:example.test`,
        sender: "@alice:example.test",
        isMe: false,
        type: "m.text",
        text,
        ts: now,
        ...changes,
      },
      now,
    );
  return {
    make,
    posts,
    destinations,
    failures,
    screened,
    record,
    journal,
    directory,
    refreshes: () => refreshes,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("keeps the two feeds independent and screens messages only from the selected network", async (t) => {
  const h = setup(t);
  h.record("old", "already in the journal");
  const whatsapp = h.make();
  const instagram = h.make("instagram");
  await whatsapp.tick();
  await instagram.tick();
  h.record("backfill", "older history", "whatsapp", { ts: NOW - 1 });
  h.record("new", "hello <!channel> and <@U123>");
  h.record("own", "my message", "instagram", { isMe: true });
  h.record("spam", "spam: sale", "instagram");
  h.record("unsafe", "unsafe: scam", "instagram");
  h.record("slack", "already on Slack", "slack");
  h.record("beeper", "Beeper message", "beeper");
  h.record("telegram", "Telegram message", "telegram");

  await whatsapp.tick();
  await instagram.tick();
  await whatsapp.tick();
  await instagram.tick();

  assert.deepEqual(
    h.posts.map(({ channel }) => channel),
    ["feed-whatsapp", "feed-instagram", "feed-spam", "feed-flagged"],
  );
  assert.deepEqual(
    h.destinations.map(({ create }) => create),
    [true, true, false, false],
  );
  assert.match(h.posts[0].text, /whatsapp contact · whatsapp · Alice/);
  assert.match(h.posts[0].text, /&lt;!channel&gt; and &lt;@U123&gt;/);
  assert.doesNotMatch(h.posts[0].text, /<[@!]/);
  assert.match(h.posts[1].text, /instagram · Leon/);
  assert.deepEqual(h.screened, [
    "hello <!channel> and <@U123>",
    "my message",
    "spam: sale",
    "unsafe: scam",
  ]);
  assert.equal(whatsapp.status().posted, 1);
  assert.equal(instagram.status().posted, 3);
});

test("restricts a feed to configured rooms and rechecks queued messages on restart", async (t) => {
  const h = setup(t);
  const allowed = new Set(["!whatsapp:example.test", "!instagram:example.test"]);
  const feed = h.make("whatsapp", allowed);
  await feed.tick();
  h.failures.add("feed-whatsapp");
  h.record("selected", "selected WhatsApp chat");
  h.record("other-chat", "unselected WhatsApp chat", "other-group");
  h.record("other-network", "Instagram chat on the WhatsApp allowlist", "instagram");
  await feed.tick();
  assert.deepEqual(h.screened, ["selected WhatsApp chat"]);
  assert.equal(feed.status().pending, 1);
  assert.equal(h.posts.length, 0);

  h.failures.clear();
  h.advance(31_000);
  const narrowed = h.make("whatsapp", new Set(["!other-group:example.test"]));
  await narrowed.tick();
  assert.equal(narrowed.status().pending, 0);
  assert.equal(h.posts.length, 0);
  h.record("new-selected", "new in selected group", "other-group");
  await narrowed.tick();
  assert.equal(h.posts.length, 1);
  assert.match(h.posts[0].text, /new in selected group/);
});

test("restarts retry Slack with the saved verdict and apply edits and redactions to pending copies", async (t) => {
  const h = setup(t);
  await h.make().tick();
  h.failures.add("feed-whatsapp");
  h.record("retry", "retry once");
  h.record("edit", "text before editing");
  h.record("remove", "text before deletion");
  await h.make().tick();
  assert.equal(h.posts.length, 0);

  h.failures.clear();
  h.advance(31_000);
  h.record("change", "edited text", "whatsapp", { replaces: "$edit" });
  h.journal.redact("$remove");
  const feed = h.make();
  await feed.tick();
  assert.deepEqual(h.screened, [
    "retry once",
    "text before editing",
    "text before deletion",
    "edited text",
  ]);
  assert.equal(h.posts.length, 2);
  assert.match(h.posts[1].text, /edited text/);
  assert.doesNotMatch(h.posts.map(({ text }) => text).join("\n"), /before editing|before deletion/);

  h.record("later", "edited after delivery", "whatsapp", { replaces: "$retry" });
  await h.make().tick();
  assert.equal(h.posts.length, 2);
});

test("newly joined rooms are resolved before messages are routed", async (t) => {
  const h = setup(t);
  h.directory.delete("!whatsapp:example.test");
  h.directory.delete("!slack:example.test");
  const feed = h.make();
  await feed.tick();
  h.record("new-chat", "hello");
  h.record("new-slack-chat", "already on Slack", "slack");
  await feed.tick();
  assert.equal(h.refreshes(), 1);
  assert.deepEqual(
    h.posts.map(({ channel }) => channel),
    ["feed-whatsapp"],
  );
});

test("Slack feeds screen for safety and expose neither MCP nor CLI tools", async () => {
  const request = screenRequest(
    { chat: { title: "Beeper", network: "beeper", type: "direct" }, messages: [] },
    "gpt-6-luna",
    { context: "Classify the message", maxText: 3_800 },
  );
  assert.deepEqual(
    request.questions.map(({ name }) => name),
    ["safety"],
  );

  const extensions = [beeperToSlackExtension({ name: "instagram2slack", network: "instagram" })];
  assert.equal(extensions[0].server, undefined);
  await assert.rejects(
    runCli(["mcp", "instagram2slack"], "test", {}, { extensions }),
    /no MCP extension/,
  );
  await assert.rejects(
    runCli(["extension", "instagram2slack", "register"], "test", {}, { extensions }),
    /no MCP extension/,
  );
});
