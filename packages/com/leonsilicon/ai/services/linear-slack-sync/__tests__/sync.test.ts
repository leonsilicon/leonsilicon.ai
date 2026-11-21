import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { loadConfig } from "#config";
import type {
  IssueUpdate,
  LinearApi,
  LinearComment,
  LinearIssue,
  LinearProject,
  LinearState,
  NewIssue,
  ProjectChannelSettings,
} from "#linear";
import { SlackError, type SlackCall, type SlackParams } from "#slack";
import { Store, type Sql, type SqlValue } from "#store";
import {
  ADOPT_WAIT_MS,
  ANSWER_SETTLE_MS,
  autolinearIssueId,
  PROJECT_GRACE_MS,
  Sync,
  type Adoption,
} from "#sync";

const LEON = "U0LEON00001";
const HERMES = "U0HERMES001";
const BOT = "U0SYNCBOT1";
/** Linear's own Slack app, which creates and owns project channels. */
const LINEAR_BOT = "U0LINEARBOT";

const STATES: LinearState[] = [
  "Awaiting Init:unstarted",
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

/** Linear's side of a project channel: it creates a public channel and invites project members. */
type MakeChannel = (name: string) => { id: string };

function fakeLinear(makeChannel: MakeChannel, now: () => number = Date.now) {
  const issues = new Map<string, LinearIssue>();
  /** When each issue's status last changed, as Linear's history would say. */
  const statusChanged = new Map<string, number>();
  const projects = new Map<string, LinearProject>();
  const channelRequests: { projectId: string; name: string; integrationId: string }[] = [];
  const linearSide = {
    settings: { integrationId: "int-slack", prefix: "project-" } as ProjectChannelSettings | null,
    /** When true, Linear accepts a request but the channel doesn't appear until `finish`. */
    slow: false,
    pending: [] as { projectId: string; name: string }[],
  };
  const finish = () => {
    for (const { projectId, name } of linearSide.pending.splice(0))
      projects.get(projectId)!.slackChannelId = makeChannel(name).id;
  };
  const comments = new Map<string, LinearComment>();
  const created: { id: string; issueId: string; body: string; parentId?: string }[] = [];
  const updates: { id: string; input: IssueUpdate }[] = [];
  const newIssues: NewIssue[] = [];
  const api: LinearApi = {
    issue: async (id) =>
      issues.get(id) ?? [...issues.values()].find((i) => i.identifier === id) ?? null,
    comment: async (id) => comments.get(id) ?? null,
    openIssues: async () =>
      [...issues.values()].filter(
        (i) => !["completed", "canceled", "duplicate"].includes(i.state.type),
      ),
    states: async () => STATES,
    createIssue: async (input) => {
      if (issues.has(input.id)) throw new Error("Entity already exists");
      newIssues.push(input);
      const number = Math.max(400, ...[...issues.values()].map((i) => i.number)) + 1;
      const issue: LinearIssue = {
        id: input.id,
        identifier: `LEON-${number}`,
        number,
        title: input.title,
        url: `https://linear.app/leonsilicon/issue/LEON-${number}`,
        description: input.description,
        state: STATES.find((s) => s.id === input.stateId)!,
        teamKey: "LEON",
        dueDate: null,
      };
      issues.set(issue.id, issue);
      return { ...issue };
    },
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
    lastStatusChange: async (id) => statusChanged.get(id) ?? null,
    updateIssue: async (id, input) => {
      updates.push({ id, input });
      const issue = issues.get(id)!;
      if (input.stateId) {
        issue.state = STATES.find((s) => s.id === input.stateId)!;
        statusChanged.set(id, now());
      }
      if (input.title) issue.title = input.title;
      if ("dueDate" in input) issue.dueDate = input.dueDate ?? null;
    },
    project: async (id) => projects.get(id) ?? null,
    openProjects: async (team, closed) =>
      [...projects.values()].filter(
        (p) => p.teamKeys.includes(team) && !p.gone && !closed.includes(p.status.type),
      ),
    projectChannelSettings: async () => linearSide.settings,
    createProjectChannel: async (input) => {
      channelRequests.push(input);
      linearSide.pending.push({ projectId: input.projectId, name: input.name });
      if (!linearSide.slow) finish();
    },
  };
  const addProject = (
    name: string,
    status = "Backlog:backlog",
    createdAt = Date.UTC(2026, 10, 1),
  ) => {
    const [statusName, type] = status.split(":") as [string, string];
    const project: LinearProject = {
      id: `project-${projects.size + 1}`,
      name,
      url: `https://linear.app/leonsilicon/project/${projects.size + 1}`,
      status: { name: statusName, type },
      slackChannelId: null,
      teamKeys: ["LEON"],
      createdAt,
      gone: false,
    };
    projects.set(project.id, project);
    return project;
  };
  const addIssue = (
    number: number,
    title: string,
    status: string,
    description = "",
    id = `issue-${number}`,
  ) => {
    const issue: LinearIssue = {
      id,
      identifier: `LEON-${number}`,
      number,
      title,
      url: `https://linear.app/leonsilicon/issue/LEON-${number}`,
      description,
      state: state(status),
      teamKey: "LEON",
      dueDate: null,
    };
    issues.set(issue.id, issue);
    return issue;
  };
  return {
    api,
    issues,
    comments,
    created,
    updates,
    newIssues,
    addIssue,
    projects,
    addProject,
    channelRequests,
    linearSide,
    finish,
  };
}

interface Channel {
  id: string;
  name: string;
  private: boolean;
  archived: boolean;
  members: Set<string>;
  topic: string;
  /** A DM's other person, seen from Leon's side. */
  im?: string;
}

interface Post {
  channel: string;
  ts: string;
  text: string;
  username?: string;
  thread_ts?: string;
  by: string;
  /** The author's user ID. */
  user: string;
  client_msg_id?: string;
  blocks?: unknown[];
  files?: { name?: string; title?: string; permalink?: string }[];
}

/** One Slack seen two ways: the sync's bot and Leon's web session. */
function fakeSlack() {
  const channels: Channel[] = [];
  const sections: { id: string; name: string; type: string; channelIds: string[] }[] = [
    { id: "L-stars", name: "", type: "stars", channelIds: [] },
    { id: "L-channels", name: "Channels", type: "channels", channelIds: [] },
  ];
  const posts: Post[] = [];
  const calls: { who: string; method: string; params: SlackParams }[] = [];
  /** Makes the next matching call fail with a Slack error, once. */
  const failures: { who: string; method: string; code: string }[] = [];
  /** Leon's starred channels. Slack keeps them apart from custom sections: a channel can be in both. */
  const stars = new Set<string>();
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
      const failure = failures.findIndex((f) => f.who === who && f.method === method);
      if (failure >= 0) throw new SlackError(method, failures.splice(failure, 1)[0]!.code);
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
              profile: {
                display_name:
                  params.user === LEON ? "Leon" : params.user === HERMES ? "Hermes" : "Someone",
              },
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
          const users = String(params.users).split(",");
          if (users.some((u) => c.members.has(u)))
            throw new SlackError(method, "already_in_channel");
          for (const u of users) c.members.add(u);
          return { ok: true };
        }
        case "conversations.join": {
          const c = find(params.channel);
          if (c.private) throw new SlackError(method, "method_not_supported_for_channel_type");
          if (c.archived) throw new SlackError(method, "is_archived");
          c.members.add(me);
          return { ok: true };
        }
        case "conversations.list":
          return {
            ok: true,
            channels: channels
              .filter((c) => !c.private || c.members.has(me))
              .map((c) => ({ id: c.id, name: c.name, is_archived: c.archived })),
          };
        case "conversations.setPurpose":
          member(find(params.channel));
          return { ok: true };
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
        case "stars.add":
          if (stars.has(String(params.channel))) throw new SlackError(method, "already_starred");
          stars.add(String(params.channel));
          return { ok: true };
        case "stars.remove":
          if (!stars.delete(String(params.channel))) throw new SlackError(method, "not_starred");
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
            user: me,
            client_msg_id: params.client_msg_id as string | undefined,
          });
          return { ok: true, ts };
        }
        case "chat.update": {
          const p = posts.find((m) => m.ts === params.ts && m.channel === params.channel);
          if (!p) throw new SlackError(method, "message_not_found");
          if (p.user !== me) throw new SlackError(method, "cant_update_message");
          p.text = String(params.text);
          if (params.blocks) p.blocks = JSON.parse(String(params.blocks)) as unknown[];
          return { ok: true };
        }
        case "chat.getPermalink":
          return {
            ok: true,
            permalink: `https://leonsilicon.slack.com/archives/${params.channel}/p${String(params.message_ts).replace(".", "")}`,
          };
        case "conversations.info": {
          const c = find(params.channel);
          return {
            ok: true,
            channel: c.im
              ? { id: c.id, is_im: true, user: c.im }
              : { id: c.id, name: c.name, is_private: c.private },
          };
        }
        case "conversations.history": {
          const c = find(params.channel);
          member(c);
          const within = (m: Post) =>
            m.channel === c.id &&
            (!m.thread_ts || m.thread_ts === m.ts) &&
            (!params.oldest || m.ts >= String(params.oldest)) &&
            (!params.latest || m.ts <= String(params.latest));
          return { ok: true, messages: structuredClone(posts.filter(within).reverse()) };
        }
        case "conversations.replies": {
          const c = find(params.channel);
          member(c);
          const root = posts.find((m) => m.channel === c.id && m.ts === params.ts);
          if (!root) throw new SlackError(method, "thread_not_found");
          const replies = posts.filter(
            (m) =>
              m.channel === c.id &&
              m.thread_ts === root.ts &&
              m.ts !== root.ts &&
              (!params.oldest || m.ts >= String(params.oldest)) &&
              (!params.latest || m.ts <= String(params.latest)),
          );
          return {
            ok: true,
            messages: structuredClone([root, ...replies].slice(0, Number(params.limit ?? 100))),
          };
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
  /** Leon's DM with someone, as his session sees it. */
  const addDm = (with_: string) => {
    const c: Channel = {
      id: `D${++seq}`,
      name: "",
      private: true,
      archived: false,
      members: new Set([LEON, with_]),
      topic: "",
      im: with_,
    };
    channels.push(c);
    return c;
  };
  /** A message someone wrote, as it sits in Slack. */
  const say = (channel: string, user: string, text: string, extra: Partial<Post> = {}) => {
    const post: Post = {
      channel,
      ts: `1794000000.${String(++seq).padStart(6, "0")}`,
      text,
      by: user === LEON ? "leon" : user,
      user,
      ...extra,
    };
    posts.push(post);
    return post;
  };
  /** A public channel made by Linear's Slack app, with the members Linear invited. */
  const addLinearChannel = (name: string, members = [LEON]) => {
    if (channels.some((c) => c.name === name)) throw new SlackError("x", "name_taken");
    const c: Channel = {
      id: `C${++seq}`,
      name,
      private: false,
      archived: false,
      members: new Set([LINEAR_BOT, ...members]),
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
    stars,
    posts,
    calls,
    sectionOf,
    order,
    addLeonChannel,
    addLinearChannel,
    addDm,
    say,
    failures,
  };
}

function setup(now = Date.UTC(2026, 10, 18, 20, 0)) {
  const slack = fakeSlack();
  const clock = { now };
  const linear = fakeLinear(
    (name) => slack.addLinearChannel(name),
    () => clock.now,
  );
  const store = new Store(memorySql());
  const sync = new Sync({
    config: loadConfig({ SLACK_LEON_USER_ID: LEON, SLACK_HERMES_USER_ID: HERMES }),
    store,
    linear: linear.api,
    bot: slack.bot,
    session: slack.session,
    now: () => clock.now,
    sleep: async () => {},
  });
  /** Runs every queued job that is due by the clock, as the Durable Object's alarm does. */
  const drain = async () => {
    for (let round = 0; round < 20; round++) {
      const jobs = store.dueJobs(clock.now, 50);
      if (!jobs.length) return;
      for (const job of jobs) {
        await sync.run(job.kind, JSON.parse(job.payload));
        store.finish(job.id);
      }
    }
    throw new Error("the queue never settled");
  };
  return { linear, slack, store, sync, clock, drain };
}

const issueHook = (id: string, action = "update") => ({ action, type: "Issue", data: { id } });
const commentHook = (id: string, action = "create") => ({ action, type: "Comment", data: { id } });
const projectHook = (id: string, action = "update") => ({ action, type: "Project", data: { id } });

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

const eyes = (channel: string, overrides: Record<string, unknown> = {}) => ({
  type: "reaction_added",
  user: HERMES,
  reaction: "eyes",
  item_user: LEON,
  item: { type: "message", channel, ts: "1794100000.000001" },
  ...overrides,
});

/** Hermes's own post, as its Slack app sends it: a bot message under its user, often in a thread. */
const hermesSays = (channel: string, text: string, overrides: Record<string, unknown> = {}) => ({
  type: "message",
  channel,
  user: HERMES,
  bot_id: "B0HERMES01",
  text,
  ts: "1794100100.000001",
  thread_ts: "1794100000.000001",
  ...overrides,
});

test("Hermes pinging Leon in an issue channel moves the issue to Awaiting Leon, without a second ping", async () => {
  const { linear, slack, sync } = setup();
  const issue = linear.addIssue(
    388,
    "restore the daily destination `{event: connector live, stop: 2026-12-01, owner: Leon}`",
    "Awaiting Listener",
  );
  await sync.run("linear", issueHook(issue.id, "create"));
  const channel = slack.channels[0]!;

  await sync.run("slack", hermesSays(channel.id, `<@${LEON}> please reauthorize the connector`));
  assert.equal(issue.state.name, "Awaiting Leon");
  assert.equal(
    issue.title,
    "restore the daily destination `{owner: Leon}`",
    "the listener's keys leave with it; others stay",
  );
  assert.equal(
    slack.posts.at(-1)!.text,
    "*Awaiting Listener* → *Awaiting Leon* (Hermes pinged Leon)",
    "Hermes's message already pinged Leon, so the move doesn't",
  );
  assert.equal(slack.sectionOf(channel.id), "Awaiting Leon");
  assert.equal(linear.created.length, 0, "Hermes's post isn't mirrored to Linear");

  // Linear's webhook for the move finds the channel already done.
  const posts = slack.posts.length;
  await sync.run("linear", issueHook(issue.id));
  assert.equal(slack.posts.length, posts);

  // Another ping while it's Awaiting Leon changes nothing.
  const updates = linear.updates.length;
  await sync.run("slack", hermesSays(channel.id, `<@${LEON}> reminder`, { ts: "2.2" }));
  assert.equal(linear.updates.length, updates);
  assert.equal(slack.posts.length, posts);

  // Moved to Hermes in Linear, Hermes's next ping hands it back, from any open status.
  issue.state = state("Awaiting Hermes");
  await sync.run("linear", issueHook(issue.id));
  await sync.run(
    "slack",
    hermesSays(channel.id, `Done on my side. <@${LEON}|leon>, can you confirm?`, {
      ts: "3.3",
      subtype: "thread_broadcast",
    }),
  );
  assert.equal(issue.state.name, "Awaiting Leon");
  assert.equal(
    slack.posts.at(-1)!.text,
    "*Awaiting Hermes* → *Awaiting Leon* (Hermes pinged Leon)",
  );
});

test("a ping that first shows up in Hermes's edit (a streamed reply) moves the issue, once per message", async () => {
  const { linear, slack, sync } = setup();
  const issue = linear.addIssue(9, "x", "Awaiting Hermes");
  await sync.run("linear", issueHook(issue.id, "create"));
  const channel = slack.channels[0]!.id;
  const edit = (text: string) => ({
    type: "message",
    subtype: "message_changed",
    channel,
    ts: "5.9",
    message: { ts: "5.1", user: HERMES, bot_id: "B0HERMES01", text },
  });

  await sync.run("slack", hermesSays(channel, "Checking", { ts: "5.1" }));
  assert.equal(issue.state.name, "Awaiting Hermes");
  await sync.run("slack", edit(`Checking. <@${LEON}> the connector needs you.`));
  assert.equal(issue.state.name, "Awaiting Leon");
  assert.equal(linear.created.length, 0, "Hermes's edit isn't mirrored either");

  // Leon hands it back; the stream's last edit of the same message doesn't take it again.
  issue.state = state("Awaiting Hermes");
  await sync.run("linear", issueHook(issue.id));
  const updates = linear.updates.length;
  await sync.run("slack", edit(`Checking. <@${LEON}> the connector needs you. Link: x`));
  assert.equal(issue.state.name, "Awaiting Hermes");
  assert.equal(linear.updates.length, updates);

  // A new message pings again.
  await sync.run("slack", hermesSays(channel, `<@${LEON}> one more thing`, { ts: "6.1" }));
  assert.equal(issue.state.name, "Awaiting Leon");
});

test("a Linear comment that pings Leon pings him in Slack and moves the issue to Awaiting Leon", async () => {
  const { linear, slack, sync } = setup();
  const issue = linear.addIssue(9, "x", "Executing");
  await sync.run("linear", issueHook(issue.id, "create"));
  const comment = (id: string, body: string) =>
    linear.comments.set(id, {
      id,
      body,
      issueId: issue.id,
      parentId: null,
      authorName: "Hermes",
      authorAvatar: null,
    });

  comment("c1", "Progress: drafted the email.");
  await sync.run("linear", commentHook("c1"));
  assert.equal(issue.state.name, "Executing", "a comment without a ping moves nothing");

  comment("c2", `<@${LEON}> can you approve the **draft**?`);
  await sync.run("linear", commentHook("c2"));
  assert.equal(slack.posts.at(-2)!.text, `<@${LEON}> can you approve the *draft*?`);
  assert.equal(slack.posts.at(-1)!.text, "*Executing* → *Awaiting Leon* (Hermes pinged Leon)");
  assert.equal(issue.state.name, "Awaiting Leon");

  // Leon hands it back; editing that comment doesn't take it again, a new pinging one does.
  issue.state = state("Executing");
  await sync.run("linear", issueHook(issue.id));
  comment("c2", `<@${LEON}> can you approve the draft? (typo fixed)`);
  await sync.run("linear", commentHook("c2", "update"));
  assert.equal(issue.state.name, "Executing");
  comment("c1", `Progress: drafted the email. <@${LEON}> one question.`);
  await sync.run("linear", commentHook("c1", "update"));
  assert.equal(issue.state.name, "Awaiting Leon", "an edit that adds a ping counts once");
});

test("Hermes's posts without a ping, others' pings and closed or waiting issues don't move", async () => {
  const { linear, slack, sync } = setup();
  const issue = linear.addIssue(9, "x", "Executing");
  await sync.run("linear", issueHook(issue.id, "create"));
  const channel = slack.channels[0]!.id;
  for (const event of [
    hermesSays(channel, "Working on it."),
    hermesSays(channel, `<@${HERMES}> note to self`),
    hermesSays(channel, `<@${LEON}> has joined`, { subtype: "channel_join" }),
    hermesSays("C-unmapped", `<@${LEON}> elsewhere`),
    { type: "message", channel, ts: "4.1", user: BOT, bot_id: "B0SYNC", text: `<@${LEON}>` },
    {
      type: "message",
      channel,
      ts: "4.2",
      user: LEON,
      text: `<@${LEON}> as Leon`,
      client_msg_id: "de1e6a7e-0000-4000-8000-000000000000",
    },
  ])
    await sync.run("slack", event);
  assert.equal(issue.state.name, "Executing");
  assert.equal(linear.updates.length, 0);

  // Awaiting Clarification already waits on Leon, so it stays.
  issue.state = state("Awaiting Clarification");
  await sync.run("linear", issueHook(issue.id));
  await sync.run("slack", hermesSays(channel, `<@${LEON}> which one?`));
  assert.equal(issue.state.name, "Awaiting Clarification");

  issue.state = state("Done");
  await sync.run("linear", issueHook(issue.id));
  await sync.run("slack", hermesSays(channel, `<@${LEON}> closed it`));
  assert.equal(issue.state.name, "Done", "a closed issue stays closed");
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

const updateHook = (id: string, updatedFrom: Record<string, unknown>) => ({
  ...issueHook(id),
  updatedFrom,
});

/** 00:00 Toronto on 2026-12-01. */
const DEC_1 = Date.UTC(2026, 11, 1, 5, 0);

test("an Awaiting Date issue starts when its timer goes off, not before", async () => {
  const { linear, slack, sync, clock, store, drain } = setup(DEC_1 - 3600_000);
  const dated = linear.addIssue(10, "File taxes `{start: 2026-12-01}`", "Awaiting Date");
  await sync.run("linear", issueHook(dated.id, "create"));
  assert.equal(store.timer(`timer:${dated.id}`), DEC_1, "midnight in Toronto");

  clock.now = DEC_1 - 1;
  await drain();
  assert.equal(dated.state.name, "Awaiting Date");

  clock.now = DEC_1;
  await drain();
  assert.equal(dated.state.name, "Awaiting Start");
  assert.equal(dated.title, "File taxes");
  assert.equal(store.timer(`timer:${dated.id}`), null, "nothing left to wait for");
  // Linear's webhook for the move then files the channel.
  await sync.run("linear", issueHook(dated.id));
  assert.equal(slack.sectionOf(store.issue(dated.id)!.channelId), "Awaiting Start");
});

test("an expired listener goes back to Leon with a comment, on its timer", async () => {
  const { linear, sync, clock, store, drain } = setup(DEC_1 - 60_000);
  const listener = linear.addIssue(
    205,
    "switch to rogers `{event: Rogers deal, stop: 2026-12-01T09:00:00-05:00}`",
    "Awaiting Listener",
  );
  await sync.run("linear", issueHook(listener.id, "create"));
  assert.equal(store.timer(`timer:${listener.id}`), Date.UTC(2026, 11, 1, 14, 0));

  clock.now = Date.UTC(2026, 11, 1, 14, 0);
  await drain();
  assert.equal(listener.state.name, "Awaiting Leon");
  assert.equal(listener.title, "switch to rogers");
  assert.match(
    linear.created.at(-1)!.body,
    /stop date \(2026-12-01T09:00:00-05:00\) passed .* Rogers deal/,
  );
});

test("a changed time replaces the timer, and leaving the status or closing clears it", async () => {
  const { linear, sync, clock, store, drain } = setup(DEC_1 - 86_400_000);
  const dated = linear.addIssue(10, "File taxes `{start: 2026-12-01}`", "Awaiting Date");
  await sync.run("linear", issueHook(dated.id, "create"));

  dated.title = "File taxes `{start: 2026-12-03}`";
  await sync.run("linear", issueHook(dated.id));
  assert.equal(store.timer(`timer:${dated.id}`), DEC_1 + 2 * 86_400_000);
  clock.now = DEC_1;
  await drain();
  assert.equal(dated.state.name, "Awaiting Date", "the old time no longer counts");

  dated.state = state("Executing");
  await sync.run("linear", issueHook(dated.id));
  assert.equal(store.timer(`timer:${dated.id}`), null, "a start only counts in Awaiting Date");

  dated.state = state("Awaiting Date");
  await sync.run("linear", issueHook(dated.id));
  dated.state = state("Done");
  await sync.run("linear", issueHook(dated.id));
  assert.equal(store.timer(`timer:${dated.id}`), null);
});

test("a due time in the title sets Linear's due date and posts in #feed-linear once, on time", async () => {
  const at = Date.UTC(2026, 11, 1, 22, 0); // 17:00 Toronto
  const { linear, slack, sync, clock, store, drain } = setup(at - 3600_000);
  const issue = linear.addIssue(
    401,
    "Send the invoice `{due: 2026-12-01T17:00:00-05:00}`",
    "Awaiting Leon",
  );
  await sync.run("linear", issueHook(issue.id, "create"));
  assert.equal(issue.dueDate, "2026-12-01", "Linear shows the day");
  assert.equal(store.timer(`timer:${issue.id}`), at);
  assert.ok(!slack.channels.some((c) => c.name === "feed-linear"), "made when first needed");

  clock.now = at;
  await drain();
  const feed = slack.channels.find((c) => c.name === "feed-linear")!;
  assert.equal(feed.private, false);
  assert.deepEqual([...feed.members].sort(), [BOT, HERMES, LEON].sort());
  const post = slack.posts.find((m) => m.channel === feed.id)!;
  assert.equal(
    post.text,
    `:date: Due: *<${issue.url}|LEON-401: Send the invoice>* · due Tue, Dec 1, 5:00 PM · Awaiting Leon · <#${store.issue(issue.id)!.channelId}>`,
  );
  assert.equal(store.timer(`timer:${issue.id}`), null);

  // Announced once: webhooks, the daily tick and another drain post nothing more.
  await sync.run("linear", issueHook(issue.id));
  await sync.run("tick", {});
  await drain();
  assert.equal(slack.posts.filter((m) => m.channel === feed.id).length, 1);
});

test("Linear's own due date alone goes off at midnight starting that day", async () => {
  const { linear, slack, sync, clock, store, drain } = setup(DEC_1 - 3600_000);
  const issue = linear.addIssue(402, "Renew passport", "Executing");
  issue.dueDate = "2026-12-01";
  await sync.run("linear", updateHook(issue.id, { dueDate: null }));
  assert.equal(store.timer(`timer:${issue.id}`), DEC_1);
  assert.equal(issue.title, "Renew passport", "the title is left alone");

  clock.now = DEC_1;
  await drain();
  assert.match(
    slack.posts.at(-1)!.text,
    /^:date: Due: .*LEON-402: Renew passport.* · due Tue, Dec 1 · Executing/,
  );
});

test("changing Linear's due date moves the title's due, keeping its time; clearing it drops it", async () => {
  const { linear, sync, store } = setup(DEC_1 - 86_400_000);
  const issue = linear.addIssue(403, "Pay rent `{due: 2026-12-01T17:00:00-05:00}`", "Executing");
  await sync.run("linear", issueHook(issue.id, "create"));
  assert.equal(issue.dueDate, "2026-12-01");

  // Leon picks Dec 3 in Linear's date picker.
  issue.dueDate = "2026-12-03";
  await sync.run("linear", updateHook(issue.id, { dueDate: "2026-12-01" }));
  assert.equal(issue.title, 'Pay rent `{due: "2026-12-03T17:00:00-05:00"}`');
  assert.equal(store.timer(`timer:${issue.id}`), Date.UTC(2026, 11, 3, 22, 0));
  // Its own webhook then finds the two agree.
  const writes = linear.updates.length;
  await sync.run("linear", updateHook(issue.id, { title: "Pay rent" }));
  assert.equal(linear.updates.length, writes);

  // Editing the title instead moves Linear's date.
  issue.title = "Pay rent `{due: 2026-12-05}`";
  await sync.run("linear", updateHook(issue.id, { title: "x" }));
  assert.equal(issue.dueDate, "2026-12-05");

  issue.dueDate = null;
  await sync.run("linear", updateHook(issue.id, { dueDate: "2026-12-05" }));
  assert.equal(issue.title, "Pay rent");
  assert.equal(store.timer(`timer:${issue.id}`), null);
});

test("an issue first seen past its due day or time says Overdue; earlier the same day, Due", async () => {
  const { linear, slack, sync, clock, drain } = setup(DEC_1 + 12 * 3600_000); // noon, Dec 1
  linear.addIssue(404, "Return library books `{due: 2026-12-01}`", "Awaiting Leon");
  linear.addIssue(405, "Call the bank `{due: 2026-12-01T09:00:00-05:00}`", "Awaiting Leon");
  await sync.run("tick", {});
  await drain();
  const text = (n: number) =>
    slack.posts.find((m) => m.text.startsWith(":date:") && m.text.includes(`LEON-${n}:`))!.text;
  assert.match(text(404), /^:date: Due: /, "still its day");
  assert.match(text(405), /^:date: Overdue: /, "three hours late");

  clock.now += 2 * 86_400_000;
  linear.addIssue(406, "Renew permit `{due: 2026-12-02}`", "Awaiting Leon");
  await sync.run("tick", {});
  await drain();
  assert.match(text(406), /^:date: Overdue: /);
});

test("the daily tick sets lost timers, repairs drift and creates #feed-linear", async () => {
  const { linear, slack, sync, clock, store, drain } = setup(DEC_1 + 60_000);
  const dated = linear.addIssue(10, "File taxes `{start: 2026-12-01}`", "Awaiting Date");
  const later = linear.addIssue(11, "Renew `{start: 2026-12-02}`", "Awaiting Date");
  await sync.run("backfill", {});
  // Timers lost (say, the queue was cleared): the tick sets them again.
  store.setTimer(`timer:${dated.id}`, "timer", null, null, clock.now);
  store.setTimer(`timer:${later.id}`, "timer", null, null, clock.now);

  await sync.run("tick", {});
  assert.ok(slack.channels.some((c) => c.name === "feed-linear"));
  assert.equal(store.timer(`timer:${later.id}`), DEC_1 + 86_400_000);
  await drain();
  assert.equal(dated.state.name, "Awaiting Start", "a time already past goes off at once");
  assert.equal(later.state.name, "Awaiting Date");

  // The move's webhook was missed: the next tick files the channel anyway.
  await sync.run("tick", {});
  assert.equal(slack.sectionOf(store.issue(dated.id)!.channelId), "Awaiting Start");
});

test("an open project gets a channel from Linear's Slack app, filed under Projects", async () => {
  const { linear, slack, sync, store } = setup();
  const project = linear.addProject("UofT Creators Club");
  await sync.run("linear", projectHook(project.id));

  assert.deepEqual(linear.channelRequests, [
    { projectId: project.id, name: "project-uoft-creators-club", integrationId: "int-slack" },
  ]);
  const channel = slack.channels.find((c) => c.id === project.slackChannelId)!;
  assert.equal(channel.name, "project-uoft-creators-club");
  assert.equal(channel.private, false);
  assert.deepEqual(
    [...channel.members].sort(),
    [LINEAR_BOT, LEON, HERMES].sort(),
    "Hermes is invited; the sync's own bot stays out",
  );
  assert.equal(slack.sectionOf(channel.id), "Projects");
  assert.equal(store.project(project.id)!.channelId, channel.id);
  assert.equal(slack.posts.length, 0, "Linear posts in its own channel; the sync doesn't");

  // A redelivered webhook changes nothing.
  await sync.run("linear", projectHook(project.id));
  assert.equal(linear.channelRequests.length, 1);
  assert.equal(slack.channels.length, 1);
});

test("a project that already has a Linear channel is adopted, and Leon joins it", async () => {
  const { linear, slack, sync } = setup();
  const channel = slack.addLinearChannel("project-agent-operations", []);
  const project = linear.addProject("Agent operations");
  project.slackChannelId = channel.id;
  await sync.run("linear", projectHook(project.id));

  assert.equal(linear.channelRequests.length, 0);
  assert.deepEqual([...channel.members].sort(), [LINEAR_BOT, LEON, HERMES].sort());
  assert.equal(slack.sectionOf(channel.id), "Projects");
});

test("project channels sit below the status sections", async () => {
  const { linear, slack, sync } = setup();
  await sync.run("linear", projectHook(linear.addProject("unduo.me").id));
  linear.addIssue(1, "task", "Executing");
  await sync.run("linear", issueHook("issue-1", "create"));
  linear.addIssue(2, "task", "Awaiting Leon");
  await sync.run("linear", issueHook("issue-2", "create"));
  assert.deepEqual(slack.order(), ["Awaiting Leon", "Executing", "Projects"]);
});

test("a new project waits for Linear's own channel before asking for one", async () => {
  const { linear, slack, sync, store, clock } = setup();
  const project = linear.addProject("Launch", "Backlog:backlog", clock.now - 60_000);
  await sync.run("linear", projectHook(project.id, "create"));
  assert.equal(linear.channelRequests.length, 0);
  assert.equal(store.dueJobs(clock.now, 10).length, 0, "nothing runs during the grace period");
  const [job] = store.dueJobs(project.createdAt + PROJECT_GRACE_MS, 10);
  assert.equal(job!.kind, "project");

  // Linear's "Create channel for new projects" made one meanwhile: the delayed check adopts it.
  const auto = slack.addLinearChannel("project-launch");
  project.slackChannelId = auto.id;
  clock.now = project.createdAt + PROJECT_GRACE_MS;
  await sync.run(job!.kind, JSON.parse(job!.payload));
  assert.equal(linear.channelRequests.length, 0);
  assert.equal(slack.sectionOf(auto.id), "Projects");

  // A project made through the API gets none from Linear, so the delayed check asks for it.
  const api = linear.addProject("From the API", "Planned:planned", clock.now);
  await sync.run("linear", projectHook(api.id, "create"));
  clock.now += PROJECT_GRACE_MS;
  await sync.run("project", { id: api.id });
  assert.equal(linear.channelRequests.at(-1)!.name, "project-from-the-api");
  assert.equal(slack.sectionOf(api.slackChannelId!), "Projects");
});

test("a taken name gets a suffix, and a slow channel is picked up later without asking twice", async () => {
  const { linear, slack, sync, store, clock } = setup();
  slack.addLeonChannel("project-unduo-me");
  linear.linearSide.slow = true;
  const project = linear.addProject("unduo.me");
  await sync.run("linear", projectHook(project.id));
  assert.equal(linear.channelRequests[0]!.name, "project-unduo-me-2");
  assert.equal(store.project(project.id)!.channelId, null);
  assert.equal(store.project(project.id)!.requestedAt, clock.now);

  await sync.run("tick", {});
  assert.equal(linear.channelRequests.length, 1, "no second request while the first is fresh");

  linear.finish();
  clock.now += 15 * 60_000;
  await sync.run("tick", {});
  assert.equal(linear.channelRequests.length, 1);
  assert.equal(slack.sectionOf(project.slackChannelId!), "Projects");
});

test("closing a project archives its channel; reopening unarchives it; deleting archives it", async () => {
  const { linear, slack, sync } = setup();
  const project = linear.addProject("Creator accounts and payouts");
  await sync.run("linear", projectHook(project.id));
  const channel = slack.channels.find((c) => c.id === project.slackChannelId)!;

  project.status = { name: "Completed", type: "completed" };
  await sync.run("linear", projectHook(project.id));
  assert.equal(channel.archived, true);
  assert.equal(slack.sectionOf(channel.id), null);
  assert.deepEqual(slack.order(), [], "the emptied Projects section is removed");

  project.status = { name: "In Progress", type: "started" };
  await sync.run("linear", projectHook(project.id));
  assert.equal(channel.archived, false);
  assert.equal(slack.sectionOf(channel.id), "Projects");
  assert.equal(linear.channelRequests.length, 1, "the same channel comes back");

  await sync.run("linear", projectHook(project.id, "remove"));
  assert.equal(channel.archived, true);
});

test("projects of other teams, and closed projects without a channel, are left alone", async () => {
  const { linear, slack, sync } = setup();
  const other = linear.addProject("Elsewhere");
  other.teamKeys = ["OTHER"];
  const closed = linear.addProject("School", "Canceled:canceled");
  await sync.run("linear", projectHook(other.id));
  await sync.run("linear", projectHook(closed.id));
  await sync.run("backfill", {});
  assert.equal(linear.channelRequests.length, 0);
  assert.equal(slack.channels.length, 0);
});

test("with project channels off in Linear, nothing is requested", async () => {
  const { linear, sync } = setup();
  linear.linearSide.settings = null;
  await sync.run("linear", projectHook(linear.addProject("Agent operations").id));
  assert.equal(linear.channelRequests.length, 0);
});

test("tick gives open projects channels and archives the ones that closed or vanished", async () => {
  const { linear, slack, sync } = setup();
  const a = linear.addProject("Agent operations");
  const b = linear.addProject("UofT Creators Club");
  await sync.run("tick", {});
  assert.equal(linear.channelRequests.length, 2);

  const channelB = slack.channels.find((c) => c.id === b.slackChannelId)!;
  linear.projects.delete(b.id);
  a.status = { name: "Canceled", type: "canceled" };
  await sync.run("tick", {});
  assert.equal(slack.channels.find((c) => c.id === a.slackChannelId)!.archived, true);
  assert.equal(channelB.archived, true);
});

/** 17:30 Toronto on 2026-11-19. */
const NOV_19_EVENING = Date.UTC(2026, 10, 19, 22, 30);

test("a day's project is left to dailylinear: no channel request, no section, no star", async () => {
  const { linear, slack, sync, store, clock } = setup(NOV_19_EVENING);
  const day = linear.addProject("20261119", "Backlog:backlog", NOV_19_EVENING - PROJECT_GRACE_MS);
  await sync.run("linear", projectHook(day.id));
  clock.now += PROJECT_GRACE_MS;
  await sync.run("project", { id: day.id });
  await sync.run("tick", {});
  assert.equal(linear.channelRequests.length, 0, "dailylinear asks for the day's channel");
  assert.equal(day.slackChannelId, null);

  // Once dailylinear's channel exists, the sync only makes sure Leon and Hermes are in it.
  const channel = slack.addLinearChannel("project-2026-11-19", []);
  day.slackChannelId = channel.id;
  slack.stars.add(channel.id);
  await sync.run("linear", projectHook(day.id));
  assert.deepEqual([...channel.members].sort(), [LINEAR_BOT, LEON, HERMES].sort());
  assert.equal(store.project(day.id)!.channelId, channel.id);
  assert.equal(slack.sectionOf(channel.id), null, "not filed under Projects");
  assert.ok(slack.stars.has(channel.id), "dailylinear's star stays");
  assert.equal(channel.name, "project-2026-11-19");

  const before = slack.calls.length;
  await sync.run("tick", {});
  assert.ok(
    !slack.calls
      .slice(before)
      .some((c) =>
        /^(stars\.|conversations\.rename|users\.channelSections\.channels)/.test(c.method),
      ),
    "settled: the tick leaves it alone",
  );
});

test("closing a day's project archives its channel", async () => {
  const { linear, slack, sync } = setup(NOV_19_EVENING);
  const channel = slack.addLinearChannel("project-2026-11-19");
  const day = linear.addProject("20261119");
  day.slackChannelId = channel.id;
  await sync.run("linear", projectHook(day.id));

  day.status = { name: "Completed", type: "completed" };
  await sync.run("linear", projectHook(day.id));
  assert.equal(channel.archived, true);
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

// ── autolinear's issues ──────────────────────────────────────────────────────

/** An issue autolinear made from a message, and the private channel it opened as Leon. */
async function autolinearIssue(t: ReturnType<typeof setup>, number = 401, title = "check rogers") {
  const id = await autolinearIssueId(`D0DM:1794000000.${number}`);
  const issue = t.linear.addIssue(
    number,
    title,
    "Awaiting Init",
    "**Leon in Slack** (a DM): hi",
    id,
  );
  const channel = t.slack.addLeonChannel(`leon-${number}-${title.replaceAll(" ", "-")}`);
  channel.members = new Set([LEON]);
  const adoption: Adoption = {
    issueId: id,
    identifier: issue.identifier,
    title,
    stateName: "Awaiting Init",
    channelId: channel.id,
    channelName: channel.name,
    sourceChannel: "D0DM",
    sourceTs: `1794000000.${number}`,
    lead: "From Leon's message in <https://x.slack.com/archives/D0DM/p1|a DM with Hermes>.",
  };
  return { issue, channel, adoption };
}

test("autolinear's issue waits for its channel's hand-over instead of getting a second one", async () => {
  const t = setup();
  const { slack, store, sync, drain } = t;
  const { issue, channel, adoption } = await autolinearIssue(t);

  // Linear's webhook for the new issue can come first: nothing is made.
  await sync.run("linear", issueHook(issue.id, "create"));
  assert.equal(slack.channels.length, 1);
  assert.equal(store.issue(issue.id), null);
  assert.ok(store.timer(`adopt-wait:${issue.id}`) === null, "a queued job, not a timer");

  await sync.adopt(adoption);
  assert.deepEqual([...channel.members].sort(), [BOT, HERMES, LEON].sort());
  const invites = slack.calls.filter((c) => c.method === "conversations.invite");
  assert.equal(invites.length, 1, "one invite for both");
  assert.equal(store.issueByChannel(channel.id)?.issueId, issue.id);

  await drain();
  const [intro] = slack.posts.filter((p) => p.channel === channel.id);
  assert.equal(
    intro!.text,
    `*<${issue.url}|LEON-401: check rogers>* · Awaiting Init\n\n${adoption.lead}`,
    "says where it came from and pings no one",
  );
  assert.equal(channel.topic, `Awaiting Init · ${issue.url}`);
  assert.equal(slack.sectionOf(channel.id), "Awaiting Init");

  // The webhook's second look, two minutes on, finds the channel adopted.
  t.clock.now += ADOPT_WAIT_MS;
  const posts = slack.posts.length;
  await drain();
  assert.equal(slack.channels.length, 1);
  assert.equal(slack.posts.length, posts);

  // Handing it over again changes nothing.
  await sync.adopt(adoption);
  await drain();
  assert.equal(slack.posts.length, posts);
});

test("if the hand-over never comes, the issue gets a channel two minutes on, adopting autolinear's", async () => {
  const t = setup();
  const { slack, store, sync, drain } = t;
  const { issue, channel } = await autolinearIssue(t);
  await sync.run("linear", issueHook(issue.id, "create"));
  await drain();
  assert.equal(store.issue(issue.id), null);

  t.clock.now += ADOPT_WAIT_MS;
  await drain();
  assert.equal(store.issue(issue.id)?.channelId, channel.id, "adopted by its number");
  assert.equal(slack.channels.length, 1);
});

test("an adopted reply brings its thread's first message; a project channel's message joins the project", async () => {
  const t = setup();
  const { linear, slack, sync, drain } = t;
  const project = linear.addProject("Taxes 2026", "In Progress:started");
  await sync.run("linear", projectHook(project.id, "create"));
  const projectChannel = slack.channels.find((c) => c.id === project.slackChannelId)!;
  const root = slack.say(projectChannel.id, HERMES, "File the T4 *now* or wait for the slip?");
  const { issue, channel, adoption } = await autolinearIssue(t);

  await sync.adopt({
    ...adoption,
    sourceChannel: projectChannel.id,
    sourceTs: "1794999999.000001",
    sourceThreadTs: root.ts,
  });
  await drain();
  const update = linear.updates.find((u) => u.id === issue.id)!.input;
  assert.equal(update.projectId, project.id);
  assert.equal(
    update.description,
    "**Leon in Slack** (a DM): hi\n\n" +
      `In reply to **Hermes** ([thread](https://leonsilicon.slack.com/archives/${projectChannel.id}/p${root.ts.replace(".", "")})):\n\n` +
      "> File the T4 **now** or wait for the slip?",
  );
  const intro = slack.posts.find((p) => p.channel === channel.id)!;
  assert.ok(intro.text.endsWith(`${adoption.lead}\n> File the T4 *now* or wait for the slip?`));
});

// ── Hermes's answers ─────────────────────────────────────────────────────────

const tsAt = (ms: number) => (ms / 1000).toFixed(6);

/** Leon writes in an issue channel now (by the clock); it's mirrored to Linear. Returns its ts. */
async function leonWrites(t: ReturnType<typeof setup>, channel: string, text: string) {
  const ts = tsAt(t.clock.now);
  await t.sync.run("slack", {
    type: "message",
    channel,
    user: LEON,
    text,
    ts,
    client_msg_id: `6a1c7d1e-0000-4000-8000-${ts.slice(-6)}000000`,
  });
  return ts;
}

/** Hermes posts in the channel now, at the top of it. */
const hermesPosts = (t: ReturnType<typeof setup>, channel: string, text: string) =>
  t.sync.run("slack", hermesSays(channel, text, { ts: tsAt(t.clock.now), thread_ts: undefined }));

/** Hermes reacts to Leon's message; the answer is judged once the settle time has passed. */
async function hermesReacts(
  t: ReturnType<typeof setup>,
  channel: string,
  ts: string,
  reaction = "white_check_mark",
) {
  await t.sync.run("slack", eyes(channel, { reaction, item: { type: "message", channel, ts } }));
  t.clock.now += ANSWER_SETTLE_MS;
  await t.drain();
}

async function issueChannel(t: ReturnType<typeof setup>, status = "Awaiting Init") {
  const issue = t.linear.addIssue(427, "testing autolinear", status);
  await t.sync.run("linear", issueHook(issue.id, "create"));
  t.clock.now += 60_000;
  return { issue, channel: t.slack.channels[0]! };
}

test("an answer that pings Leon leaves the issue with him; one that doesn't (to his thanks) closes it", async () => {
  const t = setup();
  const { issue, channel } = await issueChannel(t);

  const meal = await leonWrites(t, channel.id, "log 2 eggs and toast");
  await hermesReacts(t, channel.id, meal, "eyes");
  assert.equal(issue.state.name, "Awaiting Init", "nothing moves while Hermes works");
  t.clock.now += 4000;
  await hermesPosts(
    t,
    channel.id,
    `<@${LEON}> Logged: 410 kcal, 22 g protein, 30 g carbs, 20 g fat.`,
  );
  assert.equal(issue.state.name, "Awaiting Leon", "the ping hands it to Leon");
  await hermesReacts(t, channel.id, meal);
  assert.equal(issue.state.name, "Awaiting Leon");

  t.clock.now += 120_000;
  const thanks = await leonWrites(t, channel.id, "thanks");
  t.clock.now += 2000;
  await hermesPosts(t, channel.id, "You're welcome.");
  const posts = t.slack.posts.length;
  await hermesReacts(t, channel.id, thanks);
  assert.equal(issue.state.name, "Done");
  assert.equal(channel.archived, true);
  assert.equal(
    t.slack.posts
      .slice(posts)
      .map((p) => p.text)
      .join("\n"),
    "*Awaiting Leon* → *Done* (Hermes answered Leon's message without pinging him)",
  );
});

test("a new issue answered without a ping is done", async () => {
  const t = setup();
  const { issue, channel } = await issueChannel(t);
  const message = await leonWrites(t, channel.id, "what's the capital of Peru?");
  t.clock.now += 3000;
  await hermesPosts(t, channel.id, "Lima.");
  await hermesReacts(t, channel.id, message);
  assert.equal(issue.state.name, "Done");
});

test("an answer leaves the issue be when Hermes set its status, Leon wrote again, or it pinged in Linear", async () => {
  // Hermes moved it during its turn, even to Awaiting Leon without a ping.
  let t = setup();
  let { issue, channel } = await issueChannel(t);
  let message = await leonWrites(t, channel.id, "switch me to rogers once the deal is back");
  t.clock.now += 1000;
  await t.linear.api.updateIssue(issue.id, { stateId: "state-Awaiting Leon" });
  await hermesReacts(t, channel.id, message);
  assert.equal(issue.state.name, "Awaiting Leon");

  // Leon wrote again before Hermes finished: the later answer decides.
  t = setup();
  ({ issue, channel } = await issueChannel(t));
  message = await leonWrites(t, channel.id, "thanks");
  t.clock.now += 1000;
  await leonWrites(t, channel.id, "oh and one more thing");
  await hermesReacts(t, channel.id, message);
  assert.equal(issue.state.name, "Awaiting Init");

  // A ping in a Linear comment counts like one in Slack, even when it changes no status.
  t = setup();
  ({ issue, channel } = await issueChannel(t, "Awaiting Leon"));
  message = await leonWrites(t, channel.id, "did it go through?");
  t.clock.now += 1000;
  t.linear.comments.set("c-ping", {
    id: "c-ping",
    body: `<@${LEON}> it bounced, can you re-enter the card?`,
    issueId: issue.id,
    parentId: null,
    authorName: "Hermes",
    authorAvatar: null,
  });
  await t.sync.run("linear", commentHook("c-ping"));
  await hermesReacts(t, channel.id, message);
  assert.equal(issue.state.name, "Awaiting Leon");

  // Statuses Hermes owns stand: work in progress, waiting on others, on a listener, on a date.
  for (const status of ["Executing", "Awaiting Others", "Awaiting Listener", "Awaiting Hermes"]) {
    t = setup();
    ({ issue, channel } = await issueChannel(t, status));
    message = await leonWrites(t, channel.id, "any update?");
    t.clock.now += 1000;
    await hermesPosts(t, channel.id, "Still waiting on Rogers.");
    await hermesReacts(t, channel.id, message);
    assert.equal(issue.state.name, status);
  }
});

test("a failed turn goes to Leon with a mention", async () => {
  const t = setup();
  const { issue, channel } = await issueChannel(t);
  const message = await leonWrites(t, channel.id, "book the dentist");
  await hermesReacts(t, channel.id, message, "x");
  assert.equal(issue.state.name, "Awaiting Leon");
  assert.equal(
    t.slack.posts.at(-1)!.text,
    `*Awaiting Init* → *Awaiting Leon* (Hermes's turn on Leon's message failed)\n<@${LEON}>`,
  );
});

test("👀, other reactions, other people's and other messages' reactions, and other channels move nothing", async () => {
  const t = setup();
  const { issue, channel } = await issueChannel(t);
  const message = await leonWrites(t, channel.id, "hello");
  const item = { type: "message", channel: channel.id, ts: message };
  for (const event of [
    eyes(channel.id, { item }),
    eyes(channel.id, { reaction: "tada", item }),
    eyes(channel.id, { reaction: "white_check_mark", user: LEON, item }),
    eyes(channel.id, { reaction: "white_check_mark", item_user: BOT, item }),
    eyes(channel.id, { reaction: "white_check_mark", item: { type: "file", channel: channel.id } }),
    eyes("C-unmapped", { reaction: "white_check_mark", item: { ...item, channel: "C-unmapped" } }),
  ])
    await t.sync.run("slack", event);
  t.clock.now += ANSWER_SETTLE_MS;
  await t.drain();
  assert.equal(issue.state.name, "Awaiting Init");
  assert.equal(t.linear.updates.length, 0);
});
