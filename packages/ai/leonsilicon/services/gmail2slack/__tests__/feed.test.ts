import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { Screener, Verdict } from "@-/ai.leonsilicon.services.feed-common";
import { FEED_LIMITS, GmailFeed, isInbound, type FeedConfig } from "#feed";
import { GmailError, type GmailApi, type HistoryPage } from "#gmail";
import type { GmailMessage } from "#mime";
import type { SlackPoster } from "@-/ai.leonsilicon.services.feed-common";
import { GIVE_UP_MS, Store, type Sql } from "#store";

const T0 = Date.parse("2026-11-19T18:00:00Z");
const HERMES = "UHERMES";

function sqlite(): Sql {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (query, ...params) => {
      const statement = db.prepare(query);
      return /^\s*(SELECT|WITH)/i.test(query)
        ? (statement.all(...params) as Record<string, string | number | null>[])
        : (statement.run(...params), []);
    },
  };
}

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");

const mail = (
  id: string,
  labelIds: string[],
  text = `body of ${id}`,
  from = "a@x.org",
): GmailMessage => ({
  id,
  threadId: `t-${id}`,
  labelIds,
  internalDate: String(T0),
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "From", value: from },
      { name: "Subject", value: `subject ${id}` },
    ],
    body: { size: text.length, data: b64(text) },
  },
});

class FakeGmail implements GmailApi {
  historyId = 100;
  messages = new Map<string, GmailMessage>();
  pending: string[] = [];
  expired = false;
  down: Error | null = null;
  calls: string[] = [];

  deliver(message: GmailMessage) {
    this.messages.set(message.id, message);
    this.pending.push(message.id);
    this.historyId++;
  }
  async profile() {
    if (this.down) throw this.down;
    return { emailAddress: "me@x.org", historyId: String(this.historyId) };
  }
  async history(start: string): Promise<HistoryPage> {
    this.calls.push(`history:${start}`);
    if (this.down) throw this.down;
    if (this.expired) throw new GmailError("history", 404, "notFound");
    const ids = this.pending;
    this.pending = [];
    return { historyId: String(this.historyId), messageIds: ids };
  }
  async list(query: string) {
    this.calls.push(`list:${query}`);
    return { ids: [...this.messages.keys()].reverse() };
  }
  async message(id: string) {
    const found = this.messages.get(id);
    if (!found) throw new GmailError("message", 404, "notFound");
    return found;
  }
  async attachment() {
    return "";
  }
  async labels() {
    return [{ id: "Label_1", name: "Receipts", type: "user" }];
  }
}

class FakeSlack implements SlackPoster {
  posts: Array<{ channel: string; text: string; thread?: string }> = [];
  failNext = 0;
  created: string[] = [];
  #ts = 0;

  async post(channel: string, text: string, thread?: string) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("slack down");
    }
    this.posts.push({ channel, text, ...(thread ? { thread } : {}) });
    return { ts: `${++this.#ts}.000` };
  }
  async ensureChannel(nameOrId: string, options: { create: boolean }) {
    if (/^[CG][A-Z0-9]{6,}$/.test(nameOrId)) return { id: nameOrId, created: false, problems: [] };
    if (options.create) this.created.push(nameOrId);
    return { id: `C_${nameOrId.toUpperCase()}`, created: options.create, problems: [] };
  }
}

const safe = (wake: boolean): Verdict => ({ route: "safe", reason: "ok", by: "model", wake });

function setup(screen: (text: string) => Promise<Verdict> = async () => safe(true)) {
  let now = T0;
  const store = new Store(sqlite());
  const gmail = new FakeGmail();
  const slack = new FakeSlack();
  const screened: string[] = [];
  const screener: Screener = {
    async screen(input) {
      screened.push(input.messages[0].text);
      return screen(input.messages[0].text);
    },
  };
  const config: FeedConfig = {
    channel: "feed-gmail",
    flaggedChannel: "CFLAGGED1",
    spamChannel: "CSPAM0001",
    hermesUserId: HERMES,
    invite: ["ULEON"],
    wake: "screened",
    maxBody: 40_000,
  };
  const feed = new GmailFeed({
    config,
    store,
    gmail,
    slack,
    screener,
    log: () => {},
    now: () => now,
  });
  return {
    feed,
    store,
    gmail,
    slack,
    screened,
    advance: (ms: number) => (now += ms),
  };
}

test("only inbound mail counts", () => {
  assert.equal(isInbound(["INBOX", "UNREAD"]), true);
  assert.equal(isInbound(["CATEGORY_PROMOTIONS"]), true);
  assert.equal(isInbound(["SPAM"]), true);
  assert.equal(isInbound(["SENT"]), false);
  assert.equal(isInbound(["SENT", "INBOX"]), true);
  assert.equal(isInbound(["DRAFT"]), false);
});

test("the first poll only records where to start; later mail is posted once, in order", async () => {
  const { feed, gmail, slack, store } = setup();
  gmail.deliver(mail("old", ["INBOX"]));
  assert.deepEqual(await feed.poll(), { queued: 0, started: true });
  gmail.pending = [];

  gmail.deliver(mail("m1", ["INBOX", "UNREAD"]));
  gmail.deliver(mail("m2", ["CATEGORY_UPDATES", "Label_1"]));
  gmail.deliver(mail("sent", ["SENT"]));
  assert.deepEqual(await feed.poll(), { queued: 3 });
  assert.deepEqual(await feed.process(), { posted: 2, skipped: 1, failed: 0 });

  assert.equal(slack.posts.length, 2);
  assert.ok(slack.posts.every((p) => p.channel === "C_FEED-GMAIL"));
  assert.match(slack.posts[0].text, /^<@UHERMES> \*New email\* from a@x.org\n\*subject m1\*/);
  assert.match(slack.posts[1].text, /Skipped the inbox, Updates, Receipts/);
  assert.deepEqual(slack.created, ["feed-gmail"]);

  // The same IDs again (history overlap, a backfill) are never reposted.
  gmail.pending = ["m1", "m2"];
  assert.deepEqual(await feed.poll(), { queued: 0 });
  assert.equal(store.stats(T0).pending, 0);
});

test("routes: Gmail's spam skips the screener; unsafe and spam are held; quiet ones don't wake", async () => {
  const { feed, gmail, slack, screened } = setup(async (text) =>
    text.includes("phish")
      ? { route: "unsafe", reason: "phishing_or_malicious_link", by: "model", wake: false }
      : text.includes("promo")
        ? { route: "spam", reason: "promotion", by: "model", wake: false }
        : safe(text.includes("urgent")),
  );
  await feed.poll();
  gmail.deliver(mail("s", ["SPAM"], "cheap pills"));
  gmail.deliver(mail("p", ["INBOX"], "phish here"));
  gmail.deliver(mail("r", ["INBOX"], "big promo"));
  gmail.deliver(mail("q", ["INBOX"], "your receipt"));
  gmail.deliver(mail("u", ["INBOX"], "urgent: reply by 5"));
  gmail.deliver(mail("me", ["INBOX"], "urgent note to self", "Leon <me@x.org>"));
  await feed.poll();
  await feed.process();

  assert.equal(screened.length, 5, "Gmail's spam isn't screened");
  const by = (id: string) => slack.posts.find((p) => p.text.includes(`subject ${id}`));
  assert.equal(by("s")?.channel, "CSPAM0001");
  assert.match(by("s")?.text ?? "", /Gmail filed it as spam/);
  assert.equal(by("p")?.channel, "CFLAGGED1");
  assert.equal(by("r")?.channel, "CSPAM0001");
  assert.equal(by("q")?.channel, "C_FEED-GMAIL");
  assert.match(by("q")?.text ?? "", /Hermes not woken/);
  assert.match(by("u")?.text ?? "", /^<@UHERMES>/);
  assert.doesNotMatch(by("me")?.text ?? "", /<@/, "Leon's own mail never wakes Hermes");
  assert.equal(slack.posts.filter((p) => p.text.includes("<@")).length, 1);
});

test("a failed post is retried without screening again, and given up after a day", async () => {
  let calls = 0;
  const { feed, gmail, slack, store, advance } = setup(async () => {
    calls++;
    return safe(false);
  });
  await feed.poll();
  gmail.deliver(mail("m1", ["INBOX"]));
  await feed.poll();
  slack.failNext = 1;
  assert.deepEqual(await feed.process(), { posted: 0, skipped: 0, failed: 1 });
  assert.deepEqual(await feed.process(), { posted: 0, skipped: 0, failed: 0 }, "backs off");
  advance(60_000);
  assert.deepEqual(await feed.process(), { posted: 1, skipped: 0, failed: 0 });
  assert.equal(calls, 1);
  assert.equal(slack.posts.length, 1);

  gmail.deliver(mail("m2", ["INBOX"]));
  await feed.poll();
  slack.failNext = 1_000;
  advance(GIVE_UP_MS + 1);
  await feed.process();
  assert.equal(store.stats(T0 + GIVE_UP_MS + 60_000).deadLastDay, 1);
});

test("a long email's thread replies resume where they stopped", async () => {
  const { feed, gmail, slack, advance } = setup(async () => safe(false));
  await feed.poll();
  const body = Array.from({ length: 1500 }, (_, i) => `line ${i} ${"z".repeat(20)}`).join("\n");
  gmail.deliver(mail("long", ["INBOX"], body));
  await feed.poll();
  slack.failNext = 0;
  const original = slack.post.bind(slack);
  let n = 0;
  slack.post = async (channel, text, thread) => {
    if (++n === 3) throw new Error("slack hiccup");
    return original(channel, text, thread);
  };
  await feed.process();
  advance(60_000);
  await feed.process();
  const top = slack.posts.filter((p) => !p.thread);
  const replies = slack.posts.filter((p) => p.thread);
  assert.equal(top.length, 1, "the top post isn't repeated");
  assert.ok(replies.length >= 2);
  assert.equal(new Set(replies.map((p) => p.text)).size, replies.length, "no reply posted twice");
});

test("the screener being down holds mail for a while, then in #feed-flagged", async () => {
  const { feed, gmail, slack, advance } = setup(async () => {
    throw new Error("openai 503");
  });
  await feed.poll();
  gmail.deliver(mail("m1", ["INBOX"]));
  await feed.poll();
  await feed.process();
  assert.equal(slack.posts.length, 0);
  advance(FEED_LIMITS.screenGiveUpMs + 1);
  await feed.process();
  assert.equal(slack.posts.length, 1);
  assert.equal(slack.posts[0].channel, "CFLAGGED1");
  assert.match(slack.posts[0].text, /couldn't check it/);
});

test("expired history catches up by date; a long Gmail outage is announced once, then its end", async () => {
  const { feed, gmail, slack, advance } = setup();
  await feed.poll();
  advance(60_000);
  await feed.poll();
  gmail.expired = true;
  gmail.messages.set("late", mail("late", ["INBOX"]));
  assert.deepEqual(await feed.poll(), { queued: 1 });
  assert.match(gmail.calls.at(-1) ?? "", /^list:after:\d+$/);
  gmail.expired = false;

  gmail.down = new GmailError("token", 400, "invalid_grant");
  await assert.rejects(feed.poll());
  advance(FEED_LIMITS.outageNoticeMs + 1);
  await assert.rejects(feed.poll());
  await assert.rejects(feed.poll());
  const notices = () => slack.posts.filter((p) => /Gmail2Slack can/.test(p.text));
  assert.equal(notices().length, 1);
  assert.match(notices()[0].text, /invalid_grant/);
  assert.equal(feed.status().ok, false);

  gmail.down = null;
  await feed.poll();
  assert.equal(notices().length, 2);
  assert.match(notices()[1].text, /can read Gmail again/);
});

test("a backfill is posted oldest first and never wakes Hermes", async () => {
  const { feed, gmail, slack } = setup(async () => safe(true));
  await feed.poll();
  gmail.messages.set("a", mail("a", ["INBOX"]));
  gmail.messages.set("b", mail("b", ["INBOX"]));
  assert.deepEqual(await feed.backfill(T0 - 3600_000), { queued: 2 });
  await feed.process();
  assert.deepEqual(
    slack.posts.map((p) => /subject (\w)/.exec(p.text)?.[1]),
    ["a", "b"],
  );
  assert.ok(slack.posts.every((p) => !p.text.includes("<@") && /copied late/.test(p.text)));
});
