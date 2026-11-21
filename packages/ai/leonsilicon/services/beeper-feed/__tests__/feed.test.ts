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
import { beeperFeedExtension } from "#extension";
import { BeeperFeed } from "#feed";

const NOW = Date.parse("2026-11-21T21:00:00Z");
const rooms = ["whatsapp", "instagram", "slack", "beeper"].map((network): RoomInfo => ({
  roomId: `!${network}:example.test`,
  name: `${network} contact`,
  network,
  networkName: null,
  protocolId: network === "slack" ? "slackgo" : null,
  networkId: null,
  isDirect: true,
  isMuted: false,
}));

function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "beeper-feed-"));
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
  const make = () =>
    new BeeperFeed({
      source: {
        journal: {
          head: async () => journal.head(),
          changes: async (options) => journal.changes(options),
        },
        rooms: async (ids) => rooms.filter((room) => ids.includes(room.roomId)),
        senderNames: async () => ({ "@alice:example.test": "Alice" }),
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
      stateFile: join(home, "state.json"),
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
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("mirrors new messages by platform, routes held copies, and leaves Slack bridges out", async (t) => {
  const h = setup(t);
  h.record("old", "already in the journal");
  const feed = h.make();
  await feed.tick();
  h.record("backfill", "older history", "whatsapp", { ts: NOW - 1 });
  h.record("new", "hello <!channel> and <@U123>");
  h.record("own", "my message", "beeper", { isMe: true });
  h.record("spam", "spam: sale", "instagram");
  h.record("unsafe", "unsafe: scam", "instagram");
  h.record("slack", "already on Slack", "slack");
  await feed.tick();
  await feed.tick();
  assert.deepEqual(
    h.posts.map(({ channel }) => channel),
    ["feed-whatsapp", "feed-beeper", "feed-spam", "feed-flagged"],
  );
  assert.deepEqual(
    h.destinations.map(({ create }) => create),
    [true, true, false, false],
  );
  assert.match(h.posts[0].text, /whatsapp contact · whatsapp · Alice/);
  assert.match(h.posts[0].text, /&lt;!channel&gt; and &lt;@U123&gt;/);
  assert.doesNotMatch(h.posts[0].text, /<[@!]/);
  assert.match(h.posts[1].text, /beeper · Leon/);
  assert.equal(h.screened.length, 4);
  assert.equal(feed.status().posted, 4);
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

test("Beeper Feed asks only about safety and cannot start an MCP adapter or CLI tool", async () => {
  const request = screenRequest(
    { chat: { title: "Beeper", network: "beeper", type: "direct" }, messages: [] },
    "gpt-6-luna",
    { context: "Classify the message", maxText: 3_800 },
  );
  assert.deepEqual(
    request.questions.map(({ name }) => name),
    ["safety"],
  );

  const extensions = [beeperFeedExtension()];
  assert.equal(extensions[0].server, undefined);
  await assert.rejects(
    runCli(["mcp", "beeper-feed"], "test", {}, { extensions }),
    /no MCP extension/,
  );
  await assert.rejects(
    runCli(["extension", "beeper-feed", "register"], "test", {}, { extensions }),
    /no MCP extension/,
  );
});
