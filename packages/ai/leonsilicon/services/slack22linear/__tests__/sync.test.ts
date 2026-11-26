import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { loadConfig } from "#config";
import { issueWorkflow } from "#format";
import { IssueMetadata } from "#issue-metadata";
import type {
  IssueUpdate,
  LinearApi,
  LinearComment,
  LinearIssue,
  LinearProject,
  NewIssue,
  ProjectChannelSettings,
} from "#linear";
import { SlackError, type SlackCall, type SlackParams } from "#slack";
import { Store, type Sql, type SqlValue } from "#store";
import {
  ADOPT_WAIT_MS,
  ANSWER_SETTLE_MS,
  autolinearIssueId,
  COMMAND_SETTLE_MS,
  EXECUTING_MS,
  LEASE_MS,
  MAX_REMINDERS,
  PROJECT_GRACE_MS,
  readMuseAnswer,
  readTurns,
  STUCK_MS,
  Sync,
  UNSEEN_GIVE_UP_MS,
  UNSEEN_MS,
  type Adoption,
  type CommandJob,
} from "#sync";

const LEON = "U0LEON00001";
const HERMES = "U0HERMES001";
const BOT = "U0SYNCBOT1";
/** Autolinear's bot, which Hermes tells what to do with a channel. */
const AUTO = "U0AUTOLIN01";
/** Linear's own Slack app, which creates and owns project channels. */
const LINEAR_BOT = "U0LINEARBOT";

const STATES: LinearIssue["state"][] = [
  "Awaiting Init:unstarted",
  "Awaiting Clarification:backlog",
  "Awaiting Date:unstarted",
  "Awaiting Start:unstarted",
  "Executing:started",
  "Awaiting Hermes:started",
  "Awaiting Leon:started",
  "Awaiting Trigger:started",
  "Done:completed",
  "Canceled:canceled",
].map((s) => {
  const [name, type] = s.split(":") as [string, string];
  return { id: `state-${name}`, name, type, color: type === "started" ? "#f2c94c" : "#5e6ad2" };
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
        priority: 0,
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
      if ("dueDate" in input) issue.dueDate = input.dueDate ?? null;
      if ("description" in input) issue.description = input.description ?? null;
    },
    project: async (id) => projects.get(id) ?? null,
    openProjects: async (team, closed) =>
      [...projects.values()].filter(
        (p) => p.teamKeys.includes(team) && !p.gone && !closed.includes(p.status.type),
      ),
    closedProjectChannels: async (team, closed) =>
      [...projects.values()].flatMap((p) =>
        p.slackChannelId && p.teamKeys.includes(team) && (p.gone || closed.includes(p.status.type))
          ? [p.slackChannelId]
          : [],
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
      priority: 0,
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
  const reactions: { channel: string; ts: string; name: string; by: string }[] = [];
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
    (who: "bot" | "leon" | "autolinear"): SlackCall =>
    async (method, params = {}) => {
      calls.push({ who, method, params });
      const failure = failures.findIndex((f) => f.who === who && f.method === method);
      if (failure >= 0) throw new SlackError(method, failures.splice(failure, 1)[0]!.code);
      const me = who === "bot" ? BOT : who === "autolinear" ? AUTO : LEON;
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
              .map((c) => ({
                id: c.id,
                name: c.name,
                is_archived: c.archived,
                is_private: c.private,
              })),
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
        case "reactions.get": {
          const c = find(params.channel);
          member(c);
          const message = posts.find((p) => p.channel === c.id && p.ts === params.timestamp);
          if (!message) throw new SlackError(method, "message_not_found");
          return { ok: true, message: structuredClone(message) };
        }
        case "reactions.add": {
          const c = find(params.channel);
          member(c);
          if (c.archived) throw new SlackError(method, "is_archived");
          const reaction = {
            channel: c.id,
            ts: String(params.timestamp),
            name: String(params.name),
          };
          if (
            reactions.some(
              (r) => JSON.stringify({ ...r, by: who }) === JSON.stringify({ ...reaction, by: who }),
            )
          )
            throw new SlackError(method, "already_reacted");
          reactions.push({ ...reaction, by: who });
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
              : { id: c.id, name: c.name, is_private: c.private, topic: { value: c.topic } },
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
    autolinear: client("autolinear"),
    channels,
    sections,
    stars,
    posts,
    reactions,
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
  const sql = memorySql();
  const store = new Store(sql);
  const issueMetadata = new IssueMetadata(sql);
  /** What Leon's `/autolinear` was told, through Slack's response URL. */
  const responses: { url: string; text: string }[] = [];
  /** What the sync logged, as [event, fields]. */
  const logs: [string, Record<string, unknown> | undefined][] = [];
  const sync = new Sync({
    config: loadConfig({
      SLACK_LEON_USER_ID: LEON,
      SLACK_HERMES_USER_ID: HERMES,
      AUTOLINEAR_BOT_USER_ID: AUTO,
    }),
    store,
    issueMetadata,
    linear: linear.api,
    bot: slack.bot,
    session: slack.session,
    autolinear: slack.autolinear,
    respond: async (url, text) => {
      responses.push({ url, text });
    },
    now: () => clock.now,
    sleep: async () => {},
    log: (event, fields) => logs.push([event, fields]),
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
  return { linear, slack, store, sync, clock, drain, responses, issueMetadata, logs };
}

const issueHook = (id: string, action = "update") => ({ action, type: "Issue", data: { id } });
const commentHook = (id: string, action = "create") => ({ action, type: "Comment", data: { id } });
const projectHook = (id: string, action = "update") => ({ action, type: "Project", data: { id } });

test("a new issue gets a public channel, an intro and its status section", async () => {
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
  assert.equal(channel.private, false);
  assert.deepEqual([...channel.members].sort(), [AUTO, BOT, HERMES, LEON].sort());
  assert.equal(channel.topic, "");
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
  channel.topic = "Notes from Slack";

  issue.state = state("Awaiting Leon");
  await sync.run("linear", issueHook(issue.id));
  assert.equal(slack.posts.at(-1)!.text, `*Executing* → *Awaiting Leon*\n<@${LEON}>`);
  assert.equal(slack.sectionOf(channel.id), "Awaiting Leon");
  assert.deepEqual(slack.order(), ["Awaiting Leon"], "the emptied Executing section is removed");

  issue.state = state("Awaiting Trigger");
  issue.title = "switch to rogers `{event: Rogers unlimited BYOD deal, stop: 2026-12-01}`";
  await sync.run("linear", issueHook(issue.id));
  assert.equal(slack.posts.at(-1)!.text, "*Awaiting Leon* → *Awaiting Trigger*");
  assert.equal(channel.topic, "Notes from Slack");
  assert.equal(
    channel.name,
    "leon-205-switch-to-rogers",
    "metadata alone doesn't rename the channel",
  );

  issue.state = state("Done");
  await sync.run("linear", issueHook(issue.id));
  assert.equal(slack.posts.at(-1)!.text, "*Awaiting Trigger* → *Done*");
  assert.equal(channel.topic, "Notes from Slack");
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

test("title edits keep the original channel and a new follow-up gets its own channel", async () => {
  const { linear, slack, store, sync } = setup();
  const original = linear.addIssue(55, "Apply for Wispr Flow student discount", "Executing");
  await sync.run("linear", issueHook(original.id, "create"));
  const originalChannel = store.issue(original.id)!.channelId;

  original.title =
    "[AWAITING: Grok Bot Slack delivery configuration] Apply for Wispr Flow student discount";
  await sync.run("linear", issueHook(original.id));
  original.title = "[AWAITING: Wispr support ticket 281896] Apply for Wispr Flow student discount";
  await sync.run("linear", issueHook(original.id));

  const followUp = linear.addIssue(
    56,
    "Follow up on Wispr support ticket 281896",
    "Awaiting Trigger",
  );
  await sync.run("linear", issueHook(followUp.id, "create"));

  assert.equal(
    slack.calls.some(({ method }) => method === "conversations.rename"),
    false,
  );
  assert.equal(store.issue(original.id)!.channelId, originalChannel);
  assert.equal(slack.channels[0]!.name, "leon-55-apply-for-wispr-flow-student-discount");
  assert.equal(slack.channels[1]!.name, "leon-56-follow-up-on-wispr-support-ticket-281896");
});

test("sections are created in the configured order", async () => {
  const { linear, slack, sync } = setup();
  for (const [n, s] of [
    [1, "Executing"],
    [2, "Awaiting Date"],
    [3, "Awaiting Leon"],
    [4, "Awaiting Trigger"],
  ] as const) {
    linear.addIssue(n, `task ${n}`, s);
    await sync.run("linear", issueHook(`issue-${n}`, "create"));
  }
  assert.deepEqual(slack.order(), [
    "Awaiting Leon",
    "Awaiting Trigger",
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

test("a Linear comment that pings Leon pings him in Slack and moves nothing", async () => {
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

  comment("c1", `<@${LEON}> can you approve the **draft**?`);
  await sync.run("linear", commentHook("c1"));
  assert.equal(slack.posts.at(-1)!.text, `<@${LEON}> can you approve the *draft*?`);
  comment("c1", `<@${LEON}> can you approve the draft? (typo fixed)`);
  await sync.run("linear", commentHook("c1", "update"));
  assert.equal(slack.posts.at(-1)!.text, `<@${LEON}> can you approve the draft? (typo fixed)`);
  assert.equal(issue.state.name, "Executing");
  assert.equal(linear.updates.length, 0);
});

test("Hermes's posts move nothing without a command, its pings to Leon included", async () => {
  const { linear, slack, sync, clock, drain } = setup();
  const issue = linear.addIssue(9, "x", "Executing");
  await sync.run("linear", issueHook(issue.id, "create"));
  const channel = slack.channels[0]!.id;
  for (const event of [
    hermesSays(channel, "Working on it."),
    hermesSays(channel, `<@${LEON}> please reauthorize the connector`),
    hermesSays(channel, `Done on my side. <@${LEON}|leon>, can you confirm?`, {
      ts: "3.3",
      subtype: "thread_broadcast",
    }),
    {
      type: "message",
      subtype: "message_changed",
      channel,
      ts: "5.9",
      message: { ts: "5.1", user: HERMES, bot_id: "B0HERMES01", text: `<@${LEON}> look` },
    },
    hermesSays(channel, `<@${HERMES}> note to self`),
    hermesSays(channel, `I'll tell <@${AUTO}> later`),
    hermesSays(channel, `<@${AUTO}> move done`, { subtype: "channel_join" }),
    hermesSays("C-unmapped", `<@${AUTO}> move done`),
    {
      type: "message",
      channel,
      ts: "4.1",
      user: BOT,
      bot_id: "B0SYNC",
      text: `<@${AUTO}> move done`,
    },
    {
      type: "message",
      channel,
      ts: "4.2",
      user: LEON,
      text: `<@${AUTO}> move done`,
      client_msg_id: "de1e6a7e-0000-4000-8000-000000000000",
    },
  ])
    await sync.run("slack", event);
  clock.now += COMMAND_SETTLE_MS;
  await drain();
  assert.equal(issue.state.name, "Executing");
  assert.equal(linear.updates.length, 0);
  assert.equal(linear.created.length, 0, "Hermes's posts aren't mirrored to Linear");
  assert.equal(slack.reactions.length, 0);
});

test("backfill adopts existing issue channels quietly and archives closed ones", async () => {
  const { linear, slack, sync, store } = setup();
  const open = slack.addLeonChannel("leon-315-migrate-instagram-payout-setup-from-us-to");
  const closed = slack.addLeonChannel("leon-5-get-uoft-creators-recognized-at-utsc");
  const other = slack.addLeonChannel("general");
  open.topic = "Notes from Slack";
  linear.addIssue(315, "Migrate Instagram payout setup from US to Canada", "Awaiting Leon");
  linear.addIssue(5, "Get UofT Creators recognized at UTSC", "Done");
  linear.addIssue(379, "Create UofT Creators Club membership signup form", "Awaiting Start");

  await sync.run("backfill", {});
  assert.equal(store.issue("issue-315")!.channelId, open.id);
  assert.ok(open.members.has(BOT));
  assert.equal(slack.sectionOf(open.id), "Awaiting Leon");
  assert.equal(open.topic, "Notes from Slack");
  assert.equal(closed.archived, true);
  assert.equal(other.archived, false);
  const created = slack.channels.find((c) => c.name.startsWith("leon-379-"))!;
  assert.equal(slack.sectionOf(created.id), "Awaiting Start");
  assert.ok(
    slack.posts.every(({ channel }) => ![open.id, closed.id, created.id].includes(channel)),
  );
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
  assert.equal(dated.title, "File taxes `{start: 2026-12-01}`");
  assert.deepEqual(issueWorkflow(dated), {});
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
    "Awaiting Trigger",
  );
  await sync.run("linear", issueHook(listener.id, "create"));
  assert.equal(store.timer(`timer:${listener.id}`), Date.UTC(2026, 11, 1, 14, 0));

  clock.now = Date.UTC(2026, 11, 1, 14, 0);
  await drain();
  assert.equal(listener.state.name, "Awaiting Leon");
  assert.equal(
    listener.title,
    "switch to rogers `{event: Rogers deal, stop: 2026-12-01T09:00:00-05:00}`",
  );
  assert.deepEqual(issueWorkflow(listener), {});
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
  const issue = linear.addIssue(402, "Renew passport", "Awaiting Leon");
  issue.dueDate = "2026-12-01";
  await sync.run("linear", updateHook(issue.id, { dueDate: null }));
  assert.equal(store.timer(`timer:${issue.id}`), DEC_1);
  assert.equal(issue.title, "Renew passport", "the title is left alone");

  clock.now = DEC_1;
  await drain();
  assert.match(
    slack.posts.at(-1)!.text,
    /^:date: Due: .*LEON-402: Renew passport.* · due Tue, Dec 1 · Awaiting Leon/,
  );
});

test("changing Linear's due date preserves the title and time of day; clearing it drops the timer", async () => {
  const { linear, sync, store } = setup(DEC_1 - 86_400_000);
  const title = "Pay rent `{due: 2026-12-01T17:00:00-05:00}`";
  const issue = linear.addIssue(403, title, "Executing", "Use the usual payment method.");
  await sync.run("linear", issueHook(issue.id, "create"));
  assert.equal(issue.dueDate, "2026-12-01");

  // Leon picks Dec 3 in Linear's date picker.
  issue.dueDate = "2026-12-03";
  await sync.run("linear", updateHook(issue.id, { dueDate: "2026-12-01" }));
  assert.equal(issue.title, title);
  assert.match(issue.description!, /^Use the usual payment method\./);
  assert.equal(issueWorkflow(issue).due, "2026-12-03T17:00:00-05:00");
  assert.equal(store.timer(`timer:${issue.id}`), Date.UTC(2026, 11, 3, 22, 0));
  // Its own webhook then finds the two agree.
  const writes = linear.updates.length;
  await sync.run("linear", updateHook(issue.id, { description: "Use the usual payment method." }));
  assert.equal(linear.updates.length, writes);

  issue.dueDate = null;
  await sync.run("linear", updateHook(issue.id, { dueDate: "2026-12-03" }));
  assert.equal(issue.title, title);
  assert.equal(issueWorkflow(issue).due, undefined);
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

test("the daily tick refreshes issue metadata without rewriting a legacy topic or posting", async () => {
  const { linear, slack, sync, store, issueMetadata } = setup();
  const issue = linear.addIssue(381, "File taxes `{start: 2026-12-01}`", "Awaiting Date");
  issue.priority = 2;
  await sync.run("backfill", {});
  const rec = store.issue(issue.id)!;
  const channel = slack.channels.find(({ id }) => id === rec.channelId)!;
  const legacyTopic = `Awaiting Date · linear:v1 unstarted #5e6ad2 p2 · ${issue.url} · ${issue.title}`;
  channel.topic = legacyTopic;
  store.putIssue({ ...rec, topic: legacyTopic });

  issue.state = { ...issue.state, color: "#123456" };
  await sync.run("tick", {});
  assert.equal(JSON.parse(issueMetadata.snapshot())[0].statusColor, "#123456");
  issue.priority = 4;
  await sync.run("linear", issueHook(issue.id));
  assert.equal(JSON.parse(issueMetadata.snapshot())[0].priority, 4);
  issue.priority = 0;
  await sync.run("tick", {});
  assert.equal(JSON.parse(issueMetadata.snapshot())[0].priority, 0);

  assert.equal(channel.topic, legacyTopic);
  assert.equal(slack.posts.filter((post) => post.channel === channel.id).length, 0);
  assert.ok(!slack.calls.some(({ method }) => method === "conversations.setTopic"));
});

test("Matrix publishing backfills and updates the full issue record without changing Slack topics", async () => {
  const { linear, slack, sync, store, issueMetadata } = setup();
  const longTitle = "Full title ".repeat(35).trim();
  const issue = linear.addIssue(381, longTitle + " `{due: 2026-12-01}`", "Awaiting Leon");
  issue.dueDate = "2026-12-01";
  await sync.run("backfill", {});
  const { channelId } = store.issue(issue.id)!;
  const snapshot = () => JSON.parse(issueMetadata.snapshot());
  assert.deepEqual(snapshot(), [
    {
      version: 1,
      channelId,
      identifier: "LEON-381",
      title: longTitle,
      statusName: "Awaiting Leon",
      statusType: "started",
      statusColor: issue.state.color,
      priority: issue.priority,
      url: issue.url,
      dueDate: "2026-12-01",
      meta: { due: "2026-12-01" },
    },
  ]);

  issue.priority = 2;
  await sync.run("tick", {});
  assert.equal(snapshot()[0].priority, 2);
  issue.state = state("Done");
  await sync.run("linear", issueHook(issue.id));
  assert.equal(snapshot()[0].statusType, "completed");
  assert.equal(store.issue(issue.id)?.archived, true);
  await sync.run("linear", issueHook(issue.id, "remove"));
  assert.deepEqual(snapshot(), [{ version: 1, channelId, identifier: "LEON-381", deleted: true }]);
  assert.equal(slack.calls.filter(({ method }) => method === "conversations.setTopic").length, 0);
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
  assert.equal(slack.posts.filter((post) => post.channel === channel.id).length, 0);

  // A redelivered webhook changes nothing.
  await sync.run("linear", projectHook(project.id));
  assert.equal(linear.channelRequests.length, 1);
  assert.equal(slack.channels.filter(({ name }) => name.startsWith("project-")).length, 1);
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

test("project webhooks and daily reconciliation save appearance for Matrix without writing Slack topics", async () => {
  const { linear, slack, sync, store } = setup();
  const channel = slack.addLinearChannel("project-university");
  channel.topic = "Course planning";
  const project = linear.addProject("University");
  project.slackChannelId = channel.id;
  project.color = "#E99B51";
  project.icon = null;

  await sync.run("linear", projectHook(project.id));
  assert.deepEqual(store.projectAppearances(), [
    { channelId: channel.id, color: "#e99b51", icon: null },
  ]);
  assert.equal(channel.topic, "Course planning");

  // Linear's Slack app can update the summary independently of our webhook.
  channel.topic = "Fall semester planning";
  project.icon = "IconBook";
  project.color = "#5e6ad2";
  await sync.run("tick", {});
  assert.deepEqual(store.projectAppearances(), [
    { channelId: channel.id, color: "#5e6ad2", icon: "IconBook" },
  ]);

  const replacement = slack.addLinearChannel("project-university-2");
  project.slackChannelId = replacement.id;
  await sync.run("linear", projectHook(project.id));
  assert.deepEqual(store.projectAppearances(), [
    { channelId: channel.id, color: null, icon: null },
    { channelId: replacement.id, color: "#5e6ad2", icon: "IconBook" },
  ]);
  project.icon = null;
  project.color = undefined;
  await sync.run("tick", {});
  assert.deepEqual(store.projectAppearances(), [
    { channelId: channel.id, color: null, icon: null },
    { channelId: replacement.id, color: null, icon: null },
  ]);
  assert.equal(channel.topic, "Fall semester planning");
  assert.ok(!slack.calls.some(({ method }) => method === "conversations.setTopic"));
  assert.equal(slack.posts.filter((post) => post.channel === channel.id).length, 0);
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

test("project visibility syncs existing archives, completed projects, and reopened channels", async () => {
  const { linear, slack, store, sync } = setup();
  assert.equal(store.projectVisibility(), null);
  const archived = slack.addLinearChannel("project-manually-archived");
  archived.archived = true;
  const unrelated = slack.addLeonChannel("general-old");
  unrelated.archived = true;
  const completed = slack.addLinearChannel("project-completed");
  const project = linear.addProject("Completed project", "Done:completed");
  project.slackChannelId = completed.id;

  await sync.run("project-visibility", {});
  assert.deepEqual(store.projectVisibility(), [archived.id, completed.id].sort());
  assert.equal(completed.archived, false, "The snapshot reads Linear even before Slack archives");
  assert.equal(slack.posts.length, 0);

  archived.archived = false;
  project.status = { name: "Started", type: "started" };
  await sync.run("linear", projectHook(project.id));
  assert.deepEqual(store.projectVisibility(), []);
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
  assert.equal(slack.channels.filter(({ name }) => name.startsWith("project-")).length, 0);
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
  day.color = "#f2c94c";
  slack.stars.add(channel.id);
  await sync.run("linear", projectHook(day.id));
  assert.deepEqual([...channel.members].sort(), [LINEAR_BOT, LEON, HERMES].sort());
  assert.equal(store.project(day.id)!.channelId, channel.id);
  assert.deepEqual(store.projectAppearances(), [
    { channelId: channel.id, color: "#f2c94c", icon: null },
  ]);
  assert.ok(!slack.calls.some(({ method }) => method === "conversations.setTopic"));
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
  assert.deepEqual([...channel.members].sort(), [AUTO, BOT, HERMES, LEON].sort());
  const invites = slack.calls.filter((c) => c.method === "conversations.invite");
  assert.equal(invites.length, 1, "one invite for all three");
  assert.equal(store.issueByChannel(channel.id)?.issueId, issue.id);

  await drain();
  const [intro] = slack.posts.filter((p) => p.channel === channel.id);
  assert.equal(
    intro!.text,
    `*<${issue.url}|LEON-401: check rogers>* · Awaiting Init\n\n${adoption.lead}`,
    "says where it came from and pings no one",
  );
  assert.equal(channel.topic, "");
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

const autolinearReactions = (t: ReturnType<typeof setup>, ts: string) =>
  t.slack.reactions.filter((r) => r.by === "autolinear" && r.ts === ts).map((r) => r.name);

test("Hermes's 👀 files the channel under Executing and reacts on Leon's message", async () => {
  const t = setup();
  const { issue, channel } = await issueChannel(t);
  assert.equal(t.slack.sectionOf(channel.id), "Awaiting Init");
  const message = await leonWrites(t, channel.id, "what's on my calendar tomorrow?");
  const posts = t.slack.posts.length;
  // Straight from the event, with no settle time: Leon watches the sidebar.
  await t.sync.run(
    "slack",
    eyes(channel.id, { item: { type: "message", channel: channel.id, ts: message } }),
  );
  assert.equal(issue.state.name, "Executing");
  assert.equal(t.slack.sectionOf(channel.id), "Executing");
  assert.ok(!t.slack.order().includes("Awaiting Init"), "the emptied section is gone");
  assert.equal(t.slack.posts.length, posts);
  assert.deepEqual(autolinearReactions(t, message), ["gear"]);

  // A second 👀 (Leon wrote again) moves nothing more.
  t.clock.now += 1000;
  const again = await leonWrites(t, channel.id, "and the day after?");
  await t.sync.run(
    "slack",
    eyes(channel.id, { item: { type: "message", channel: channel.id, ts: again } }),
  );
  assert.equal(t.slack.posts.length, posts);
  assert.deepEqual(autolinearReactions(t, again), []);

  // Linear's webhook for the move finds nothing left to do.
  await t.sync.run("linear", issueHook(issue.id));
  assert.equal(t.slack.posts.length, posts);
  assert.equal(t.slack.reactions.length, 1);
});

test("the Linear webhook retries the automatic move reaction on the exact Slack reply", async () => {
  const t = setup();
  const { issue, channel } = await issueChannel(t);
  const parent = t.slack.say(channel.id, LEON, "Original message");
  const reply = t.slack.say(channel.id, LEON, "Follow-up", { thread_ts: parent.ts });
  const reaction = eyes(channel.id, {
    item: { type: "message", channel: channel.id, ts: reply.ts },
  });
  const posts = t.slack.posts.length;
  t.slack.failures.push({ who: "autolinear", method: "reactions.add", code: "ratelimited" });
  await assert.rejects(t.sync.run("slack", reaction), /ratelimited/);
  assert.equal(issue.state.name, "Executing");
  assert.deepEqual(t.slack.reactions, []);
  await t.sync.run("linear", issueHook(issue.id));
  await t.sync.run("slack", reaction);
  assert.equal(t.slack.posts.length, posts);
  assert.deepEqual(autolinearReactions(t, reply.ts), ["gear"]);
  assert.deepEqual(autolinearReactions(t, parent.ts), []);
});

test("an explicit move to Executing in an edited Hermes reply is silent", async () => {
  const t = setup();
  const { issue, channel } = await issueChannel(t);
  const parent = t.slack.say(channel.id, LEON, "Original message");
  const reply = t.slack.say(channel.id, HERMES, "Working on it", { thread_ts: parent.ts });
  const posts = t.slack.posts.length;
  await t.sync.run("slack", {
    type: "message",
    subtype: "message_changed",
    channel: channel.id,
    message: { ...reply, text: `<@${AUTO}> move executing` },
  });
  t.clock.now += COMMAND_SETTLE_MS;
  await t.drain();
  assert.equal(issue.state.name, "Executing");
  assert.equal(t.slack.sectionOf(channel.id), "Executing");
  assert.equal(t.slack.posts.length, posts);
  assert.deepEqual(t.slack.reactions, []);
});

test("a retried closing command archives the channel silently", async () => {
  const t = setup();
  const { issue, channel } = await issueChannel(t, "Executing");
  const text = `<@${AUTO}> move done`;
  const { ts } = t.slack.say(channel.id, HERMES, text);
  const posts = t.slack.posts.length;
  const job: CommandJob = { channel: channel.id, ts, text, by: "hermes" };
  t.slack.failures.push(
    { who: "bot", method: "conversations.archive", code: "ratelimited" },
    { who: "leon", method: "conversations.archive", code: "ratelimited" },
  );
  await assert.rejects(t.sync.run("command", job), /ratelimited/);
  assert.equal(issue.state.name, "Done");
  assert.equal(channel.archived, false);

  await t.sync.run("linear", issueHook(issue.id));
  await t.sync.run("command", job);
  assert.deepEqual(t.slack.reactions, []);
  assert.equal(t.linear.updates.length, 1);
  assert.equal(t.slack.posts.length, posts);
  assert.equal(channel.archived, true);
  assert.equal(t.store.commandMove(issue.id), null);
});

/** Hermes's command for Autolinear, at the end of a post of its own, read once the settle time has passed. */
async function hermesCommands(
  t: ReturnType<typeof setup>,
  channel: string,
  line: string,
  answer = "",
) {
  const ts = tsAt(t.clock.now);
  const text = `${answer ? `${answer}\n\n` : ""}<@${AUTO}> ${line}`;
  await t.sync.run("slack", hermesSays(channel, text, { ts, thread_ts: undefined }));
  t.clock.now += COMMAND_SETTLE_MS;
  await t.drain();
  return ts;
}

/** What Autolinear's bot posted, after the first `from` posts. */
const autolinearPosts = (t: ReturnType<typeof setup>, from = 0) =>
  t.slack.posts.slice(from).filter((p) => p.user === AUTO);

test("Hermes's answer moves nothing; Autolinear reminds it, and its command moves the issue", async () => {
  const t = setup();
  const { issue, channel } = await issueChannel(t);
  const thanks = await leonWrites(t, channel.id, "thanks");
  await hermesReacts(t, channel.id, thanks, "eyes");
  assert.equal(issue.state.name, "Executing", "👀 still shows Hermes has it");
  t.clock.now += 2000;
  await hermesPosts(t, channel.id, "You're welcome.");
  const posts = t.slack.posts.length;
  await hermesReacts(t, channel.id, thanks);
  assert.equal(issue.state.name, "Executing", "the answer alone moves nothing");
  assert.equal(channel.archived, false);
  const [reminder, ...more] = autolinearPosts(t, posts);
  assert.equal(more.length, 0);
  assert.ok(
    reminder!.text.startsWith(
      `<@${HERMES}> Your turn here is over, but you haven't told me what to do with LEON-427, which is *Executing*. Before your :eyes: it was *Awaiting Init*. Answer with a line of its own that starts with my mention:\n`,
    ),
    reminder!.text,
  );
  assert.ok(reminder!.text.includes("• `@Autolinear move done`: nothing is left for anyone"));
  assert.equal(reminder!.thread_ts, undefined, "at the top of the channel");
  assert.ok(channel.members.has(AUTO), "Autolinear's bot is in the channel");

  // Hermes's turn on the reminder ends with a command: the issue is done.
  t.clock.now += 5000;
  const command = await hermesCommands(t, channel.id, "move done", "Nothing left here.");
  assert.equal(issue.state.name, "Done");
  assert.equal(channel.archived, true);
  assert.deepEqual(autolinearReactions(t, command), []);
  assert.equal(t.slack.posts.length, posts + 1, "only the reminder was posted");
  await hermesReacts(t, channel.id, reminder!.ts);
  assert.equal(autolinearPosts(t, posts).length, 1, "no second reminder");
});

test("Hermes moves an issue and updates workflow details without renaming it", async () => {
  let t = setup();
  let { issue, channel } = await issueChannel(t);
  let message = await leonWrites(t, channel.id, "switch me to rogers once the deal is back");
  await hermesReacts(t, channel.id, message, "eyes");
  t.clock.now += 3000;
  const posts = t.slack.posts.length;
  const command = await hermesCommands(
    t,
    channel.id,
    "move trigger --event “Rogers BYOD deal” --stop 2026-12-01.",
    "I'll watch for it.",
  );
  assert.equal(t.slack.posts.length, posts);
  assert.equal(issue.state.name, "Awaiting Trigger");
  assert.equal(issue.title, "testing autolinear");
  assert.deepEqual(issueWorkflow(issue), { event: "Rogers BYOD deal", stop: "2026-12-01" });
  assert.equal(t.slack.sectionOf(channel.id), "Awaiting Trigger");
  assert.equal(t.store.timer(`timer:${issue.id}`), DEC_1);
  assert.deepEqual(autolinearReactions(t, command), []);
  await hermesReacts(t, channel.id, message);
  assert.equal(autolinearPosts(t, posts).length, 0, "the turn said what to do");

  // Back where it was before Hermes's 👀, keys kept, with `move trigger` alone.
  t.clock.now += 60_000;
  message = await leonWrites(t, channel.id, "any update?");
  await hermesReacts(t, channel.id, message, "eyes");
  assert.equal(issue.state.name, "Executing");
  await hermesCommands(t, channel.id, "move trigger", "Not yet.");
  assert.equal(issue.state.name, "Awaiting Trigger");
  assert.deepEqual(issueWorkflow(issue), { event: "Rogers BYOD deal", stop: "2026-12-01" });

  // Changing who is responsible keeps the task's identity.
  await hermesCommands(t, channel.id, 'move "Awaiting Trigger" who="Rogers support"');
  assert.equal(issue.state.name, "Awaiting Trigger");
  assert.deepEqual(issueWorkflow(issue), { who: "Rogers support" });
  assert.equal(t.store.timer(`timer:${issue.id}`), null);
  const sameStatus = await hermesCommands(t, channel.id, 'move trigger who="Rogers billing"');
  assert.deepEqual(autolinearReactions(t, sameStatus), []);
  assert.deepEqual(issueWorkflow(issue), { who: "Rogers billing" });
  assert.deepEqual(JSON.parse(t.issueMetadata.snapshot())[0].meta, { who: "Rogers billing" });

  await hermesCommands(t, channel.id, 'move trigger event="Rogers deal" stop=2026-12-01');
  assert.deepEqual(issueWorkflow(issue), { event: "Rogers deal", stop: "2026-12-01" });
  assert.equal(t.store.timer(`timer:${issue.id}`), DEC_1);

  await hermesCommands(t, channel.id, "move date start=2026-12-01T09:00:00-05:00");
  assert.equal(issue.state.name, "Awaiting Date");
  assert.deepEqual(issueWorkflow(issue), { start: "2026-12-01T09:00:00-05:00" });
  assert.equal(issue.title, "testing autolinear");
  assert.equal(channel.name, "leon-427-testing-autolinear");

  // Hermes can hand the issue to Leon silently.
  t = setup();
  ({ issue, channel } = await issueChannel(t));
  const priorPosts = t.slack.posts.length;
  const handoff = await hermesCommands(t, channel.id, "move leon", "Plan B saves $8 a month.");
  assert.equal(issue.state.name, "Awaiting Leon");
  assert.equal(t.slack.posts.length, priorPosts);
  assert.deepEqual(autolinearReactions(t, handoff), []);
});

test("older wait commands also move to Awaiting Trigger", async () => {
  const t = setup();
  const { issue, channel } = await issueChannel(t);
  await hermesCommands(t, channel.id, 'move others who="Rogers support"');
  assert.equal(issue.state.name, "Awaiting Trigger");
  assert.deepEqual(issueWorkflow(issue), { who: "Rogers support" });
  await hermesCommands(t, channel.id, 'move "Awaiting Listener" event=deal stop=2026-12-01');
  assert.equal(issue.state.name, "Awaiting Trigger");
  assert.deepEqual(issueWorkflow(issue), { event: "deal", stop: "2026-12-01" });
});

test("a trigger command requires an external response or a complete timed event", async () => {
  const t = setup();
  const { issue, channel } = await issueChannel(t);
  await hermesCommands(t, channel.id, "move trigger");
  assert.match(autolinearPosts(t).at(-1)!.text, /needs `--who` or both `--event` and `--stop`/);
  await hermesCommands(t, channel.id, "move trigger who=Rogers event=deal stop=2026-12-01");
  assert.match(
    autolinearPosts(t).at(-1)!.text,
    /accepts either `--who` or both `--event` and `--stop`/,
  );
  assert.equal(issue.state.name, "Awaiting Init");
  assert.deepEqual(issueWorkflow(issue), {});
});

test("stay keeps the status, and a command in an edit is read once Hermes stops editing, once", async () => {
  const t = setup();
  const { issue, channel } = await issueChannel(t, "Awaiting Trigger");
  const message = await leonWrites(t, channel.id, "how's the migration going?");
  t.clock.now += 1000;
  const ts = tsAt(t.clock.now);
  const edit = (text: string) => ({
    type: "message",
    subtype: "message_changed",
    channel: channel.id,
    ts: tsAt(t.clock.now + 1),
    message: { ts, user: HERMES, bot_id: "B0HERMES01", text },
  });
  await t.sync.run("slack", hermesSays(channel.id, "Halfway", { ts, thread_ts: undefined }));
  t.clock.now += 1000;
  await t.sync.run("slack", edit(`Halfway there.\n<@${AUTO}> st`));
  t.clock.now += 1000;
  await t.sync.run("slack", edit(`Halfway there.\n<@${AUTO}> stay`));
  t.clock.now += COMMAND_SETTLE_MS - 1;
  await t.drain();
  assert.equal(t.slack.reactions.length, 0, "still settling after the last edit");
  t.clock.now += 1;
  await t.drain();
  assert.deepEqual(t.slack.reactions, []);
  assert.equal(issue.state.name, "Awaiting Trigger");
  assert.equal(autolinearPosts(t).length, 0, "the half-written command got no answer");

  // A later edit of the same message doesn't act again.
  await t.sync.run("slack", edit(`Halfway there, really.\n<@${AUTO}> move done`));
  t.clock.now += COMMAND_SETTLE_MS;
  await t.drain();
  assert.equal(issue.state.name, "Awaiting Trigger");
  await hermesReacts(t, channel.id, message);
  assert.equal(autolinearPosts(t).length, 0);
});

for (const layout of ["legacy text", "Slack blocks"]) {
  test(`new answers can move the issue again on the same task message with ${layout}`, async () => {
    const t = setup();
    const { issue, channel } = await issueChannel(t);
    const ts = tsAt(t.clock.now);
    const edit = (answer: string, reports = "") => {
      t.clock.now += 1000;
      const revision = tsAt(t.clock.now);
      const sections = layout === "legacy text" ? ["*Task progress*", reports] : [reports];
      if (answer) sections.push(`*Update from Hermes*\n${answer}`);
      return {
        type: "message",
        subtype: "message_changed",
        channel: channel.id,
        ts: revision,
        message: {
          ts,
          user: HERMES,
          text: sections.filter(Boolean).join("\n\n"),
          ...(layout === "Slack blocks" && {
            blocks: [{ block_id: `hermes-task-progress/${answer ? "answer/" : ""}${revision}` }],
          }),
          edited: { ts: revision },
        },
      };
    };

    const assigned = `The report is being checked.\n<@${AUTO}> move executing`;
    const first = edit(assigned);
    await t.sync.run("slack", first);
    t.clock.now += COMMAND_SETTLE_MS;
    await t.drain();
    assert.equal(issue.state.name, "Executing");
    const updates = t.linear.updates.length;

    await t.sync.run(
      "slack",
      edit(assigned, "\n\n*Latest agent updates*\n• Verified the recipient"),
    );
    assert.equal(t.store.timer(`command:${channel.id}:${ts}`), null);
    assert.equal(t.linear.updates.length, updates);

    if (layout === "Slack blocks") {
      await t.sync.run("slack", edit("", `I found the old command:\n<@${AUTO}> move done`));
      await t.sync.run("slack", {
        type: "message",
        channel: channel.id,
        ts: tsAt(t.clock.now + 1),
        thread_ts: ts,
        user: HERMES,
        text: `I found the old command:\n<@${AUTO}> move done`,
        blocks: [{ block_id: "hermes-task-progress-note/example" }],
      });
      t.clock.now += COMMAND_SETTLE_MS;
      await t.drain();
      assert.equal(issue.state.name, "Executing");
    }

    const waiting = edit(`Please confirm the recipient.\n<@${AUTO}> move leon`);
    await t.sync.run("slack", waiting);
    await t.sync.run("slack", first);
    t.clock.now += COMMAND_SETTLE_MS;
    await t.drain();
    assert.equal(issue.state.name, "Awaiting Leon");

    const done = edit(`Sent and verified.\n<@${AUTO}> move done`);
    await t.sync.run("slack", done);
    await t.sync.run("slack", done);
    t.clock.now += COMMAND_SETTLE_MS;
    await t.drain();
    assert.equal(issue.state.name, "Done");
    assert.equal(channel.archived, true);
  });
}

test("a command that doesn't work is answered under it, and reminders stop after the limit", async () => {
  const t = setup();
  const { issue, channel } = await issueChannel(t);
  const message = await leonWrites(t, channel.id, "remind me about rogers");
  const posts = t.slack.posts.length;
  t.clock.now += 2000;
  const lion = await hermesCommands(t, channel.id, "move lion");
  const [answer] = autolinearPosts(t, posts);
  assert.equal(answer!.thread_ts, lion);
  assert.ok(
    answer!.text.startsWith(
      `<@${HERMES}> I couldn't do that: no status is called "lion"; use one of Awaiting Init,`,
    ),
    answer!.text,
  );
  assert.equal(issue.state.name, "Awaiting Init");
  // Hermes's turn on Leon's message said something to Autolinear, so it isn't reminded too.
  await hermesReacts(t, channel.id, message);
  assert.equal(autolinearPosts(t, posts).length, 1);

  await hermesCommands(t, channel.id, "move trigger event=deal");
  assert.equal(
    autolinearPosts(t, posts).at(-1)!.text.split("\n")[0],
    `<@${HERMES}> I couldn't do that: *Awaiting Trigger* needs \`--stop\`.`,
  );
  assert.equal(autolinearPosts(t, posts).length, MAX_REMINDERS);

  // The limit is reached: Leon is told, once, and Autolinear stops asking.
  await hermesCommands(t, channel.id, "move date start=tomorrow");
  await hermesCommands(t, channel.id, "frobnicate");
  const told = autolinearPosts(t, posts).slice(MAX_REMINDERS);
  assert.deepEqual(
    told.map((p) => p.text),
    [
      `<@${LEON}> Hermes still hasn't told me what to do with LEON-427 after ${MAX_REMINDERS} reminders, so it stays *Awaiting Init*.`,
    ],
  );
  assert.equal(issue.state.name, "Awaiting Init");

  // Leon writing again starts the count over.
  t.clock.now += 60_000;
  const again = await leonWrites(t, channel.id, "hello?");
  await hermesReacts(t, channel.id, again);
  assert.ok(
    autolinearPosts(t, posts).at(-1)!.text.startsWith(`<@${HERMES}> Your turn here is over`),
  );
});

test("a turn the gateway stopped running gets a reminder; one that ends or is reported running doesn't", async () => {
  const t = setup();
  const { issue, channel } = await issueChannel(t);
  const question = await leonWrites(t, channel.id, "is keto bad for my cholesterol?");
  await hermesReacts(t, channel.id, question, "eyes");
  const posts = t.slack.posts.length;

  // The gateway reports a turn running here about every minute: the timer keeps moving on.
  for (let minute = 0; minute < 8; minute++) {
    t.clock.now += 60_000;
    await t.sync.run("turns", { channels: [channel.id, "C0ELSEWHERE"] });
    await t.drain();
  }
  assert.equal(autolinearPosts(t, posts).length, 0, "a running turn isn't overdue");

  // The gateway restarted under the turn: no ✅, and its reports no longer name the channel.
  for (let minute = 0; minute < STUCK_MS / 60_000; minute++) {
    t.clock.now += 60_000;
    await t.sync.run("turns", { channels: [] });
    await t.drain();
  }
  const [reminder, ...more] = autolinearPosts(t, posts);
  assert.equal(more.length, 0);
  assert.ok(
    reminder!.text.startsWith(
      `<@${HERMES}> Your turn on <https://app.slack.com/archives/${channel.id}/p${question.replace(".", "")}|this message> never ended: no :white_check_mark: or :x:, and your gateway hasn't been running a turn here for 5 minutes, so it was most likely cut off.`,
    ),
    reminder!.text,
  );
  assert.ok(reminder!.text.includes("which is *Executing*"));
  assert.equal(reminder!.thread_ts, undefined, "at the top of the channel");
  assert.equal(issue.state.name, "Executing", "a reminder moves nothing");
  t.clock.now += STUCK_MS;
  await t.drain();
  assert.equal(autolinearPosts(t, posts).length, 1, "once per turn");

  // Hermes's turn on the reminder ends with a command: nothing more is owed.
  await hermesReacts(t, channel.id, reminder!.ts, "eyes");
  t.clock.now += 3000;
  await hermesCommands(t, channel.id, "move leon", "Here's what Muse found.");
  await hermesReacts(t, channel.id, reminder!.ts);
  t.clock.now += 2 * STUCK_MS;
  await t.drain();
  assert.equal(issue.state.name, "Awaiting Leon");
  assert.equal(autolinearPosts(t, posts).length, 1);
});

test("a gateway that stopped reporting its turns gets no reminder; the lease decides", async () => {
  // 2026-11-26: a live plugin reload left the gateway reporting nothing, so LEON-533's 5-minute
  // turn got "never ended" 3 seconds before it ended.
  const t = setup();
  const { issue, channel } = await issueChannel(t);
  await t.sync.run("turns", { channels: [] });
  const question = await leonWrites(t, channel.id, "submit the helpdesk request");
  await hermesReacts(t, channel.id, question, "eyes");
  const posts = t.slack.posts.length;
  t.clock.now += STUCK_MS;
  await t.drain();
  assert.equal(autolinearPosts(t, posts).length, 0, "silence proves nothing");
  assert.ok(t.logs.some(([event]) => event === "autolinear_stuck_unreported"));
  assert.equal(issue.state.name, "Executing");
  t.clock.now += LEASE_MS;
  await t.drain();
  assert.equal(issue.state.name, "Awaiting Leon", "the lease still catches a turn that stopped");
});

test("a turn that ends, or that Leon wrote after, is never overdue", async () => {
  const t = setup();
  const { channel } = await issueChannel(t);
  const first = await leonWrites(t, channel.id, "log my lunch");
  await hermesReacts(t, channel.id, first, "eyes");
  t.clock.now += 3000;
  await hermesCommands(t, channel.id, "move done", "Logged.");
  await hermesReacts(t, channel.id, first);
  t.clock.now += 2 * STUCK_MS;
  await t.drain();
  assert.equal(autolinearPosts(t).length, 0, "the turn ended");

  const t2 = setup();
  const other = await issueChannel(t2);
  const older = await leonWrites(t2, other.channel.id, "book the dentist");
  await hermesReacts(t2, other.channel.id, older, "eyes");
  t2.clock.now += 1000;
  await leonWrites(t2, other.channel.id, "actually, next week");
  t2.clock.now += 2 * STUCK_MS;
  await t2.drain();
  assert.equal(autolinearPosts(t2).length, 0, "his newer message's turn counts");
});

test("Muse's unread answer gets Hermes asked in the handoff's thread", async () => {
  const t = setup();
  const { issue, channel } = await issueChannel(t);
  const question = await leonWrites(t, channel.id, "is keto bad for my cholesterol?");
  await hermesReacts(t, channel.id, question, "eyes");
  const handoff = "a65e4fb8-2606-50ee-9c8c-79817beda442";
  const answer = readMuseAnswer({
    channel: channel.id,
    thread: question,
    handoff,
    sideChat: `https://muse.ai/thread/${handoff}`,
  });
  assert.ok(answer);
  const posts = t.slack.posts.length;
  await t.sync.run("muse-answer", answer);
  const [ask] = autolinearPosts(t, posts);
  assert.equal(ask!.thread_ts, question, "in the handoff's thread");
  assert.ok(
    ask!.text.startsWith(
      `<@${HERMES}> Muse answered handoff \`${handoff}\` (https://muse.ai/thread/${handoff}), but none of your turns has read the answer`,
    ),
    ask!.text,
  );
  assert.ok(ask!.text.includes(`Read it with \`muse_wait\` (handoff \`${handoff}\`)`));
  assert.ok(ask!.text.includes("LEON-427, which is *Executing*"));

  // It shares the reminders' budget: after MAX_REMINDERS, Leon hears about it instead.
  for (let i = 1; i < MAX_REMINDERS; i++) await t.sync.run("muse-answer", answer);
  await t.sync.run("muse-answer", answer);
  const last = autolinearPosts(t, posts).at(-1)!;
  assert.ok(
    last.text.startsWith(`<@${LEON}> Hermes still hasn't told me what to do with LEON-427`),
  );
  assert.equal(issue.state.name, "Executing");

  // Outside an open issue's channel there's no one to ask.
  const before = t.slack.posts.length;
  await t.sync.run("muse-answer", { ...answer, channel: "C0NOTANISSUE" });
  assert.equal(t.slack.posts.length, before);
});

test("the gateway's reports are checked before they're queued", () => {
  assert.deepEqual(readTurns({ channels: ["C0ABC123", "D0DM12345", 7, "G0PRIVATE1"] }), {
    channels: ["C0ABC123", "G0PRIVATE1"],
  });
  assert.equal(readTurns({}), null);
  const handoff = "a65e4fb8-2606-50ee-9c8c-79817beda442";
  const answer = {
    channel: "C0ABC123",
    thread: "1795641485.007579",
    handoff,
    sideChat: `https://muse.ai/thread/${handoff}`,
  };
  assert.deepEqual(readMuseAnswer(answer), answer);
  assert.equal(readMuseAnswer({ ...answer, sideChat: "https://example.com/" }), null);
  assert.equal(readMuseAnswer({ ...answer, thread: "now" }), null);
  assert.equal(readMuseAnswer({ ...answer, channel: "D0DM12345" }), null);
});

test("a failed turn gets a reminder too, and nothing moves", async () => {
  const t = setup();
  const { issue, channel } = await issueChannel(t);
  const message = await leonWrites(t, channel.id, "book the dentist");
  await hermesReacts(t, channel.id, message, "eyes");
  await hermesReacts(t, channel.id, message, "x");
  assert.equal(issue.state.name, "Executing");
  assert.ok(
    autolinearPosts(t)
      .at(-1)!
      .text.startsWith(
        `<@${HERMES}> Your turn here failed, so I still don't know what to do with LEON-427`,
      ),
  );
});

test("a message Hermes only answered with a gateway notice owes no command", async () => {
  // LEON-494, 2026-11-26: Hermes's conversation was paused after a restart, so "mark as done" got
  // the pause notice and ✅ but no turn; Autolinear's reminder then got `stay` from a fresh thread.
  const t = setup();
  const { issue, channel } = await issueChannel(t, "Awaiting Leon");
  const message = await leonWrites(t, channel.id, "mark as done");
  await hermesReacts(t, channel.id, message, "eyes");
  t.clock.now += 1000;
  await hermesPosts(
    t,
    channel.id,
    ":double_vertical_bar: This conversation is paused: a previous turn did not finish when Hermes restarted, and only you know whether to send it again.",
  );
  await hermesReacts(t, channel.id, message);
  assert.equal(autolinearPosts(t).length, 0, "no turn ran, so none is owed a reminder");
  assert.ok(t.logs.some(([event]) => event === "autolinear_no_turn"));
  assert.equal(issue.state.name, "Executing");

  // A real turn after it still owes a command.
  t.clock.now += 60_000;
  const again = await leonWrites(t, channel.id, "mark as done");
  await hermesReacts(t, channel.id, again, "eyes");
  t.clock.now += 2000;
  await hermesPosts(t, channel.id, "Marked it done.");
  await hermesReacts(t, channel.id, again);
  assert.equal(autolinearPosts(t).length, 1);
  assert.ok(autolinearPosts(t)[0]!.text.startsWith(`<@${HERMES}> Your turn here is over`));
});

test("Leon's message that never reached Hermes is handed to it once the gateway reports again", async () => {
  // LEON-494, 2026-11-26: "mark as done" at 12:02 ET came while the gateway was down for 20
  // minutes; Slack never sent it again, so nothing answered it.
  const t = setup();
  const { channel } = await issueChannel(t, "Awaiting Leon");
  await t.sync.run("turns", { channels: [] });
  const message = await leonWrites(t, channel.id, "mark as done");
  const posts = t.slack.posts.length;

  // The gateway is down: no reports, so Autolinear waits instead of asking no one.
  for (let minute = 0; minute < 20; minute++) {
    t.clock.now += 60_000;
    await t.drain();
  }
  assert.equal(autolinearPosts(t, posts).length, 0);
  assert.ok(t.logs.some(([event]) => event === "autolinear_unseen_unreported"));

  // It's back and reporting: the message is handed over, at the top of the channel, once.
  for (let minute = 0; minute < UNSEEN_MS / 60_000 + 1; minute++) {
    t.clock.now += 60_000;
    await t.sync.run("turns", { channels: [] });
    await t.drain();
  }
  const [handoff, ...more] = autolinearPosts(t, posts);
  assert.equal(more.length, 0);
  assert.equal(handoff!.thread_ts, undefined, "at the top of the channel");
  assert.ok(
    handoff!.text.startsWith(
      `<@${HERMES}> Leon wrote <https://app.slack.com/archives/${channel.id}/p${message.replace(".", "")}|this message> here 21 minutes ago, and it never reached you:`,
    ),
    handoff!.text,
  );
  assert.ok(handoff!.text.includes("\n> mark as done\n"));
  assert.ok(handoff!.text.includes("which is *Awaiting Leon*"));
  t.clock.now += UNSEEN_GIVE_UP_MS;
  await t.drain();
  assert.equal(autolinearPosts(t, posts).length, 1);
});

test("a message Hermes took up, a thread reply and a command aren't handed over", async () => {
  const t = setup();
  const { channel } = await issueChannel(t);
  await t.sync.run("turns", { channels: [] });
  const seen = await leonWrites(t, channel.id, "log my lunch");
  await hermesReacts(t, channel.id, seen, "eyes");
  t.clock.now += 1000;
  await t.sync.run("slack", {
    type: "message",
    channel: channel.id,
    user: LEON,
    text: "and dinner",
    ts: tsAt(t.clock.now),
    thread_ts: seen,
  });
  t.clock.now += 1000;
  await leonWrites(t, channel.id, "!stop");
  for (let minute = 0; minute < 10; minute++) {
    t.clock.now += 60_000;
    await t.sync.run("turns", { channels: [channel.id] });
    await t.drain();
  }
  assert.equal(autolinearPosts(t).filter((p) => p.text.includes("never reached you")).length, 0);
});

test("of two messages that never reached Hermes, the newer is handed over", async () => {
  const t = setup();
  const { channel } = await issueChannel(t);
  await t.sync.run("turns", { channels: [] });
  await leonWrites(t, channel.id, "mark as done");
  t.clock.now += 60_000;
  const newer = await leonWrites(t, channel.id, "mark as done please");
  for (let minute = 0; minute < 6; minute++) {
    t.clock.now += 60_000;
    await t.sync.run("turns", { channels: [] });
    await t.drain();
  }
  const handoffs = autolinearPosts(t).filter((p) => p.text.includes("never reached you"));
  assert.equal(handoffs.length, 1);
  assert.ok(handoffs[0]!.text.includes(`p${newer.replace(".", "")}|this message>`));
  assert.ok(handoffs[0]!.text.includes("anything else he wrote here"));
});

test("a turn Leon wrote after is skipped: the turn on his newer message counts", async () => {
  const t = setup();
  const { issue, channel } = await issueChannel(t);
  const first = await leonWrites(t, channel.id, "thanks");
  t.clock.now += 1000;
  const second = await leonWrites(t, channel.id, "oh and one more thing");
  await hermesReacts(t, channel.id, first);
  assert.equal(autolinearPosts(t).length, 0, "the turn on his newer message counts");
  t.clock.now += 3000;
  await hermesCommands(t, channel.id, "move executing", "On it.");
  await hermesReacts(t, channel.id, second);
  assert.equal(autolinearPosts(t).length, 0);
  assert.equal(issue.state.name, "Executing");
});

test("Autolinear rejects a handoff to Hermes without changing the issue", async () => {
  const t = setup();
  const { issue, channel } = await issueChannel(t, "Executing");
  const posts = t.slack.posts.length;
  const ts = await hermesCommands(t, channel.id, "move hermes", "I'll pick this up next.");
  const [reply] = t.slack.posts.slice(posts);
  assert.equal(t.slack.posts.length, posts + 1);
  assert.equal(reply!.user, AUTO);
  assert.equal(reply!.thread_ts, ts);
  assert.match(reply!.text, /Awaiting Hermes is only available in Linear/);
  assert.equal(issue.state.name, "Executing");
  assert.equal(t.linear.updates.length, 0);

  await hermesCommands(t, channel.id, "move executing", "I handed this off.");
  assert.equal(issue.state.name, "Executing");
  assert.equal(t.slack.posts.length, posts + 1);
});

test("a queued continuation from an earlier deployment is discarded", async () => {
  const t = setup();
  const { channel } = await issueChannel(t, "Awaiting Hermes");
  const posts = t.slack.posts.length;
  await t.sync.run("resume-hermes", { channel: channel.id, ts: "1794000000.000001" });
  assert.equal(t.slack.posts.length, posts);
});

test("a handoff in Linear pings Hermes and starts Executing when Hermes takes it up", async () => {
  const t = setup();
  const { issue, channel } = await issueChannel(t, "Executing");
  issue.state = state("Awaiting Hermes");
  await t.sync.run("linear", issueHook(issue.id));
  const ping = t.slack.posts.at(-1)!;
  assert.equal(ping.user, BOT);
  assert.ok(ping.text.includes(`<@${HERMES}>`));
  await t.sync.run(
    "slack",
    eyes(channel.id, {
      item_user: BOT,
      item: { type: "message", channel: channel.id, ts: ping.ts },
    }),
  );
  assert.equal(issue.state.name, "Executing");
  assert.equal(t.slack.posts.at(-1)!.ts, ping.ts);
  assert.deepEqual(autolinearReactions(t, ping.ts), ["gear"]);
});

test("Hermes's turn on a bot's ping owes a command as well", async () => {
  const t = setup();
  const { issue, channel } = await issueChannel(t, "Awaiting Date");
  // slack22linear pings Hermes when the issue's start comes (Awaiting Start).
  issue.state = state("Awaiting Start");
  await t.sync.run("linear", issueHook(issue.id));
  const ping = t.slack.posts.at(-1)!;
  assert.ok(ping.text.includes(`<@${HERMES}>`));
  t.clock.now += 60_000;
  await t.sync.run(
    "slack",
    eyes(channel.id, {
      reaction: "white_check_mark",
      item_user: BOT,
      item: { type: "message", channel: channel.id, ts: ping.ts },
    }),
  );
  t.clock.now += ANSWER_SETTLE_MS;
  await t.drain();
  assert.ok(autolinearPosts(t).at(-1)!.text.includes("which is *Awaiting Start*."));
});

test("Leon's /autolinear moves the issue and answers him privately", async () => {
  const t = setup();
  const { issue, channel } = await issueChannel(t);
  const slash = (text: string, channelId = channel.id, n = 1): CommandJob => ({
    channel: channelId,
    ts: `slash-${n}`,
    text,
    by: "leon",
    responseUrl: `https://hooks.slack.com/commands/${n}`,
  });
  const message = await leonWrites(t, channel.id, "wait on rogers for me");
  t.clock.now += 2000;
  await t.sync.run("command", slash("move trigger --who Rogers"));
  assert.equal(issue.state.name, "Awaiting Trigger");
  assert.equal(
    t.slack.posts.at(-1)!.text,
    "*Awaiting Init* → *Awaiting Trigger* (Leon told Autolinear)",
  );
  assert.deepEqual(t.responses, [
    { url: "https://hooks.slack.com/commands/1", text: "LEON-427 is now *Awaiting Trigger*." },
  ]);
  // It's the turn's command: Hermes's answer after it isn't reminded.
  t.clock.now += 2000;
  await hermesPosts(t, channel.id, "Okay.");
  await hermesReacts(t, channel.id, message);
  assert.equal(autolinearPosts(t).length, 0);

  await t.sync.run("command", slash("move nowhere", channel.id, 2));
  assert.ok(
    t.responses.at(-1)!.text.startsWith(`I couldn't do that: no status is called "nowhere"`),
  );
  assert.ok(!t.responses.at(-1)!.text.includes("<@"), "no one is pinged");
  await t.sync.run("command", slash("move done", "C-unmapped", 3));
  assert.equal(t.responses.at(-1)!.text, "This isn't the channel of an open issue.");
  assert.equal(issue.state.name, "Awaiting Trigger");
});

test("Autolinear's bot is invited when it isn't in an older channel", async () => {
  const t = setup();
  const { channel } = await issueChannel(t);
  channel.members.delete(AUTO);
  const message = await leonWrites(t, channel.id, "hi");
  await hermesReacts(t, channel.id, message);
  assert.ok(channel.members.has(AUTO));
  assert.equal(autolinearPosts(t).length, 1);
});

test("other reactions, other people's reactions, and other channels ask for nothing", async () => {
  const t = setup();
  const { issue, channel } = await issueChannel(t);
  const message = await leonWrites(t, channel.id, "hello");
  const item = { type: "message", channel: channel.id, ts: message };
  for (const event of [
    eyes(channel.id, { user: LEON, item }),
    eyes(channel.id, { item_user: BOT, item }),
    eyes("C-unmapped", { item: { ...item, channel: "C-unmapped" } }),
    eyes(channel.id, { reaction: "tada", item }),
    eyes(channel.id, { reaction: "white_check_mark", user: LEON, item }),
    eyes(channel.id, { reaction: "white_check_mark", item: { type: "file", channel: channel.id } }),
    eyes("C-unmapped", { reaction: "white_check_mark", item: { ...item, channel: "C-unmapped" } }),
  ])
    await t.sync.run("slack", event);
  t.clock.now += ANSWER_SETTLE_MS;
  await t.drain();
  assert.equal(issue.state.name, "Awaiting Init");
  assert.equal(t.linear.updates.length, 0);
  assert.equal(autolinearPosts(t).length, 0);
});

// ── Executing's lease ────────────────────────────────────────────────────────

const statusNotices = (t: ReturnType<typeof setup>) =>
  t.slack.posts.filter((p) => p.user !== AUTO && p.text.includes("→"));

test("Executing is a lease: once nothing works on an issue, it goes to Leon", async () => {
  const t = setup();
  const { issue, channel } = await issueChannel(t);
  const question = await leonWrites(t, channel.id, "is keto bad for my cholesterol?");
  await hermesReacts(t, channel.id, question, "eyes");
  assert.equal(issue.state.name, "Executing");

  // A turn the gateway reports running holds the issue, however long it takes.
  for (let minute = 0; minute < 40; minute++) {
    t.clock.now += 60_000;
    await t.sync.run("turns", { channels: [channel.id] });
    await t.drain();
  }
  assert.equal(issue.state.name, "Executing", "a running turn holds the lease");

  // The gateway restarts under the turn: its reports stop naming the channel. Autolinear's
  // reminder goes unanswered, and isn't work.
  const leaseEnd = t.store.timer(`lease:${issue.id}`)!;
  while (t.clock.now + 60_000 < leaseEnd) {
    t.clock.now += 60_000;
    await t.sync.run("turns", { channels: [] });
    await t.drain();
  }
  t.clock.now = leaseEnd - 1;
  await t.drain();
  const [reminder, ...more] = autolinearPosts(t);
  assert.equal(more.length, 0);
  await t.sync.run("slack", {
    type: "message",
    channel: channel.id,
    user: AUTO,
    bot_id: "B0AUTOLIN1",
    text: reminder!.text,
    ts: reminder!.ts,
  });
  assert.equal(issue.state.name, "Executing");
  t.clock.now += 1;
  await t.drain();
  assert.equal(issue.state.name, "Awaiting Leon");
  const notice = statusNotices(t).at(-1)!;
  assert.match(notice.text, /^\*Executing\* → \*Awaiting Leon\*/);
  assert.ok(notice.text.includes(`<@${LEON}>`), "Leon hears about it");
  const comment = [...t.linear.comments.values()].at(-1)!;
  assert.match(comment.body, /^\*\*slack22linear:\*\* nothing is working on this any more/);
  assert.equal(t.store.timer(`lease:${issue.id}`), null, "only Executing has a lease");
});

test("agents' posts and `move executing --until` hold the lease; Autolinear's posts don't", async () => {
  const t = setup();
  const { issue, channel } = await issueChannel(t);
  const ask = await leonWrites(t, channel.id, "post my keyboard on marketplaces");
  await hermesReacts(t, channel.id, ask, "eyes");
  t.clock.now += 3000;
  await hermesCommands(t, channel.id, "move executing --until 3h", "Grok is checking prices.");
  await hermesReacts(t, channel.id, ask);
  const lease = t.store.timer(`lease:${issue.id}`)!;
  assert.equal(lease, t.clock.now - ANSWER_SETTLE_MS + 3 * 3600_000, "as long as Hermes said");

  t.clock.now = lease - 60_000;
  await t.drain();
  assert.equal(issue.state.name, "Executing");
  // An agent reports in the task's thread, as Leon through slack-as-leon: it's still working.
  await t.sync.run("slack", {
    type: "message",
    channel: channel.id,
    user: LEON,
    text: ":robot_face: *Task slack:…*: Prices are in; checking accounts next.",
    ts: tsAt(t.clock.now),
    thread_ts: ask,
    client_msg_id: "a7011eae-0000-4000-8000-000000000001",
  });
  assert.equal(t.store.timer(`lease:${issue.id}`), t.clock.now + LEASE_MS);
  t.clock.now += LEASE_MS - 60_000;
  // Muse's bot edits its reply.
  await t.sync.run("slack", {
    type: "message",
    subtype: "message_changed",
    channel: channel.id,
    ts: tsAt(t.clock.now),
    message: {
      ts: tsAt(t.clock.now - 1000),
      user: "U0MUSEBOT1",
      bot_id: "B0MUSEBOT1",
      text: "Done.",
    },
  });
  const held = t.store.timer(`lease:${issue.id}`)!;
  assert.equal(held, t.clock.now + LEASE_MS);
  t.clock.now += LEASE_MS;
  await t.drain();
  assert.equal(issue.state.name, "Awaiting Leon", "nobody acted on the agents' reports");

  // A bare `move executing` holds for an hour.
  const t2 = setup();
  const other = await issueChannel(t2);
  await hermesCommands(t2, other.channel.id, "move executing", "Handed to Codex.");
  assert.equal(other.issue.state.name, "Executing");
  assert.equal(t2.store.timer(`lease:${other.issue.id}`), t2.clock.now + EXECUTING_MS);
});

test("`--until` must be soon and goes with Executing only", async () => {
  const t = setup();
  const { issue, channel } = await issueChannel(t, "Executing");
  await hermesCommands(t, channel.id, "move executing --until 25h");
  await hermesCommands(t, channel.id, "move done --until 2h");
  const [far, wrong] = autolinearPosts(t);
  assert.ok(far!.text.includes("`--until` can be at most 24 hours away"), far!.text);
  assert.ok(wrong!.text.includes("`--until` goes with *Executing* only"), wrong!.text);
  assert.equal(issue.state.name, "Executing");
});

test("stay after Hermes's 👀 goes back to the wait before it; with none, it's refused", async () => {
  const t = setup();
  const { issue, channel } = await issueChannel(t, "Awaiting Leon");
  const note = await leonWrites(t, channel.id, "always send conclusions in the main thread");
  await hermesReacts(t, channel.id, note, "eyes");
  assert.equal(issue.state.name, "Executing");
  t.clock.now += 3000;
  await hermesCommands(t, channel.id, "stay", "Understood. Saved as a standing rule.");
  assert.equal(issue.state.name, "Awaiting Leon", "back where it was before the 👀");
  assert.equal(autolinearPosts(t).length, 0);
  assert.equal(t.store.timer(`lease:${issue.id}`), null);

  // LEON-487 and 488: a new request has no wait to go back to.
  const t2 = setup();
  const fresh = await issueChannel(t2);
  const ask = await leonWrites(t2, fresh.channel.id, "forward this email");
  await hermesReacts(t2, fresh.channel.id, ask, "eyes");
  t2.clock.now += 3000;
  await hermesCommands(t2, fresh.channel.id, "stay");
  assert.equal(fresh.issue.state.name, "Executing");
  const [why] = autolinearPosts(t2);
  assert.ok(why!.text.includes("(it was *Awaiting Init* before your :eyes:)"), why!.text);
  assert.ok(why!.text.includes("`move executing --until <when it should be done>`"), why!.text);
});

test("the daily tick gives an issue already stuck in Executing a lease", async () => {
  const t = setup();
  const { issue } = await issueChannel(t, "Executing");
  assert.equal(t.store.timer(`lease:${issue.id}`), t.clock.now - 60_000 + LEASE_MS);
  // As if it went to Executing before leases existed.
  t.store.setTimer(`lease:${issue.id}`, "lease", null, null, t.clock.now);
  await t.sync.run("tick", {});
  assert.equal(t.store.timer(`lease:${issue.id}`), t.clock.now + LEASE_MS);
  t.clock.now += LEASE_MS;
  await t.drain();
  assert.equal(issue.state.name, "Awaiting Leon");
});
