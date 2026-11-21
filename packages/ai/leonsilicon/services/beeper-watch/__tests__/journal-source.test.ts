import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseEnv } from "#extension";
import { Feed } from "#feed";
import type { InboxAccess, JournalEntry, RoomInfo } from "#inbox";
import { accountOf, journalSource, typeOf } from "#journal-source";
import { loadCoreConfig } from "#service";
import type { Logger, SlackPoster } from "#types";

const T0 = Date.parse("2026-11-21T16:00:00Z");
const quiet: Logger = () => {};
const TEAM = "T0WORKSPACE";

const ROOMS: Record<string, RoomInfo> = Object.fromEntries(
  (
    [
      ["!wa:beeper.local", "Sam", "whatsapp", "WhatsApp", "whatsapp", null, true, false],
      [
        "!grp:beeper.local",
        "Club group",
        "instagram",
        "Instagram",
        "instagramgo",
        null,
        false,
        false,
      ],
      [
        "!mute:beeper.local",
        "Muted pal",
        "instagram",
        "Instagram",
        "instagramgo",
        null,
        true,
        true,
      ],
      ["!grok:beeper.local", "Google Bot", "grok", "Grok Bot", "grokbot", null, true, false],
      ["!slack:beeper.local", "#general", "slack", "Slack", "slackgo", TEAM, false, false],
      ["!note:beeper.com", "Note to self", "beeper", null, null, null, true, false],
    ] as const
  ).map(([roomId, name, network, networkName, protocolId, networkId, isDirect, isMuted]) => [
    roomId,
    { roomId, name, network, networkName, protocolId, networkId, isDirect, isMuted },
  ]),
);

function inbox(options: { coveredSince?: number } = {}) {
  const entries: JournalEntry[] = [];
  const calls = { tools: [] as Array<{ name: string; args: Record<string, unknown> }>, names: 0 };
  const directory: Record<string, RoomInfo> = { ...ROOMS };
  let seq = 0;
  const state = { coveredSince: options.coveredSince ?? T0 - 3600_000 };
  const say = (roomId: string, sender: string, text: string, extra: Partial<JournalEntry> = {}) => {
    seq += 1;
    const entry: JournalEntry = {
      seq,
      rev: seq,
      roomId,
      eventId: `$e${seq}`,
      sender,
      isMe: sender === "@leon:beeper.com",
      type: "m.text",
      text,
      html: null,
      ts: T0 + seq * 1000,
      receivedAt: T0 + seq * 1000 + 300,
      edited: false,
      redacted: false,
      replyTo: null,
      attachments: 0,
      ...extra,
    };
    entries.push(entry);
    return entry;
  };
  const access: InboxAccess = {
    journal: {
      coveredSince: async () => state.coveredSince,
      since: async (roomId, sinceTs) =>
        entries.filter((entry) => entry.roomId === roomId && entry.ts >= sinceTs),
      recent: async (sinceTs) => entries.filter((entry) => entry.ts >= sinceTs),
    },
    rooms: async (roomIds) => roomIds.flatMap((id) => (directory[id] ? [directory[id]] : [])),
    connections: async () =>
      Object.values(directory).map((room) => ({
        protocolId: room.protocolId,
        networkId: room.networkId,
        name: room.networkName,
        rooms: 1,
      })),
    senderNames: async (userIds) => {
      calls.names += 1;
      return Object.fromEntries(
        userIds.filter((id) => id.startsWith("@named")).map((id) => [id, "Named Person"]),
      );
    },
    tool: async (name, args) => {
      calls.tools.push({ name, args });
      if (name === "get_conversation" && args.room_id === "!new:beeper.local") {
        directory["!new:beeper.local"] = {
          roomId: "!new:beeper.local",
          name: "new.person",
          network: "instagram",
          networkName: "Instagram",
          protocolId: "instagramgo",
          networkId: null,
          isDirect: true,
          isMuted: false,
        };
        return {};
      }
      if (name === "list_messages")
        return {
          messages: [
            {
              event_id: "$old1",
              timestamp: new Date(T0 - 7200_000).toISOString(),
              sender_name: "Sam",
              is_me: false,
              text: "from before the journal",
              type: "m.text",
            },
            {
              event_id: "$e1",
              timestamp: new Date(T0 + 1000).toISOString(),
              sender_name: "Sam (from history)",
              is_me: false,
              text: "also in the journal",
              type: "m.text",
            },
          ],
        };
      throw new Error(`unexpected tool ${name}`);
    },
  };
  return { access, say, calls, state, source: journalSource(access, quiet, () => T0 + 60_000) };
}

test("connections look like Beeper Desktop's account IDs, so platforms and exclusions still work", () => {
  assert.equal(accountOf({ protocolId: "slackgo", networkId: TEAM }), `slackgo.${TEAM}`);
  assert.equal(accountOf({ protocolId: "instagramgo", networkId: null }), "instagramgo.");
  assert.equal(accountOf({ protocolId: null, networkId: null }), "matrix.");
  assert.deepEqual(
    ["m.text", "m.notice", "m.image", "m.emote", "com.example.poll", ""].map(typeOf),
    ["TEXT", "NOTICE", "IMAGE", "TEXT", "COM.EXAMPLE.POLL", "TEXT"],
  );
});

test("recentMessages: every chat's new messages with their chat, minus excluded connections", async () => {
  const { source, say } = inbox();
  say("!wa:beeper.local", "@whatsapp_1:beeper.local", "hi there");
  say("!grp:beeper.local", "@named_2:beeper.local", "group hello", { type: "m.image" });
  say("!slack:beeper.local", "@slack_3:beeper.local", "already in Slack");
  say("!mute:beeper.local", "@ig_4:beeper.local", "psst");
  say("!wa:beeper.local", "@leon:beeper.com", "my own reply");
  say("!wa:beeper.local", "@whatsapp_1:beeper.local", "deleted", { redacted: true, text: "" });
  const accounts = await source.accounts();
  assert.deepEqual(accounts.map((account) => account.accountID).sort(), [
    "grokbot.",
    "instagramgo.",
    "matrix.",
    `slackgo.${TEAM}`,
    "whatsapp.",
  ]);
  const allowed = accounts
    .map((account) => account.accountID)
    .filter((id) => !id.startsWith(`slackgo.${TEAM}`));
  const page = await source.recentMessages(new Date(T0).toISOString(), allowed);
  assert.deepEqual(
    page.messages.map((m) => [m.chatID, m.senderName, m.isSender, m.type, m.text, m.accountID]),
    [
      ["!wa:beeper.local", "Sam", false, "TEXT", "hi there", "whatsapp."],
      ["!grp:beeper.local", "Named Person", false, "IMAGE", "group hello", "instagramgo."],
      ["!mute:beeper.local", "Muted pal", false, "TEXT", "psst", "instagramgo."],
      ["!wa:beeper.local", "Leon", true, "TEXT", "my own reply", "whatsapp."],
    ],
    "a DM's unnamed sender takes the chat's name; a deleted message and the Slack workspace are left out",
  );
  assert.deepEqual(page.chats["!mute:beeper.local"], {
    id: "!mute:beeper.local",
    accountID: "instagramgo.",
    title: "Muted pal",
    network: "Instagram",
    type: "single",
    isMuted: true,
  });
  assert.equal(page.chats["!grp:beeper.local"]?.type, "group");
  assert.equal(page.truncated, false);
});

test("a chat the directory doesn't have yet is looked up once, then copied like any other", async () => {
  const { source, say, calls } = inbox();
  say("!new:beeper.local", "@ig_9:beeper.local", "first message from someone new");
  say("!gone:beeper.local", "@ig_8:beeper.local", "a room that never resolves");
  const first = await source.recentMessages(new Date(T0).toISOString(), ["instagramgo."]);
  assert.deepEqual(
    first.messages.map((m) => [m.chatID, m.senderName]),
    [["!new:beeper.local", "new.person"]],
  );
  await source.recentMessages(new Date(T0).toISOString(), ["instagramgo."]);
  assert.deepEqual(
    calls.tools.map((call) => [call.name, call.args.room_id]),
    [
      ["get_conversation", "!new:beeper.local"],
      ["get_conversation", "!gone:beeper.local"],
    ],
    "the lookup that makes the inbox rebuild its directory isn't repeated on every poll",
  );
  assert.equal((await source.chat("!wa:beeper.local")).title, "Sam");
  await assert.rejects(source.chat("!gone:beeper.local"), /no chat/);
});

test("messagesSince: from the journal; one page of history only for a watch older than the journal", async () => {
  const { source, say, calls, state } = inbox({ coveredSince: T0 - 600_000 });
  say("!wa:beeper.local", "@whatsapp_1:beeper.local", "also in the journal");
  say("!wa:beeper.local", "@leon:beeper.com", "ok");
  // A watch that began after the journal did: no history at all.
  const recent = await source.messagesSince("!wa:beeper.local", new Date(T0).toISOString());
  assert.deepEqual(
    recent.map((m) => [m.id, m.isSender]),
    [
      ["$e1", false],
      ["$e2", true],
    ],
  );
  assert.equal(calls.tools.length, 0);
  // One that began three hours ago: the gap is read from history once, and never again.
  const old = new Date(T0 - 3 * 3600_000).toISOString();
  const merged = await source.messagesSince("!wa:beeper.local", old);
  assert.deepEqual(
    merged.map((m) => [m.id, m.senderName]),
    [
      ["$old1", "Sam"],
      ["$e1", "Sam"],
      ["$e2", "Leon"],
    ],
    "the journal's copy of a message wins over history's",
  );
  await source.messagesSince("!wa:beeper.local", old);
  await source.messagesSince("!wa:beeper.local", old);
  assert.deepEqual(
    calls.tools.map((call) => [call.name, call.args.limit]),
    [["list_messages", 20]],
  );
  // After the journal breaks off and starts again, the gap may be new, so it is read once more.
  state.coveredSince = T0 - 60_000;
  await source.messagesSince("!wa:beeper.local", old);
  assert.equal(calls.tools.length, 2);
});

test("the feed on top of it: posts by platform, wakes Hermes for people, not for muted chats or bots", async () => {
  const { source, say } = inbox();
  const posts: Array<{ channel: string; text: string }> = [];
  const slack: SlackPoster = {
    channel: async (name) => ({ id: `C-${name}`, name, isPrivate: false, isMember: true }),
    ensureChannel: async (name) => ({ id: `C-${name}`, name, isPrivate: false, isMember: true }),
    post: async (channel, text) => {
      posts.push({ channel, text });
      return { ts: String(posts.length) };
    },
  };
  let now = T0;
  const feed = new Feed({
    beeper: source,
    slack,
    log: quiet,
    hermesUserId: "U0HERMES001",
    stateFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bw-journal-")), "feed.json"),
    excludeAccounts: [`slackgo.${TEAM}`],
    now: () => now,
  });
  say("!wa:beeper.local", "@whatsapp_1:beeper.local", "are you free tomorrow?");
  say("!mute:beeper.local", "@ig_4:beeper.local", "psst");
  say("!grok:beeper.local", "@grokbot_5:beeper.local", "Done with the task.");
  say("!slack:beeper.local", "@slack_3:beeper.local", "already in Slack");
  say("!note:beeper.com", "@leon:beeper.com", "a note to myself");
  now = T0 + 10_000;
  await feed.tick();
  now = T0 + 60_000;
  await feed.tick();
  const by = Object.fromEntries(posts.map((post) => [post.channel, post.text]));
  assert.deepEqual(Object.keys(by).sort(), [
    "C-feed-beeper",
    "C-feed-grok",
    "C-feed-instagram",
    "C-feed-whatsapp",
  ]);
  assert.match(
    by["C-feed-whatsapp"] ?? "",
    /<@U0HERMES001>/,
    "a person in an unmuted chat wakes Hermes",
  );
  assert.match(by["C-feed-whatsapp"] ?? "", /WhatsApp · Sam \(DM\)/);
  assert.doesNotMatch(by["C-feed-instagram"] ?? "", /<@U0HERMES001>/, "a muted chat doesn't");
  assert.doesNotMatch(by["C-feed-grok"] ?? "", /<@U0HERMES001>/, "nor one of Leon's own agents");
  assert.doesNotMatch(by["C-feed-beeper"] ?? "", /<@U0HERMES001>/, "nor Leon's own message");
});

test("hosted settings: the env file's values, with no Beeper Desktop or HTTP server needed", () => {
  const env = parseEnv(
    "# comment\nSLACK_BOT_TOKEN='xoxb-test'\nHERMES_SLACK_USER_ID=`U0HERMES001`\n  FEED_SCREEN = \"off\" \nDRY_RUN=1\nbroken line\n",
  );
  assert.deepEqual(env, {
    SLACK_BOT_TOKEN: "xoxb-test",
    HERMES_SLACK_USER_ID: "U0HERMES001",
    FEED_SCREEN: "off",
    DRY_RUN: "1",
  });
  const config = loadCoreConfig({
    ...env,
    STATE_FILE: "/x/watches.json",
    FEED_STATE_FILE: "/x/feed.json",
  });
  assert.deepEqual(
    [
      config.dryRun,
      config.screen,
      config.stateFile,
      config.feedStateFile,
      config.feedChannelPrefix,
    ],
    [true, "off", "/x/watches.json", "/x/feed.json", "feed-"],
  );
  assert.throws(() => loadCoreConfig({}), /SLACK_BOT_TOKEN is required/);
});
