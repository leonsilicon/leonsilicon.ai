import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { loadConfig } from "#config";
import type { LinearApi, LinearComment, LinearIssue, LinearState } from "#linear";
import { SlackError, type SlackCall, type SlackParams } from "#slack";
import { Store, type Sql, type SqlValue } from "#store";
import { Sync } from "#sync";

const LEON = "U0LEON00001";
const HERMES = "U0HERMES001";
const BOT = "U0SYNCBOT1";

const STATES: LinearState[] = [
  "Awaiting Clarification:backlog",
  "Awaiting Date:unstarted",
  "Awaiting Start:unstarted",
  "Executing:started",
  "Awaiting Hermes:started",
  "Awaiting Leon:started",
  "Awaiting Others:started",
  "Awaiting Listener:started",
  "Done:completed",
  "Canceled:canceled",
].map((s) => {
  const [name, type] = s.split(":") as [string, string];
  return { id: `state-${name}`, name, type };
});
const state = (name: string) => STATES.find((s) => s.name === name)!;

function memorySql(): Sql {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (query: string, ...params: SqlValue[]) => db.prepare(query).all(...params) as never,
  };
}

function fakeLinear() {
  const issues = new Map<string, LinearIssue>();
  const comments = new Map<string, LinearComment>();
  const created: { id: string; issueId: string; body: string; parentId?: string }[] = [];
  const updates: { id: string; input: { stateId?: string; title?: string } }[] = [];
  const api: LinearApi = {
    issue: async (id) =>
      issues.get(id) ?? [...issues.values()].find((i) => i.identifier === id) ?? null,
    comment: async (id) => comments.get(id) ?? null,
    openIssues: async () =>
      [...issues.values()].filter(
        (i) => !["completed", "canceled", "duplicate"].includes(i.state.type),
      ),
    states: async () => STATES,
    createComment: async (input) => {
      created.push(input);
      comments.set(input.id, {
        id: input.id,
        body: input.body,
        issueId: input.issueId,
        parentId: input.parentId ?? null,
        authorName: "Hermes",
        authorAvatar: null,
      });
    },
    updateComment: async (id, body) => {
      comments.get(id)!.body = body;
    },
    updateIssue: async (id, input) => {
      updates.push({ id, input });
      const issue = issues.get(id)!;
      if (input.stateId) issue.state = STATES.find((s) => s.id === input.stateId)!;
      if (input.title) issue.title = input.title;
    },
  };
  const addIssue = (number: number, title: string, status: string, description = "") => {
    const issue: LinearIssue = {
      id: `issue-${number}`,
      identifier: `LEON-${number}`,
      number,
      title,
      url: `https://linear.app/leonsilicon/issue/LEON-${number}`,
      description,
      state: state(status),
      teamKey: "LEON",
    };
    issues.set(issue.id, issue);
    return issue;
  };
  return { api, issues, comments, created, updates, addIssue };
}

interface Channel {
  id: string;
  name: string;
  private: boolean;
  archived: boolean;
  members: Set<string>;
  topic: string;
}

/** One Slack seen two ways: the sync's bot and Leon's web session. */
function fakeSlack() {
  const channels: Channel[] = [];
  const sections: { id: string; name: string; type: string; channelIds: string[] }[] = [
    { id: "L-stars", name: "", type: "stars", channelIds: [] },
    { id: "L-channels", name: "Channels", type: "channels", channelIds: [] },
  ];
  const posts: {
    channel: string;
    ts: string;
    text: string;
    username?: string;
    thread_ts?: string;
    by: string;
  }[] = [];
  const calls: { who: string; method: string; params: SlackParams }[] = [];
  let seq = 0;
  const find = (id: unknown) => {
    const c = channels.find((ch) => ch.id === id);
    if (!c) throw new SlackError("x", "channel_not_found");
    return c;
  };
  const client =
    (who: "bot" | "leon"): SlackCall =>
    async (method, params = {}) => {
      calls.push({ who, method, params });
      const me = who === "bot" ? BOT : LEON;
      const member = (c: Channel) => {
        if (!c.members.has(me)) throw new SlackError(method, "not_in_channel");
      };
      switch (method) {
        case "auth.test":
          return { ok: true, user_id: me };
        case "users.info":
          return {
            ok: true,
            user: {
              name: "leon",
              profile: { display_name: params.user === LEON ? "Leon" : "Someone" },
            },
          };
        case "conversations.create": {
          if (channels.some((c) => c.name === params.name))
            throw new SlackError(method, "name_taken");
          const c: Channel = {
            id: `C${++seq}`,
            name: String(params.name),
            private: params.is_private === true,
            archived: false,
            members: new Set([me]),
            topic: "",
          };
          channels.push(c);
          return { ok: true, channel: { id: c.id } };
        }
        case "conversations.invite": {
          const c = find(params.channel);
          member(c);
          if (c.members.has(String(params.users)))
            throw new SlackError(method, "already_in_channel");
          c.members.add(String(params.users));
          return { ok: true };
        }
        case "conversations.list":
          return {
            ok: true,
            channels: channels
              .filter((c) => c.members.has(me))
              .map((c) => ({ id: c.id, name: c.name, is_archived: c.archived })),
          };
        case "conversations.setTopic": {
          const c = find(params.channel);
          member(c);
          c.topic = String(params.topic);
          return { ok: true };
        }
        case "conversations.archive": {
          const c = find(params.channel);
          member(c);
          if (c.archived) throw new SlackError(method, "already_archived");
          c.archived = true;
          return { ok: true };
        }
        case "conversations.unarchive":
          find(params.channel).archived = false;
          return { ok: true };
        case "conversations.rename":
          find(params.channel).name = String(params.name);
          return { ok: true };
        case "chat.postMessage": {
          const c = find(params.channel);
          member(c);
          if (c.archived) throw new SlackError(method, "is_archived");
          const ts = `1794000000.${String(++seq).padStart(6, "0")}`;
          posts.push({
            channel: c.id,
            ts,
            text: String(params.text),
            username: params.username as string | undefined,
            thread_ts: params.thread_ts as string | undefined,
            by: who,
          });
          return { ok: true, ts };
        }
        case "chat.update": {
          const p = posts.find((m) => m.ts === params.ts)!;
          p.text = String(params.text);
          return { ok: true };
        }
        case "users.channelSections.list": {
          return {
            ok: true,
            channel_sections: sections.map((s, i) => ({
              channel_section_id: s.id,
              name: s.name,
              type: s.type,
              next_channel_section_id: sections[i + 1]?.id ?? null,
              channel_ids_page: { channel_ids: [...s.channelIds] },
            })),
          };
        }
        case "users.channelSections.create": {
          const s = {
            id: `L${++seq}`,
            name: String(params.name),
            type: "standard",
            channelIds: [] as string[],
          };
          // Like Slack: `create` can't insert above the topmost section, so it lands below it.
          const at = params.next_channel_section_id
            ? sections.findIndex((x) => x.id === params.next_channel_section_id)
            : sections.length;
          sections.splice(Math.max(at, 1), 0, s);
          return { ok: true, channel_section_id: s.id };
        }
        case "users.channelSections.set": {
          const at = sections.findIndex((x) => x.id === params.channel_section_id);
          const [moved] = sections.splice(at, 1);
          sections.splice(
            sections.findIndex((x) => x.id === params.next_channel_section_id),
            0,
            moved!,
          );
          return { ok: true };
        }
        case "users.channelSections.delete": {
          sections.splice(
            sections.findIndex((s) => s.id === params.channel_section_id),
            1,
          );
          return { ok: true };
        }
        case "users.channelSections.channels.bulkUpdate": {
          for (const r of JSON.parse(String(params.remove ?? "[]")) as {
            channel_section_id: string;
            channel_ids: string[];
          }[]) {
            const s = sections.find((x) => x.id === r.channel_section_id)!;
            s.channelIds = s.channelIds.filter((id) => !r.channel_ids.includes(id));
          }
          for (const r of JSON.parse(String(params.insert ?? "[]")) as {
            channel_section_id: string;
            channel_ids: string[];
          }[])
            sections.find((x) => x.id === r.channel_section_id)!.channelIds.push(...r.channel_ids);
          return { ok: true };
        }
        default:
          throw new Error(`fake Slack has no ${method}`);
      }
    };
  const sectionOf = (channelId: string) =>
    sections.find((s) => s.type === "standard" && s.channelIds.includes(channelId))?.name ?? null;
  const order = () => sections.filter((s) => s.type === "standard").map((s) => s.name);
  const addLeonChannel = (name: string) => {
    const c: Channel = {
      id: `C${++seq}`,
      name,
      private: true,
      archived: false,
      members: new Set([LEON, HERMES]),
      topic: "",
    };
    channels.push(c);
    return c;
  };
  return {
    bot: client("bot"),
    session: client("leon"),
    channels,
    sections,
    posts,
    calls,
    sectionOf,
    order,
    addLeonChannel,
  };
}

function setup(now = Date.UTC(2026, 10, 18, 20, 0)) {
  const linear = fakeLinear();
  const slack = fakeSlack();
  const store = new Store(memorySql());
  const clock = { now };
  const sync = new Sync({
    config: loadConfig({ SLACK_LEON_USER_ID: LEON, SLACK_HERMES_USER_ID: HERMES }),
    store,
    linear: linear.api,
    bot: slack.bot,
    session: slack.session,
    now: () => clock.now,
  });
  return { linear, slack, store, sync, clock };
}

const issueHook = (id: string, action = "update") => ({ action, type: "Issue", data: { id } });
const commentHook = (id: string, action = "create") => ({ action, type: "Comment", data: { id } });

test("a new issue gets a private channel, an intro, a topic and its status section", async () => {
  const { linear, slack, sync } = setup();
  linear.addIssue(
    380,
    "Stop San Francisco Optometry email reminders",
    "Awaiting Start",
    "## Goal\n**Stop** them.",
  );
  await sync.run("linear", issueHook("issue-380", "create"));

  const channel = slack.channels[0]!;
  assert.equal(channel.name, "leon-380-stop-san-francisco-optometry-email-reminders");
  assert.equal(channel.private, true);
  assert.deepEqual([...channel.members].sort(), [BOT, HERMES, LEON].sort());
  assert.equal(channel.topic, "Awaiting Start · https://linear.app/leonsilicon/issue/LEON-380");
  assert.equal(slack.sectionOf(channel.id), "Awaiting Start");
  const intro = slack.posts[0]!;
  assert.match(
    intro.text,
    /^\*<https:\/\/linear\.app\/leonsilicon\/issue\/LEON-380\|LEON-380: Stop San Francisco Optometry email reminders>\* · Awaiting Start/,
  );
  assert.match(intro.text, /\*Goal\*\n\*Stop\* them\./);
  assert.match(
    intro.text,
    new RegExp(`<@${HERMES}> LEON-380 is now Awaiting Start: please pick it up\\.`),
  );

  // A redelivered webhook changes nothing.
  await sync.run("linear", issueHook("issue-380"));
  assert.equal(slack.channels.length, 1);
  assert.equal(slack.posts.length, 1);
});

test("status moves post a message, mention the right party and move the section", async () => {
  const { linear, slack, sync } = setup();
  const issue = linear.addIssue(205, "switch to rogers", "Executing");
  await sync.run("linear", issueHook(issue.id, "create"));
  const channel = slack.channels[0]!;

  issue.state = state("Awaiting Leon");
  await sync.run("linear", issueHook(issue.id));
  assert.equal(slack.posts.at(-1)!.text, `*Executing* → *Awaiting Leon*\n<@${LEON}>`);
  assert.equal(slack.sectionOf(channel.id), "Awaiting Leon");
  assert.deepEqual(slack.order(), ["Awaiting Leon"], "the emptied Executing section is removed");

  issue.state = state("Awaiting Listener");
  issue.title = "switch to rogers `{event: Rogers unlimited BYOD deal, stop: 2026-12-01}`";
  await sync.run("linear", issueHook(issue.id));
  assert.equal(slack.posts.at(-1)!.text, "*Awaiting Leon* → *Awaiting Listener*");
  assert.equal(
    channel.topic,
    "Awaiting Listener · event: Rogers unlimited BYOD deal · stop: 2026-12-01 · https://linear.app/leonsilicon/issue/LEON-205",
  );
  assert.equal(
    channel.name,
    "leon-205-switch-to-rogers",
    "metadata alone doesn't rename the channel",
  );

  issue.state = state("Done");
  await sync.run("linear", issueHook(issue.id));
  assert.equal(slack.posts.at(-1)!.text, "*Awaiting Listener* → *Done*");
  assert.equal(channel.archived, true);
  assert.equal(slack.sectionOf(channel.id), null);
  assert.deepEqual(slack.order(), [], "closing empties and removes its section");

  // Reopening brings the same channel back.
  issue.state = state("Executing");
  await sync.run("linear", issueHook(issue.id));
  assert.equal(channel.archived, false);
  assert.equal(slack.channels.length, 1);
  assert.equal(slack.posts.at(-1)!.text, "*Done* → *Executing*");
  assert.equal(slack.sectionOf(channel.id), "Executing");
});

test("sections are created in the configured order", async () => {
  const { linear, slack, sync } = setup();
  for (const [n, s] of [
    [1, "Executing"],
    [2, "Awaiting Date"],
    [3, "Awaiting Leon"],
    [4, "Awaiting Others"],
  ] as const) {
    linear.addIssue(n, `task ${n}`, s);
    await sync.run("linear", issueHook(`issue-${n}`, "create"));
  }
  assert.deepEqual(slack.order(), [
    "Awaiting Leon",
    "Awaiting Others",
    "Executing",
    "Awaiting Date",
  ]);
  assert.equal(slack.sections[0]!.name, "Awaiting Leon", "the managed block sits at the top");
});

test("comments mirror both ways, threads included, without echoing", async () => {
  const { linear, slack, sync, store } = setup();
  const issue = linear.addIssue(
    330,
    "Get UofT Creators Club recognized at St. George",
    "Awaiting Leon",
  );
  await sync.run("linear", issueHook(issue.id, "create"));
  const channel = slack.channels[0]!;

  // Linear → Slack, as the comment's author.
  linear.comments.set("c1", {
    id: "c1",
    body: "Need a **St. George** lead.",
    issueId: issue.id,
    parentId: null,
    authorName: "Hermes",
    authorAvatar: "https://a/h.png",
  });
  await sync.run("linear", commentHook("c1"));
  const mirrored = slack.posts.at(-1)!;
  assert.deepEqual(
    [mirrored.text, mirrored.username, mirrored.thread_ts],
    ["Need a *St. George* lead.", "Hermes", undefined],
  );

  // Slack → Linear: Leon answers in that message's thread.
  await sync.run("slack", {
    type: "message",
    channel: channel.id,
    user: LEON,
    text: "*Parth* can do it",
    ts: "1794100000.000001",
    thread_ts: mirrored.ts,
  });
  const reply = linear.created.at(-1)!;
  assert.equal(reply.body, "**Leon in Slack:** **Parth** can do it");
  assert.equal(reply.parentId, "c1");
  assert.equal(store.comment(reply.id)!.origin, "slack");

  // Linear's webhook for that comment isn't posted back to Slack.
  const before = slack.posts.length;
  await sync.run("linear", commentHook(reply.id));
  assert.equal(slack.posts.length, before);

  // A Linear reply lands in the Slack thread.
  linear.comments.set("c2", {
    id: "c2",
    body: "Thanks, updating.",
    issueId: issue.id,
    parentId: "c1",
    authorName: "Hermes",
    authorAvatar: null,
  });
  await sync.run("linear", commentHook("c2"));
  assert.equal(slack.posts.at(-1)!.thread_ts, mirrored.ts);

  // Edits follow in both directions.
  linear.comments.get("c1")!.body = "Need a *St. George* lead by Friday.";
  await sync.run("linear", commentHook("c1", "update"));
  assert.equal(
    slack.posts.find((p) => p.ts === mirrored.ts)!.text,
    "Need a _St. George_ lead by Friday.",
  );
  await sync.run("slack", {
    type: "message",
    subtype: "message_changed",
    channel: channel.id,
    ts: "1794100000.000009",
    message: { ts: "1794100000.000001", user: LEON, text: "*Parth* or Jad can do it" },
  });
  assert.equal(
    linear.comments.get(reply.id)!.body,
    "**Leon in Slack:** **Parth** or Jad can do it",
  );

  // A retried Slack event doesn't create a second comment.
  const count = linear.created.length;
  await sync.run("slack", {
    type: "message",
    channel: channel.id,
    user: LEON,
    text: "*Parth* can do it",
    ts: "1794100000.000001",
    thread_ts: mirrored.ts,
  });
  assert.equal(linear.created.length, count);
});

test("bots, system messages and unmapped channels stay out of Linear", async () => {
  const { linear, slack, sync } = setup();
  linear.addIssue(9, "x", "Executing");
  await sync.run("linear", issueHook("issue-9", "create"));
  const channel = slack.channels[0]!.id;
  for (const event of [
    { type: "message", channel, ts: "1.1", bot_id: "B1", text: "[FROM HERMES] update" },
    { type: "message", channel, ts: "1.2", user: LEON, subtype: "channel_join", text: "joined" },
    {
      type: "message",
      channel,
      ts: "1.3",
      user: LEON,
      text: "as Leon",
      client_msg_id: "de1e6a7e-0000-4000-8000-000000000000",
    },
    { type: "message", channel: "C-unmapped", ts: "1.4", user: LEON, text: "elsewhere" },
  ])
    await sync.run("slack", event);
  assert.equal(linear.created.length, 0);
});

test("backfill adopts existing issue channels quietly and archives closed ones", async () => {
  const { linear, slack, sync, store } = setup();
  const open = slack.addLeonChannel("leon-315-migrate-instagram-payout-setup-from-us-to");
  const closed = slack.addLeonChannel("leon-5-get-uoft-creators-recognized-at-utsc");
  const other = slack.addLeonChannel("general");
  linear.addIssue(315, "Migrate Instagram payout setup from US to Canada", "Awaiting Leon");
  linear.addIssue(5, "Get UofT Creators recognized at UTSC", "Done");
  linear.addIssue(379, "Create UofT Creators Club membership signup form", "Awaiting Start");

  await sync.run("backfill", {});
  assert.equal(store.issue("issue-315")!.channelId, open.id);
  assert.ok(open.members.has(BOT));
  assert.equal(slack.sectionOf(open.id), "Awaiting Leon");
  assert.equal(open.topic, "Awaiting Leon · https://linear.app/leonsilicon/issue/LEON-315");
  assert.equal(closed.archived, true);
  assert.equal(other.archived, false);
  const created = slack.channels.find((c) => c.name.startsWith("leon-379-"))!;
  assert.equal(slack.sectionOf(created.id), "Awaiting Start");
  assert.equal(slack.posts.length, 0, "backfill posts nothing");
});

test("tick starts dated issues, expires listeners and repairs drift", async () => {
  const { linear, slack, sync, clock, store } = setup(Date.UTC(2026, 11, 1, 5, 30));
  const dated = linear.addIssue(10, "File taxes `{start: 2026-12-01}`", "Awaiting Date");
  const later = linear.addIssue(11, "Renew `{start: 2026-12-02}`", "Awaiting Date");
  const listener = linear.addIssue(
    205,
    "switch to rogers `{event: Rogers deal, stop: 2026-12-01}`",
    "Awaiting Listener",
  );
  await sync.run("backfill", {});

  await sync.run("tick", {});
  assert.equal(dated.state.name, "Awaiting Start");
  assert.equal(dated.title, "File taxes");
  assert.equal(later.state.name, "Awaiting Date");
  assert.equal(listener.state.name, "Awaiting Leon");
  assert.equal(listener.title, "switch to rogers");
  assert.match(linear.created.at(-1)!.body, /stop date \(2026-12-01\) passed .* Rogers deal/);
  // The tick's own reconcile already moved the channels (webhooks would too).
  assert.equal(slack.sectionOf(store.issue(dated.id)!.channelId), "Awaiting Start");
  assert.equal(slack.sectionOf(store.issue(listener.id)!.channelId), "Awaiting Leon");

  clock.now += 24 * 3600_000;
  await sync.run("tick", {});
  assert.equal(later.state.name, "Awaiting Start");
});

test("loadConfig needs both Slack user IDs, which have no built-in defaults", () => {
  assert.throws(
    () => loadConfig({ SLACK_HERMES_USER_ID: HERMES }),
    /SLACK_LEON_USER_ID is required/,
  );
  assert.throws(() => loadConfig({ SLACK_LEON_USER_ID: LEON }), /SLACK_HERMES_USER_ID is required/);
  const config = loadConfig({ SLACK_LEON_USER_ID: LEON, SLACK_HERMES_USER_ID: HERMES });
  assert.equal(config.leonUserId, LEON);
  assert.equal(config.hermesUserId, HERMES);
});
