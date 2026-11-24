import assert from "node:assert/strict";
import test from "node:test";
import type { DecisionsClient } from "@-/ai.leonsilicon.services.feed-common";
import type { LinearIssue, SlackCall, SlackParams } from "@-/ai.leonsilicon.services.slack22linear";
import {
  Autotrigger,
  feedEvent,
  feedMessage,
  type FeedMessage,
} from "@-/ai.leonsilicon.services.autotrigger";

const SOURCE = "C01234567";
const DESTINATION = "C34567890";
const TS = "1795521000.000002";
const ROOT_TS = "1795521000.000001";
const LINK = "https://example.slack.com/archives/C01234567/p1795521000000002";
const HERMES = "U01234567";

const message: FeedMessage = {
  channel: SOURCE,
  name: "feed-gmail",
  ts: TS,
  threadTs: ROOT_TS,
  text: "Yes, we approved the application and it is live.",
  files: [],
};

const issue: LinearIssue = {
  id: "issue-one",
  identifier: "LEON-1",
  title: "Release the mobile app",
  description:
    'Waiting on store review.\n\n### AutoLinear workflow\n\n```json\n{"who":"App Review"}\n```',
  number: 1,
  priority: 0,
  url: "https://linear.app/example/issue/LEON-1",
  state: { id: "trigger", name: "Awaiting Trigger", type: "unstarted" },
  teamKey: "LEON",
  dueDate: null,
};

function setup(answer = "LEON-1", confidence = 0.98, candidates = [issue]) {
  const calls: Record<string, unknown>[] = [];
  const posts: SlackParams[] = [];
  let current: LinearIssue | null = issue;
  let priorPost: SlackParams | undefined;
  let failPost = false;
  const client: DecisionsClient = {
    decisions: {
      async create(body) {
        calls.push(body as unknown as Record<string, unknown>);
        return {
          model: "gpt-6-luna",
          answers: [
            {
              name: "trigger",
              type: "choice",
              choice: answer,
              confidence,
              probabilities: [{ value: answer, probability: confidence }],
            },
          ],
          usage: {
            input_tokens: 1,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            output_tokens: 1,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 2,
          },
        };
      },
    },
  };
  const session: SlackCall = async (method, params) => {
    assert.equal(params?.channel, SOURCE);
    if (method === "chat.getPermalink") {
      assert.equal(params?.message_ts, TS);
      return { ok: true, permalink: LINK };
    }
    assert.equal(method, "conversations.replies");
    assert.equal(params?.ts, ROOT_TS);
    return {
      ok: true,
      messages: [
        { ts: ROOT_TS, text: "App Review, did the mobile app pass review?" },
        { ts: TS, text: message.text },
        { ts: "1795521000.000003", text: "A later reply" },
      ],
    };
  };
  const bot: SlackCall = async (method, params = {}) => {
    assert.equal(params.channel, DESTINATION);
    if (method === "conversations.history") {
      return {
        ok: true,
        messages: priorPost ? [{ metadata: JSON.parse(String(priorPost.metadata)) }] : [],
      };
    }
    assert.equal(method, "chat.postMessage");
    posts.push(params);
    priorPost = params;
    if (failPost) throw new Error("response lost");
    return { ok: true };
  };
  const trigger = new Autotrigger({
    apiKey: "",
    client,
    linear: {
      issuesInState: async (team, state) => {
        assert.equal(team, "LEON");
        assert.equal(state, "Awaiting Trigger");
        return candidates;
      },
      issue: async () => current,
    },
    channelFor: async (id) => (id === issue.id ? DESTINATION : null),
    session,
    bot,
    teamKey: "LEON",
    state: "Awaiting Trigger",
    timeZone: "America/Toronto",
    hermesUserId: HERMES,
  });
  return {
    trigger,
    calls,
    posts,
    setCurrent: (value: LinearIssue | null) => {
      current = value;
    },
    loseSlackResponse: () => {
      failPost = true;
    },
  };
}

test("accepts new bot messages and replies, and skips edits and held channels", async () => {
  const event = {
    type: "message",
    subtype: "bot_message",
    channel_type: "channel",
    channel: SOURCE,
    ts: TS,
    thread_ts: ROOT_TS,
    text: message.text,
  };
  const parsed = feedEvent(event);
  assert.ok(parsed);
  assert.equal(parsed.threadTs, ROOT_TS);
  assert.equal(feedEvent({ ...event, subtype: "message_changed" }), null);
  assert.equal(feedEvent({ ...event, channel_type: "im" }), null);
  const slack =
    (name: string, extra = {}): SlackCall =>
    async () => ({ ok: true, channel: { name, ...extra } });
  assert.deepEqual(await feedMessage(parsed, slack("feed-gmail"), new Map(), []), message);
  assert.equal(await feedMessage(parsed, slack("general"), new Map(), []), null);
  assert.equal(await feedMessage(parsed, slack("feed-flagged"), new Map(), []), null);
  assert.equal(await feedMessage(parsed, slack("feed-gmail"), new Map(), [SOURCE]), null);
  assert.equal(
    await feedMessage(parsed, slack("feed-gmail", { is_ext_shared: true }), new Map(), []),
    null,
  );
});

test("matches a fresh reply using its thread and posts one link to the mapped issue channel", async () => {
  const { trigger, calls, posts } = setup();
  const delivery = await trigger.select(message);
  assert.ok(delivery);
  assert.equal(delivery.issueId, issue.id);
  assert.equal(delivery.channel, DESTINATION);
  assert.equal(delivery.permalink, LINK);
  const input = JSON.stringify(calls[0]);
  assert.match(input, /did the mobile app pass review/);
  assert.match(input, /"waiting_for":\{"who":"App Review"/);
  assert.doesNotMatch(input, /A later reply/);
  await trigger.deliver(message, delivery, false);
  assert.equal(posts.length, 1);
  assert.match(String(posts[0]!.text), new RegExp(`<@${HERMES}> Autotrigger`));
  assert.ok(String(posts[0]!.text).includes(`<${LINK}|#feed-gmail>`));
  assert.ok(!String(posts[0]!.text).includes(message.text));
  assert.equal(posts[0]!.unfurl_links, false);
});

test("does not post for low confidence, no match, archived or expired issues, or a status change", async () => {
  for (const testCase of [setup("LEON-1", 0.89), setup("no_match")]) {
    assert.equal(await testCase.trigger.select(message), null);
    assert.deepEqual(testCase.posts, []);
  }
  const { trigger, calls } = setup("LEON-1", 0.98, [
    { ...issue, archivedAt: "2026-11-23" },
    { ...issue, title: "Wait for news `{stop: 2001-01-01}`" },
  ]);
  assert.equal(await trigger.select(message), null);
  assert.deepEqual(calls, []);

  const moved = setup();
  const delivery = await moved.trigger.select(message);
  assert.ok(delivery);
  moved.setCurrent({ ...issue, state: { ...issue.state, name: "Executing" } });
  await moved.trigger.deliver(message, delivery, false);
  assert.deepEqual(moved.posts, []);
  moved.setCurrent({ ...issue, description: "Now waiting for a different decision." });
  await moved.trigger.deliver(message, delivery, false);
  assert.deepEqual(moved.posts, []);
});

test("does not post twice when Slack saved a notification before its response was lost", async () => {
  const { trigger, loseSlackResponse, posts } = setup();
  const delivery = await trigger.select(message);
  assert.ok(delivery);
  delivery.startedAt = Date.now();
  loseSlackResponse();
  await assert.rejects(trigger.deliver(message, delivery, false), /response lost/);
  await trigger.deliver(message, delivery, true);
  assert.equal(posts.length, 1);
});
