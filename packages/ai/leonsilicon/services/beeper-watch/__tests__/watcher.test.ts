import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WatchStore } from "#store";
import type { BeeperSource, ChatMessage, Logger, SlackChannel, SlackPoster } from "#types";
import { LIMITS, UserError, Watcher } from "#watcher";

const CHAT = "!sam:beeper.local";
const T0 = Date.parse("2026-11-06T18:50:00Z");
const quiet: Logger = () => {};

function harness(options: { start?: number; channels?: SlackChannel[] } = {}) {
  let now = options.start ?? T0;
  const messages: ChatMessage[] = [];
  const posts: Array<{ channel: string; text: string; threadTs?: string }> = [];
  let beeperDown = false;
  let slackFails = 0;
  const channels = options.channels ?? [
    { id: "C0TASKS0001", name: "uoft-creators", isPrivate: false, isMember: true },
    { id: "C0TASKS0002", name: "home", isPrivate: false, isMember: true },
    { id: "G0SECRET", name: "secret", isPrivate: true, isMember: false },
  ];
  const beeper: BeeperSource = {
    async chat(chatID) {
      if (chatID !== CHAT) throw new Error("404");
      return { id: CHAT, title: "Sam", network: "Instagram", type: "single" };
    },
    async messagesSince(chatID, sinceIso) {
      if (beeperDown) throw new Error("connect ECONNREFUSED");
      return messages
        .filter((m) => chatID === CHAT && Date.parse(m.timestamp) > Date.parse(sinceIso))
        .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    },
  };
  const slack: SlackPoster = {
    async channel(nameOrId) {
      const wanted = nameOrId.replace(/^#/, "");
      const match = channels.find((c) => c.id === wanted || c.name === wanted);
      if (!match) throw new Error(`No Slack channel named #${wanted}`);
      return match;
    },
    async post(channel, text, threadTs) {
      if (slackFails > 0) {
        slackFails -= 1;
        throw new Error("ratelimited");
      }
      posts.push({ channel, text, threadTs });
      return { ts: `${posts.length}.000000` };
    },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "beeper-watch-"));
  const store = new WatchStore(path.join(dir, "watches.json"), quiet);
  const watcher = new Watcher({
    store,
    beeper,
    slack,
    hermesUserId: "U0HERMES001",
    defaultChannel: "home",
    log: quiet,
    now: () => now,
  });
  let n = 0;
  return {
    watcher,
    store,
    posts,
    dir,
    advance(ms: number) {
      now += ms;
    },
    at: () => now,
    say(
      text: string,
      options: { fromLeon?: boolean; at?: number; type?: string; sender?: string } = {},
    ) {
      n += 1;
      messages.push({
        id: `m${n}`,
        senderName: options.fromLeon ? "@leonsilicon:beeper.com" : (options.sender ?? "Sam"),
        isSender: options.fromLeon === true,
        text,
        type: options.type ?? "TEXT",
        timestamp: new Date(options.at ?? now).toISOString(),
      });
    },
    edit(id: string, text: string) {
      const message = messages.find((m) => m.id === id);
      if (message) message.text = text;
    },
    setBeeperDown(down: boolean) {
      beeperDown = down;
    },
    failSlack(times: number) {
      slackFails = times;
    },
  };
}

const add = (h: ReturnType<typeof harness>, extra: Record<string, unknown> = {}) =>
  h.watcher.add({
    chat_id: CHAT,
    waiting_for: "Sam's U of T email and utorid",
    slack_channel: "#uoft-creators",
    slack_thread_ts: "1793918187.574419",
    ...extra,
  });

test("a reply wakes Hermes once, in the task's thread, after the quiet window", async () => {
  const h = harness();
  const { watch } = await add(h);
  assert.match(watch.id, /^w_[0-9a-f]{8}$/);
  assert.equal(watch.slack_channel, "#uoft-creators (C0TASKS0001)");

  h.advance(5_000);
  h.say("hey!");
  h.advance(5_000);
  h.say("jdoe12 / sam@example.edu");
  await h.watcher.tick();
  assert.equal(h.posts.length, 0, "waits for follow-up messages");

  h.advance(30_000);
  await h.watcher.tick();
  assert.equal(h.posts.length, 1);
  const [post] = h.posts;
  assert.equal(post.channel, "C0TASKS0001");
  assert.equal(post.threadTs, "1793918187.574419");
  assert.match(post.text, /^<@U0HERMES001> \*Beeper reply\* from Sam \(Instagram\)/);
  assert.match(post.text, /> hey!/);
  assert.match(post.text, /> jdoe12 \/ sam@example\.edu/);
  assert.match(post.text, /beeper_watch_remove with `w_/);

  h.edit("m2", "jdoe12 / sam@example.edu (edited)");
  h.advance(60_000);
  await h.watcher.tick();
  assert.equal(h.posts.length, 1, "edits and re-reads never ping twice");
  assert.equal(h.watcher.list()[0].replies_delivered, 2);
});

test("Leon's own messages are context, never a reason to wake Hermes", async () => {
  const h = harness();
  await add(h);
  h.advance(1_000);
  h.say("what's your uoft email and utorid?", { fromLeon: true });
  h.advance(120_000);
  await h.watcher.tick();
  assert.equal(h.posts.length, 0);

  h.say("sam@example.edu");
  h.advance(31_000);
  await h.watcher.tick();
  assert.equal(h.posts.length, 1);
  assert.match(h.posts[0].text, /\*Leon\*, .*\n> what's your uoft email and utorid\?/);
  assert.match(h.posts[0].text, /\*Sam\*, .*\n> sam@example\.edu/);
});

test("reactions and notices don't wake Hermes", async () => {
  const h = harness();
  await add(h);
  h.advance(1_000);
  h.say("👍", { type: "REACTION" });
  h.advance(200_000);
  await h.watcher.tick();
  assert.equal(h.posts.length, 0);
});

test("since backfills a reply that arrived before the watch existed", async () => {
  const h = harness({ start: T0 + 20 * 60_000 });
  h.say("its jdoe12", { at: T0 + 15_000 });
  h.say("older, before the question", { at: T0 - 60_000 });
  const result = await add(h, { since: new Date(T0).toISOString() });
  assert.equal(result.alreadyReceived, 1);
  await h.watcher.tick();
  assert.equal(
    h.posts.length,
    1,
    "an old reply is already quiet, so it is posted on the first poll",
  );
  assert.match(h.posts[0].text, /its jdoe12/);
  assert.doesNotMatch(h.posts[0].text, /before the question/);
});

test("messages from before the watch are ignored by default", async () => {
  const h = harness();
  h.say("an old message", { at: T0 - 1000 });
  await add(h);
  h.advance(200_000);
  await h.watcher.tick();
  assert.equal(h.posts.length, 0);
});

test("a long burst is posted after the batch cap even if it never goes quiet", async () => {
  const h = harness();
  await add(h);
  for (let i = 0; i < 13; i++) {
    h.advance(10_000);
    h.say(`part ${i}`);
    await h.watcher.tick();
  }
  assert.equal(h.posts.length, 1);
});

test("the from filter limits which group members wake Hermes", async () => {
  const h = harness();
  await add(h, { from: "sam" });
  h.advance(1000);
  h.say("I'm Charles", { sender: "Charles" });
  h.advance(60_000);
  await h.watcher.tick();
  assert.equal(h.posts.length, 0);
  h.say("sam here: jdoe12", { sender: "Sam Lee" });
  h.advance(31_000);
  await h.watcher.tick();
  assert.equal(h.posts.length, 1);
  assert.match(h.posts[0].text, /I'm Charles/, "other members still show as context");
});

test("pings are limited per hour", async () => {
  const h = harness();
  await add(h);
  for (let i = 0; i < LIMITS.pingsPerHour + 2; i++) {
    h.advance(1000);
    h.say(`message ${i}`);
    h.advance(31_000);
    await h.watcher.tick();
  }
  assert.equal(h.posts.length, LIMITS.pingsPerHour);
  h.advance(3_600_000);
  await h.watcher.tick();
  assert.equal(
    h.posts.length,
    LIMITS.pingsPerHour + 1,
    "held messages go out once the hour passes",
  );
  assert.match(h.posts.at(-1)?.text ?? "", /message 6[\s\S]*message 7/);
});

test("a failed Slack post is retried with backoff and nothing is lost", async () => {
  const h = harness();
  await add(h);
  h.advance(1000);
  h.say("jdoe12");
  h.failSlack(2);
  h.advance(31_000);
  await h.watcher.tick();
  h.advance(10_000);
  await h.watcher.tick();
  assert.equal(h.posts.length, 0, "first retry waits 30s");
  h.advance(25_000);
  await h.watcher.tick();
  assert.equal(h.posts.length, 0, "second failure");
  h.advance(61_000);
  await h.watcher.tick();
  assert.equal(h.posts.length, 1);
  assert.match(h.posts[0].text, /jdoe12/);
});

test("Beeper being down skips a poll without losing messages", async () => {
  const h = harness();
  await add(h);
  h.advance(1000);
  h.say("jdoe12");
  h.setBeeperDown(true);
  h.advance(60_000);
  await h.watcher.tick();
  assert.equal(h.watcher.health().beeper, false);
  h.setBeeperDown(false);
  await h.watcher.tick();
  assert.equal(h.posts.length, 1);
  assert.equal(h.watcher.health().beeper, true);
});

test("an unanswered watch expires with a notice that doesn't mention Hermes", async () => {
  const h = harness();
  await add(h, { expires_in_hours: 1 });
  h.advance(3_600_000);
  await h.watcher.tick();
  assert.equal(h.watcher.list().length, 0);
  assert.equal(h.posts.length, 1);
  assert.doesNotMatch(h.posts[0].text, /<@/);
  assert.match(h.posts[0].text, /no reply from Sam/);
});

test("an answered watch expires quietly", async () => {
  const h = harness();
  await add(h, { expires_in_hours: 1 });
  h.advance(1000);
  h.say("jdoe12");
  h.advance(31_000);
  await h.watcher.tick();
  h.advance(3_600_000);
  await h.watcher.tick();
  assert.equal(h.watcher.list().length, 0);
  assert.equal(h.posts.length, 1);
});

test("adding the same chat and thread again updates the watch", async () => {
  const h = harness();
  const first = await add(h);
  const second = await add(h, { waiting_for: "just the utorid", expires_in_hours: 100 });
  assert.equal(second.updated, true);
  assert.equal(second.watch.id, first.watch.id);
  assert.equal(h.watcher.list().length, 1);
  assert.equal(h.watcher.list()[0].waiting_for, "just the utorid");
});

test("watches survive a restart", async () => {
  const h = harness();
  const { watch } = await add(h);
  const reloaded = new WatchStore(path.join(h.dir, "watches.json"), quiet);
  assert.equal(reloaded.get(watch.id)?.chatTitle, "Sam");
  assert.equal(fs.statSync(path.join(h.dir, "watches.json")).mode & 0o777, 0o600);
});

test("bad input is explained to the caller", async () => {
  const h = harness();
  const rejects = (extra: Record<string, unknown>, pattern: RegExp) =>
    assert.rejects(
      add(h, extra),
      (error: Error) => error instanceof UserError && pattern.test(error.message),
    );
  await rejects({ chat_id: "!nope:beeper.local" }, /Beeper has no chat .*search_chats/);
  await rejects({ slack_channel: "D0123456" }, /can't post in DMs/);
  await rejects({ slack_channel: "#secret" }, /invite @Beeper Watch/);
  await rejects({ slack_channel: "#missing" }, /No Slack channel named #missing/);
  await rejects({ slack_thread_ts: "yesterday" }, /slack_thread_ts/);
  await rejects({ since: "2026-10-01T00:00:00Z" }, /at most 7 days/);
  await rejects({ since: "tomorrow" }, /ISO 8601/);
  await rejects({ expires_in_hours: 0 }, /expires_in_hours/);
  await rejects({ waiting_for: "x".repeat(501) }, /at most 500/);
  await assert.rejects(h.watcher.add({ chat_id: CHAT }), /waiting_for is required/);
  assert.throws(() => h.watcher.remove("w_nothere"), /No open watch w_nothere/);
});

test("without a channel, pings go to the default channel at the top level", async () => {
  const h = harness();
  const { watch } = await h.watcher.add({ chat_id: CHAT, waiting_for: "anything" });
  assert.equal(watch.slack_channel, "#home (C0TASKS0002)");
  assert.equal(watch.slack_thread_ts, undefined);
});
