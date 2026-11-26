import assert from "node:assert/strict";
import test from "node:test";
import type { DecisionsClient } from "@-/ai.leonsilicon.services.feed-common";
import type {
  LinearIssue,
  LinearProjectText,
  NewIssue,
  SlackCall,
  SlackParams,
} from "@-/ai.leonsilicon.services.slack22linear";
import {
  Autotrigger,
  caseTitle,
  feedEvent,
  feedMessage,
  museRun,
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
  assert.ok(delivery && delivery.kind !== "spawn");
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
  assert.ok(delivery && delivery.kind !== "spawn");
  delivery.startedAt = Date.now();
  loseSlackResponse();
  await assert.rejects(trigger.deliver(message, delivery, false), /response lost/);
  await trigger.deliver(message, delivery, true);
  assert.equal(posts.length, 1);
});

// ── Watchers ─────────────────────────────────────────────────────────────────

const WATCHER: LinearProjectText = {
  id: "project-sponsorships",
  name: "Content Sponsorships",
  url: "https://linear.app/example/project/content-sponsorships",
  status: { name: "Watcher", type: "backlog" },
  slackChannelId: "C0WATCHER1",
  teamKeys: ["LEON"],
  createdAt: 0,
  gone: false,
  summary: "New sponsorship or paid collaboration inquiries in #feed-gmail.",
  content: "Reply with the standard quote: US$1,000 per TikTok. Never offer Instagram.",
};

const inquiry: FeedMessage = {
  channel: SOURCE,
  name: "feed-gmail",
  ts: TS,
  threadTs: null,
  text: `<@${HERMES}> *New email* from Brand Partnerships <deals@brand.example>\n*Paid collab with Brand for your TikTok*\nto leon · Nov 25, 4:10 PM EST · <https://mail.google.com/x|open in Gmail>\n\nHi Leon, we'd love to sponsor a TikTok. What are your rates?`,
  files: [],
};

function watcherSetup(
  answers: string[],
  options: {
    cases?: LinearIssue[];
    watcher?: LinearProjectText | null;
    otherWatchers?: LinearProjectText[];
  } = {},
) {
  const decisions: Record<string, unknown>[] = [];
  const created: NewIssue[] = [];
  const posts: SlackParams[] = [];
  let watcher = options.watcher === undefined ? WATCHER : options.watcher;
  const cases = options.cases ?? [];
  const client: DecisionsClient = {
    decisions: {
      async create(body) {
        decisions.push(body as unknown as Record<string, unknown>);
        const choice = answers[decisions.length - 1] ?? "no_match";
        return {
          model: "gpt-6-luna",
          answers: [
            {
              name: "trigger",
              type: "choice",
              choice,
              confidence: 0.97,
              probabilities: [{ value: choice, probability: 0.97 }],
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
  const slack: SlackCall = async (method, params = {}) => {
    if (method === "chat.getPermalink") return { ok: true, permalink: LINK };
    if (method === "chat.postMessage") {
      posts.push(params);
      return { ok: true };
    }
    throw new Error(`unexpected ${method}`);
  };
  const trigger = new Autotrigger({
    apiKey: "",
    client,
    linear: {
      issuesInState: async () => [issue],
      issue: async (id) => cases.find((c) => c.id === id) ?? null,
    },
    channelFor: async (id) => (cases.some((c) => c.id === id) ? DESTINATION : null),
    session: slack,
    bot: slack,
    teamKey: "LEON",
    state: "Awaiting Trigger",
    timeZone: "America/Toronto",
    hermesUserId: HERMES,
    watchers: {
      status: "Watcher",
      hermesState: "Awaiting Hermes",
      closedStateTypes: ["completed", "canceled", "duplicate"],
      linear: {
        projectsInStatus: async (team, status) => {
          assert.equal(team, "LEON");
          assert.equal(status, "Watcher");
          return [...(watcher ? [watcher] : []), ...(options.otherWatchers ?? [])];
        },
        openIssuesInProjects: async (ids) => {
          assert.deepEqual(ids, [WATCHER.id]);
          return cases;
        },
        projectText: async () => watcher,
        team: async () => ({
          id: "team-leon",
          states: [{ id: "state-hermes", name: "Awaiting Hermes", type: "started" }],
        }),
        createIssue: async (input) => {
          if (created.some((c) => c.id === input.id)) throw new Error("Entity already exists");
          created.push(input);
          return { ...issue, id: input.id, title: input.title };
        },
      },
    },
  });
  return {
    trigger,
    decisions,
    created,
    posts,
    setWatcher: (value: LinearProjectText | null) => {
      watcher = value;
    },
  };
}

test("a message a watcher is for opens a new Awaiting Hermes issue in the watcher's project", async () => {
  const { trigger, decisions, created, posts } = watcherSetup(["no_match", "W1"]);
  const delivery = await trigger.select(inquiry);
  assert.ok(delivery && delivery.kind === "spawn");
  assert.equal(decisions.length, 2);
  const asked = JSON.stringify(decisions[1]);
  assert.match(asked, /Content Sponsorships/);
  assert.match(asked, /New sponsorship or paid collaboration inquiries/);
  assert.equal(delivery.title, "Paid collab with Brand for your TikTok");
  assert.match(delivery.description, /\[Content Sponsorships\]\(https:\/\/linear\.app/);
  assert.match(delivery.description, /> Hi Leon, we'd love to sponsor a TikTok/);
  assert.match(delivery.description, /Never offer Instagram/);
  assert.ok(delivery.description.includes(`(${LINK})`));
  assert.doesNotMatch(delivery.description, new RegExp(HERMES));

  await trigger.deliver(inquiry, delivery, false);
  await trigger.deliver(inquiry, delivery, true);
  assert.equal(created.length, 1);
  assert.equal(created[0]!.projectId, WATCHER.id);
  assert.equal(created[0]!.stateId, "state-hermes");
  assert.equal(created[0]!.id, delivery.issueId);
  assert.deepEqual(posts, []);
});

test("an Awaiting Trigger issue that matches wins over the watchers", async () => {
  const { trigger, decisions } = watcherSetup(["LEON-1", "W1"]);
  const delivery = await trigger.select(inquiry);
  assert.equal(decisions.length, 1);
  assert.equal(delivery, null); // LEON-1 has no channel in this setup
});

test("only a top-level #feed-muse run from Hermes can select a scheduled Watcher", () => {
  const source = {
    ...inquiry,
    name: "feed-muse",
    text: "Muse reminder due: Bring the tripod\nMuse schedule: tripod\nMuse run: run-1",
  };
  const bot = { user: HERMES, bot_id: "B01234567" };
  assert.deepEqual(museRun(source, bot, HERMES), { scheduleId: "tripod", runId: "run-1" });
  assert.equal(museRun(source, { user: HERMES }, HERMES), undefined);
  assert.equal(museRun(source, { ...bot, user: "U98765432" }, HERMES), undefined);
  assert.equal(museRun({ ...source, threadTs: ROOT_TS }, bot, HERMES), undefined);
  assert.equal(museRun({ ...source, name: "feed-gmail" }, bot, HERMES), undefined);
});

test("a Muse run prefers its linked Watcher and opens one Hermes case across Slack retries", async () => {
  const linked = {
    ...WATCHER,
    content: "Muse schedule: `tripod`\n\nRemind Leon to bring the tripod.",
  };
  const fallback = { ...WATCHER, id: "fallback", content: "Muse schedule: *" };
  const { trigger, decisions, created } = watcherSetup([], {
    watcher: linked,
    otherWatchers: [fallback],
  });
  const source: FeedMessage = {
    ...inquiry,
    name: "feed-muse",
    text: "Muse reminder due: Bring the tripod\nMuse schedule: tripod\nMuse run: run-1",
    museRun: { scheduleId: "tripod", runId: "run-1" },
  };
  const delivery = await trigger.select(source);
  assert.ok(delivery && delivery.kind === "spawn");
  assert.equal(delivery.watcherId, linked.id);
  assert.match(delivery.description, /Remind Leon to bring the tripod/);
  assert.match(delivery.description, /#feed-muse/);
  const retry = await trigger.select({ ...source, ts: "1795521001.000002" });
  assert.ok(retry && retry.kind === "spawn");
  assert.equal(retry.issueId, delivery.issueId);
  await trigger.deliver(source, delivery, false);
  await trigger.deliver(source, retry, true);
  assert.equal(created.length, 1);
  assert.equal(created[0]!.stateId, "state-hermes");
  assert.equal(decisions.length, 0);

  const unmatched = await trigger.select({
    ...source,
    museRun: { scheduleId: "other", runId: "run-2" },
  });
  assert.ok(unmatched?.kind === "spawn");
  assert.equal(unmatched.watcherId, fallback.id);

  const conflicting = watcherSetup([], {
    watcher: linked,
    otherWatchers: [{ ...linked, id: "dupe" }, fallback],
  });
  await assert.rejects(conflicting.trigger.select(source), /one matching Watcher/);
});

test("a follow-up in a watcher's open case goes to that case, not a new issue", async () => {
  const open: LinearIssue = {
    ...issue,
    id: "case-1",
    identifier: "LEON-700",
    title: "Paid collab with Brand",
    state: { id: "state-leon", name: "Awaiting Leon", type: "started" },
    projectId: WATCHER.id,
  };
  const { trigger, decisions, created, posts } = watcherSetup(["no_match", "LEON-700"], {
    cases: [open],
  });
  const delivery = await trigger.select(inquiry);
  assert.ok(delivery && delivery.kind !== "spawn");
  assert.equal(delivery.watcherId, WATCHER.id);
  assert.match(JSON.stringify(decisions[1]), /"open_cases":\[\{"id":"LEON-700","watcher":"W1"/);
  await trigger.deliver(inquiry, delivery, false);
  assert.equal(created.length, 0);
  assert.equal(posts.length, 1);
  assert.match(String(posts[0]!.text), /a possible follow-up for this case/);
});

test("nothing is opened when no watcher is clearly for the message, or the watcher closed", async () => {
  const none = watcherSetup(["no_match", "no_match"]);
  assert.equal(await none.trigger.select(inquiry), null);

  const closed = watcherSetup(["no_match", "W1"]);
  const delivery = await closed.trigger.select(inquiry);
  assert.ok(delivery);
  closed.setWatcher({ ...WATCHER, status: { name: "Completed", type: "completed" } });
  await closed.trigger.deliver(inquiry, delivery, false);
  assert.equal(closed.created.length, 0);

  const without = watcherSetup([], { watcher: null });
  assert.equal(await without.trigger.select({ ...inquiry, text: "Unrelated" }), null);
  assert.equal(without.decisions.length, 1);
});

test("a case title is the email's subject, else the first line", () => {
  assert.equal(caseTitle(inquiry.text, "x"), "Paid collab with Brand for your TikTok");
  assert.equal(
    caseTitle("Just one line about <https://a.example|a link>", "x"),
    "Just one line about a link",
  );
  assert.equal(
    caseTitle("", "New case for Content Sponsorships"),
    "New case for Content Sponsorships",
  );
});
