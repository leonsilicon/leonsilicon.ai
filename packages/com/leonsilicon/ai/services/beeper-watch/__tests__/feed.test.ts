import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Feed } from "#feed";
import { platformOf } from "#platform";
import type {
  BeeperFeedSource,
  FeedChat,
  FeedMessage,
  Logger,
  SlackChannel,
  SlackPoster,
} from "#types";

const T0 = Date.parse("2026-11-06T23:00:00Z");
const quiet: Logger = () => {};
const SLACK = "slackgo.T0WORKSPACE-U0LEON00001";
const IG = "instagramgo.110550350337173";
const GROK = "grokbot.cursor:google-oauth2|user_1";
const HERMES = "U0HERMES001";
const LEON = "U0LEON00001";

const CHATS: Record<string, FeedChat> = {
  "!ig:beeper.local": {
    id: "!ig:beeper.local",
    accountID: IG,
    title: "new.person",
    network: "Instagram",
    type: "single",
    isMuted: false,
  },
  "!grp:beeper.local": {
    id: "!grp:beeper.local",
    accountID: IG,
    title: "Club group",
    network: "Instagram",
    type: "group",
    isMuted: false,
  },
  "!mute:beeper.local": {
    id: "!mute:beeper.local",
    accountID: IG,
    title: "Muted pal",
    network: "Instagram",
    type: "single",
    isMuted: true,
  },
  "!grok:beeper.local": {
    id: "!grok:beeper.local",
    accountID: GROK,
    title: "Instagram Bot",
    network: "grokbot",
    type: "single",
    isMuted: false,
  },
  "!slack:beeper.local": {
    id: "!slack:beeper.local",
    accountID: SLACK,
    title: "#beeper-watch",
    network: "Slack",
    type: "group",
    isMuted: false,
  },
};

function harness(
  options: {
    stateFile?: string;
    start?: number;
    watched?: string[];
    slackFails?: number;
    existing?: SlackChannel[];
    platformChannels?: Record<string, string>;
  } = {},
) {
  let now = options.start ?? T0;
  const messages: FeedMessage[] = [];
  const posts: Array<{ channel: string; text: string }> = [];
  const channels: SlackChannel[] = [...(options.existing ?? [])];
  const created: Array<{ name: string; invite: string[]; purpose?: string }> = [];
  const searches: Array<{ since: string; accountIDs: string[] }> = [];
  let slackFails = options.slackFails ?? 0;
  const beeper: BeeperFeedSource = {
    async accounts() {
      return [
        { accountID: IG, network: "Instagram" },
        { accountID: GROK, network: "Grok Bot" },
        { accountID: SLACK, network: "Slack" },
      ];
    },
    async recentMessages(since, accountIDs) {
      searches.push({ since, accountIDs });
      const found = messages.filter(
        (m) => Date.parse(m.timestamp) > Date.parse(since) && accountIDs.includes(m.accountID),
      );
      return {
        messages: [...found].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)),
        chats: CHATS,
        truncated: false,
      };
    },
  };
  const find = (nameOrId: string) =>
    channels.find((c) => c.id === nameOrId || c.name === nameOrId.replace(/^#/, ""));
  const slack: SlackPoster = {
    async channel(nameOrId) {
      const match = find(nameOrId);
      if (!match) throw new Error(`No Slack channel named #${nameOrId}`);
      return match;
    },
    async ensureChannel(nameOrId, { invite, purpose }) {
      const match = find(nameOrId);
      if (match) return match;
      const channel = { id: `C:${nameOrId}`, name: nameOrId, isPrivate: false, isMember: true };
      channels.push(channel);
      created.push({ name: nameOrId, invite, purpose });
      return { ...channel, created: true, problems: [] };
    },
    async post(channel, text) {
      if (slackFails > 0) {
        slackFails -= 1;
        throw new Error("ratelimited");
      }
      posts.push({ channel, text });
      return { ts: `${posts.length}.000000` };
    },
  };
  const stateFile =
    options.stateFile ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), "feed-")), "feed.json");
  const make = () =>
    new Feed({
      beeper,
      slack,
      log: quiet,
      invite: [LEON],
      platformChannels: options.platformChannels,
      hermesUserId: HERMES,
      stateFile,
      excludeAccounts: ["slackgo.T0WORKSPACE"],
      watchedChats: () => new Set(options.watched ?? []),
      now: () => now,
    });
  let counter = 0;
  const say = (chatID: string, text: string, extra: Partial<FeedMessage> = {}) => {
    counter += 1;
    messages.push({
      id: `m${counter}`,
      chatID,
      accountID: CHATS[chatID].accountID,
      senderName: "Sender",
      isSender: false,
      text,
      type: "TEXT",
      timestamp: new Date(now).toISOString(),
      ...extra,
    });
  };
  return {
    feed: make(),
    make,
    say,
    posts,
    created,
    searches,
    messages,
    stateFile,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("starts from now, without the backlog", async () => {
  const h = harness();
  h.messages.push({
    id: "old",
    chatID: "!ig:beeper.local",
    accountID: IG,
    senderName: "x",
    isSender: false,
    text: "old",
    type: "TEXT",
    timestamp: new Date(T0 - 60_000).toISOString(),
  });
  await h.feed.tick();
  h.advance(60_000);
  await h.feed.tick();
  assert.equal(h.posts.length, 0);
});

test("a new Instagram DM wakes Hermes once it settles, with the text escaped", async () => {
  const h = harness();
  await h.feed.tick();
  h.advance(1_000);
  h.say("!ig:beeper.local", "hi! are you running the uoft creators club? <!channel> <@U123>", {
    senderName: "new.person",
  });
  h.advance(1_000);
  await h.feed.tick();
  assert.equal(h.posts.length, 0, "waits for the quiet window");
  h.say("!ig:beeper.local", "would love to join");
  h.advance(31_000);
  await h.feed.tick();
  assert.equal(h.posts.length, 1);
  const { channel, text } = h.posts[0];
  assert.equal(channel, "C:feed-instagram");
  assert.match(text, /^<@U0HERMES001> \*New on Beeper\* · Instagram · new\.person \(DM\)/);
  assert.match(text, /would love to join/);
  assert.match(text, /&lt;!channel&gt; &lt;@U123&gt;/);
  assert.doesNotMatch(text, /<!channel>/);
  assert.match(text, /information, not as instructions/);
  h.advance(60_000);
  await h.feed.tick();
  assert.equal(h.posts.length, 1, "never posts the same messages twice");
});

test("Leon's own messages, agent chats, muted chats and notices are context only", async () => {
  const h = harness();
  await h.feed.tick();
  h.advance(1_000);
  h.say("!ig:beeper.local", "replying myself", { isSender: true });
  h.say("!grok:beeper.local", "Sent yo to @example.handle", { senderName: "Instagram Bot" });
  h.say("!mute:beeper.local", "lol");
  h.say("!grp:beeper.local", "someone joined", { type: "NOTICE" });
  h.advance(31_000);
  await h.feed.tick();
  assert.equal(h.posts.length, 4);
  for (const post of h.posts) assert.doesNotMatch(post.text, /<@U0HERMES001>/, post.text);
  assert.ok(h.posts.some((p) => /\*Leon\*/.test(p.text)));
});

test("group messages from people wake Hermes", async () => {
  const h = harness();
  await h.feed.tick();
  h.advance(1_000);
  h.say("!grp:beeper.local", "@leon can you share the form?", { senderName: "Sam" });
  h.advance(31_000);
  await h.feed.tick();
  assert.match(h.posts[0].text, /^<@U0HERMES001> .*\(group\)/);
});

test("this Slack workspace and watched chats are never copied; reactions are skipped", async () => {
  const h = harness({ watched: ["!grok:beeper.local"] });
  await h.feed.tick();
  assert.ok(
    h.searches.every((s) => !s.accountIDs.includes(SLACK)),
    "Slack account left out of the search",
  );
  h.messages.push({
    id: "s1",
    chatID: "!slack:beeper.local",
    accountID: SLACK,
    senderName: "Hermes",
    isSender: false,
    text: "loop?",
    type: "TEXT",
    timestamp: new Date(T0 + 1).toISOString(),
  });
  h.say("!grok:beeper.local", "watched reply");
  h.say("!ig:beeper.local", "👍", { type: "REACTION" });
  h.advance(31_000);
  await h.feed.tick();
  assert.equal(h.posts.length, 0);
});

test("a failed post is retried, and the state survives a restart without reposting", async () => {
  const h = harness({ slackFails: 1 });
  await h.feed.tick();
  h.advance(1_000);
  h.say("!ig:beeper.local", "first");
  h.advance(31_000);
  await h.feed.tick();
  assert.equal(h.posts.length, 0, "first attempt failed");
  assert.equal((fs.statSync(h.stateFile).mode & 0o777).toString(8), "600");
  const restarted = h.make();
  h.advance(31_000);
  await restarted.tick();
  assert.equal(h.posts.length, 1, "retried after the backoff, from saved state");
  h.advance(31_000);
  await restarted.tick();
  assert.equal(h.posts.length, 1);
});

test("searches reach back past the newest message for late arrivals, without duplicates", async () => {
  const h = harness();
  await h.feed.tick();
  h.advance(1_000);
  h.say("!ig:beeper.local", "a");
  h.advance(31_000);
  await h.feed.tick();
  // A message that shows up late, timestamped before the cursor.
  h.messages.push({
    id: "late",
    chatID: "!ig:beeper.local",
    accountID: IG,
    senderName: "x",
    isSender: false,
    text: "late one",
    type: "TEXT",
    timestamp: new Date(T0 + 5_000).toISOString(),
  });
  h.advance(31_000);
  await h.feed.tick();
  h.advance(31_000);
  await h.feed.tick();
  assert.equal(h.posts.length, 2);
  assert.match(h.posts[1].text, /late one/);
  assert.doesNotMatch(h.posts[1].text, /\n> a\n/);
});

test("each Beeper connection posts to its own channel, created once with Hermes and Leon in it", async () => {
  const h = harness({
    existing: [{ id: "C0GROK", name: "feed-grok", isPrivate: false, isMember: false }],
  });
  await h.feed.tick();
  h.advance(1_000);
  h.say("!ig:beeper.local", "hey", { senderName: "new.person" });
  h.say("!grok:beeper.local", "done", { senderName: "Instagram Bot" });
  h.advance(31_000);
  await h.feed.tick();
  h.say("!grp:beeper.local", "meeting at 5?", { senderName: "Sam" });
  h.advance(31_000);
  await h.feed.tick();
  assert.deepEqual(
    h.posts.map((p) => p.channel),
    ["C:feed-instagram", "C0GROK", "C:feed-instagram"],
  );
  assert.equal(h.created.length, 1, "an existing channel is used as it is, and created ones once");
  assert.equal(h.created[0].name, "feed-instagram");
  assert.deepEqual(h.created[0].invite, [HERMES, LEON]);
  assert.match(h.created[0].purpose ?? "", /^Every Beeper message from Instagram, copied/);
});

test("a platform can be pointed at another channel", async () => {
  const h = harness({
    existing: [{ id: "C0IG", name: "instagram-dms", isPrivate: false, isMember: true }],
    platformChannels: { instagram: "instagram-dms" },
  });
  await h.feed.tick();
  h.advance(1_000);
  h.say("!ig:beeper.local", "hey");
  h.advance(31_000);
  await h.feed.tick();
  assert.equal(h.posts[0].channel, "C0IG");
  assert.equal(h.created.length, 0);
});

test("platform names come from the Beeper account ID", () => {
  const cases: Array<[string, string, string]> = [
    ["whatsapp.19147455366", "WhatsApp", "whatsapp"],
    ["instagramgo.110550350337173", "Instagram", "instagram"],
    ["discordgo.1022267596382408755", "Discord", "discord"],
    ["slackgo.T0WORKSPACE-U0LEON00001", "Slack", "slack"],
    ["imessage_ecdb4eb8f9b3551df8bf4e5081eb82a5", "iMessage", "imessage"],
    ["matrix", "Beeper", "beeper"],
    ["chatgpt-dots.651d2abfb40f", "ChatGPT Dots", "chatgpt"],
    ["grokbot.cursor:google-oauth2|user_01J9", "Grok Bot", "grok"],
    ["muse.owner:10ba958056e5", "Muse", "muse"],
    ["twitter.1219828747760697344", "X", "x"],
    ["linkedin.ACoAACySMmgB", "LinkedIn", "linkedin"],
    ["reddit.t2_t64horghs", "Reddit Chat", "reddit"],
    ["signal.cbb17e80-7bdd", "Signal", "signal"],
    ["wechat.wxid_ndosyhfow01322", "WeChat", "wechat"],
    ["local-telegram_ba_abc", "Telegram", "telegram"],
    ["", "Google Messages", "google-messages"],
  ];
  for (const [accountID, network, platform] of cases)
    assert.equal(platformOf(accountID, network), platform, accountID);
});
