import assert from "node:assert/strict";
import { test } from "node:test";
import { SlackError } from "@-/ai.leonsilicon.services.slack22linear";
import type {
  LinearProject,
  NewProject,
  SlackParams,
  SlackResponse,
} from "@-/ai.leonsilicon.services.slack22linear";
import { loadConfig } from "#config";
import {
  CHANNEL_RETRY_MS,
  Daily,
  dayProjectId,
  type DailyLinear,
  type DailyState,
  WAITING_RETRY_MS,
} from "#daily";

const LEON = "U0LEON00001";
const HERMES = "U0HERMES001";
const LINEAR_BOT = "U0LINEARBOT";

/** 15:00 Toronto on 2026-11-21, when dailylinear first runs. */
const NOV_21_AFTERNOON = Date.UTC(2026, 10, 21, 20, 0);
/** Midnight in Toronto starting 2026-11-22. */
const NOV_22_MIDNIGHT = Date.UTC(2026, 10, 22, 5, 0);
const NOV_23_MIDNIGHT = Date.UTC(2026, 10, 23, 5, 0);

interface Channel {
  id: string;
  name: string;
  members: Set<string>;
  archived: boolean;
}

interface Section {
  id: string;
  name: string;
  type: string;
  channelIds: string[];
}

function fakeSlack() {
  const channels: Channel[] = [];
  const stars = new Set<string>();
  // Top to bottom: Starred, then the custom sections, then Slack's own.
  const sections: Section[] = [
    { id: "L-stars", name: "", type: "stars", channelIds: [] },
    { id: "L-leon", name: "Awaiting Leon", type: "standard", channelIds: [] },
    { id: "L-projects", name: "Projects", type: "standard", channelIds: [] },
    { id: "L-channels", name: "", type: "channels", channelIds: [] },
  ];
  const calls: { method: string; params: SlackParams }[] = [];
  let nextId = 1;
  const addChannel = (name: string, members: string[] = [LINEAR_BOT]) => {
    const channel: Channel = {
      id: `C0FAKE${String(nextId++).padStart(4, "0")}`,
      name,
      members: new Set(members),
      archived: false,
    };
    channels.push(channel);
    return channel;
  };
  const find = (id: unknown) => {
    const channel = channels.find((c) => c.id === id);
    if (!channel) throw new SlackError("fake", "channel_not_found");
    return channel;
  };
  const session = async (method: string, params: SlackParams = {}): Promise<SlackResponse> => {
    calls.push({ method, params });
    switch (method) {
      case "conversations.list":
        return {
          ok: true,
          channels: channels.map((c) => ({ id: c.id, name: c.name, is_archived: c.archived })),
        };
      case "conversations.rename": {
        if (channels.some((c) => c.name === params.name))
          throw new SlackError(method, "name_taken");
        find(params.channel).name = String(params.name);
        return { ok: true };
      }
      case "conversations.join": {
        const channel = find(params.channel);
        if (channel.members.has(LEON)) throw new SlackError(method, "already_in_channel");
        channel.members.add(LEON);
        return { ok: true };
      }
      case "conversations.invite": {
        const channel = find(params.channel);
        if (channel.members.has(String(params.users)))
          throw new SlackError(method, "already_in_channel");
        channel.members.add(String(params.users));
        return { ok: true };
      }
      case "conversations.archive": {
        const channel = find(params.channel);
        if (channel.archived) throw new SlackError(method, "already_archived");
        channel.archived = true;
        return { ok: true };
      }
      case "stars.add":
        if (stars.has(String(params.channel))) throw new SlackError(method, "already_starred");
        stars.add(String(params.channel));
        return { ok: true };
      case "stars.remove":
        if (!stars.delete(String(params.channel))) throw new SlackError(method, "not_starred");
        return { ok: true };
      case "users.channelSections.list":
        return {
          ok: true,
          channel_sections: sections.map((s, i) => ({
            channel_section_id: s.id,
            name: s.name,
            type: s.type,
            next_channel_section_id: sections[i + 1]?.id ?? null,
            // Slack's Starred lists nothing here; stars.list holds them.
            channel_ids_page: { channel_ids: s.type === "stars" ? [] : [...s.channelIds] },
          })),
        };
      case "users.channelSections.create": {
        const section = {
          id: `L-${String(params.name).toLowerCase()}`,
          name: String(params.name),
          type: "standard",
          channelIds: [],
        };
        sections.splice(1, 0, section);
        return { ok: true, channel_section_id: section.id };
      }
      case "users.channelSections.set":
        return { ok: true };
      case "users.channelSections.channels.bulkUpdate": {
        for (const r of JSON.parse(String(params.remove ?? "[]")) as {
          channel_section_id: string;
          channel_ids: string[];
        }[]) {
          const section = sections.find((s) => s.id === r.channel_section_id)!;
          section.channelIds = section.channelIds.filter((id) => !r.channel_ids.includes(id));
        }
        for (const r of JSON.parse(String(params.insert ?? "[]")) as {
          channel_section_id: string;
          channel_ids: string[];
        }[])
          sections.find((s) => s.id === r.channel_section_id)!.channelIds.push(...r.channel_ids);
        return { ok: true };
      }
      case "users.channelSections.delete":
        sections.splice(
          sections.findIndex((s) => s.id === params.channel_section_id),
          1,
        );
        return { ok: true };
      default:
        throw new Error(`unexpected Slack call ${method}`);
    }
  };
  const sectionOf = (channelId: string) =>
    sections.find((s) => s.type === "standard" && s.channelIds.includes(channelId))?.name ?? null;
  return { channels, stars, sections, calls, session, addChannel, sectionOf };
}

type Slack = ReturnType<typeof fakeSlack>;

function fakeLinear(slack: Slack, clock: { now: number }) {
  const projects = new Map<string, LinearProject>();
  const created: NewProject[] = [];
  const channelRequests: { projectId: string; name: string }[] = [];
  const updates: { id: string; statusId: string }[] = [];
  const side = {
    settings: { integrationId: "int-slack", prefix: "project-" } as {
      integrationId: string;
      prefix: string;
    } | null,
    /** When true, Linear accepts a channel request but the channel appears only on `finish`. */
    slow: false,
    pending: [] as { projectId: string; name: string }[],
    /** When true, the next projectCreate succeeds but its answer is lost. */
    loseAnswer: false,
  };
  const finish = () => {
    for (const { projectId, name } of side.pending.splice(0))
      projects.get(projectId)!.slackChannelId = slack.addChannel(name).id;
  };
  const add = (name: string, status = "Backlog:backlog", createdAt = Date.UTC(2026, 10, 1)) => {
    const [statusName, type] = status.split(":") as [string, string];
    const project: LinearProject = {
      id: `project-${projects.size + 1}`,
      name,
      url: `https://linear.app/leonsilicon/project/${name}-${projects.size + 1}`,
      status: { name: statusName, type },
      slackChannelId: null,
      teamKeys: ["LEON"],
      createdAt,
      gone: false,
    };
    projects.set(project.id, project);
    return project;
  };
  const copy = (p: LinearProject) => ({ ...p, status: { ...p.status } });
  const api: DailyLinear = {
    openProjects: async (team, closed) =>
      [...projects.values()]
        .filter((p) => p.teamKeys.includes(team) && !p.gone && !closed.includes(p.status.type))
        .map(copy),
    projectsNamed: async (team, names) =>
      [...projects.values()]
        .filter((p) => p.teamKeys.includes(team) && names.includes(p.name))
        .map(copy),
    project: async (id) => {
      const p = projects.get(id);
      return p ? copy(p) : null;
    },
    team: async (key) => (key === "LEON" ? { id: "team-leon", states: [] } : null),
    projectStatuses: async () => [
      { id: "ps-planned", name: "Planned", type: "planned" },
      { id: "ps-backlog", name: "Backlog", type: "backlog" },
      { id: "ps-completed", name: "Completed", type: "completed" },
      { id: "ps-canceled", name: "Canceled", type: "canceled" },
    ],
    updateProject: async (id, input) => {
      updates.push({ id, statusId: input.statusId });
      const project = projects.get(id)!;
      const status = input.statusId.slice("ps-".length);
      project.status = { name: status[0]!.toUpperCase() + status.slice(1), type: status };
    },
    createProject: async (input) => {
      if (projects.has(input.id)) throw new Error("Entity already exists");
      created.push(input);
      const project: LinearProject = {
        id: input.id,
        name: input.name,
        url: `https://linear.app/leonsilicon/project/${input.name}`,
        status: { name: "Backlog", type: "backlog" },
        slackChannelId: null,
        teamKeys: ["LEON"],
        createdAt: clock.now,
        gone: false,
      };
      projects.set(project.id, project);
      if (side.loseAnswer) {
        side.loseAnswer = false;
        throw new Error("fetch failed");
      }
      return copy(project);
    },
    projectChannelSettings: async () => side.settings,
    createProjectChannel: async (input) => {
      channelRequests.push({ projectId: input.projectId, name: input.name });
      side.pending.push({ projectId: input.projectId, name: input.name });
      if (!side.slow) finish();
    },
  };
  return { api, projects, created, channelRequests, updates, side, finish, add };
}

function setup(now = NOV_21_AFTERNOON) {
  const clock = { now };
  const slack = fakeSlack();
  const linear = fakeLinear(slack, clock);
  let state: DailyState = { days: {} };
  const logs: { event: string; fields?: Record<string, unknown> }[] = [];
  const daily = new Daily({
    config: loadConfig({ SLACK_HERMES_USER_ID: HERMES }),
    linear: linear.api,
    session: slack.session,
    store: {
      get: async () => structuredClone(state),
      put: async (next) => {
        state = structuredClone(next);
      },
    },
    now: () => clock.now,
    sleep: async () => {},
    log: (event, fields) => logs.push({ event, fields }),
  });
  return { clock, slack, linear, daily, logs, state: () => state };
}

/** The day projects as they stood on 2026-11-21, made by Grok Bot's routine, before dailylinear. */
function before(env: ReturnType<typeof setup>) {
  const { linear, slack } = env;
  const nov20 = linear.add("20261120");
  nov20.slackChannelId = slack.addChannel("project-2026-11-20", [LINEAR_BOT, LEON, HERMES]).id;
  slack.sections.find((s) => s.name === "Projects")!.channelIds.push(nov20.slackChannelId);
  const nov21 = linear.add("20261121");
  nov21.slackChannelId = slack.addChannel("project-2026-11-21", [LINEAR_BOT, LEON, HERMES]).id;
  slack.stars.add(nov21.slackChannelId);
  return { nov20, nov21 };
}

const mutating =
  /^(stars\.(add|remove)|conversations\.(rename|join|invite|archive)|users\.channelSections\.(create|channels|delete))/;

const channelOf = (slack: Slack, project: LinearProject) =>
  slack.channels.find((c) => c.id === project.slackChannelId)!;

test("at midnight the day gets its project and starred channel, and the day before is done", async () => {
  const env = setup();
  const { clock, slack, linear, daily } = env;
  const { nov20, nov21 } = before(env);
  const general = slack.addChannel("general", [LEON]);
  slack.stars.add(general.id);

  // The first run takes over what's there: today's stays, and the days before are done.
  const first = await daily.run();
  assert.equal(first.status, "ready");
  assert.equal(first.created, false);
  assert.equal(first.project!.id, nov21.id);
  assert.deepEqual(first.done, ["2026-11-20"]);
  assert.equal(first.next, NOV_22_MIDNIGHT);
  assert.equal(linear.created.length, 0);
  assert.ok(slack.stars.has(nov21.slackChannelId!));
  assert.deepEqual(linear.updates, [{ id: nov20.id, statusId: "ps-completed" }]);
  assert.equal(channelOf(slack, nov20).archived, true);
  assert.equal(slack.sectionOf(nov20.slackChannelId!), null, "out of Projects");
  assert.equal(
    slack.sections.find((s) => s.name === "Projects"),
    undefined,
    "the emptied section is gone",
  );

  clock.now = NOV_22_MIDNIGHT + 1_000;
  const result = await daily.run();
  assert.equal(result.status, "ready");
  assert.equal(result.created, true);
  assert.deepEqual(linear.created, [
    {
      id: await dayProjectId("LEON", "2026-11-22"),
      name: "20261122",
      teamIds: ["team-leon"],
      statusId: "ps-backlog",
      startDate: "2026-11-22",
      targetDate: "2026-11-22",
    },
  ]);
  const nov22 = linear.projects.get(result.project!.id)!;
  assert.deepEqual(linear.channelRequests, [{ projectId: nov22.id, name: "project-2026-11-22" }]);
  const channel = channelOf(slack, nov22);
  assert.equal(channel.name, "project-2026-11-22");
  assert.deepEqual([...channel.members].sort(), [LINEAR_BOT, LEON, HERMES].sort());
  assert.deepEqual([...slack.stars].sort(), [general.id, channel.id].sort());
  assert.equal(slack.sectionOf(channel.id), null);
  assert.ok(slack.stars.has(general.id), "a channel Leon starred himself stays starred");
  // Yesterday: unstarred, archived, and its project Completed.
  assert.deepEqual(result.done, ["2026-11-21"]);
  assert.equal(nov21.status.type, "completed");
  assert.equal(channelOf(slack, nov21).archived, true);
  assert.equal(result.next, NOV_23_MIDNIGHT);

  // Settled: running again changes nothing.
  const calls = slack.calls.length;
  clock.now += 3600_000;
  const again = await daily.run();
  assert.equal(again.created, false);
  assert.deepEqual(again.done, []);
  assert.equal(linear.created.length, 1);
  assert.equal(linear.updates.length, 2);
  assert.ok(!slack.calls.slice(calls).some((c) => mutating.test(c.method)));
});

test("a past day's project is done even without a channel; one Leon reopens stays open", async () => {
  const { linear, daily } = setup();
  const nov18 = linear.add("2026-11-18");
  assert.deepEqual((await daily.run()).done, ["2026-11-18"]);
  assert.equal(nov18.status.type, "completed");
  assert.equal(linear.channelRequests.filter((r) => r.projectId === nov18.id).length, 0);

  nov18.status = { name: "Backlog", type: "backlog" };
  assert.deepEqual((await daily.run()).done, []);
  assert.equal(nov18.status.type, "backlog");
});

test("an answer lost after Linear made the project doesn't make a second one", async () => {
  const { linear, daily } = setup(NOV_22_MIDNIGHT);
  linear.side.loseAnswer = true;
  const result = await daily.run();
  assert.equal(result.status, "ready");
  assert.equal(linear.projects.size, 1);
  assert.equal(result.project!.id, await dayProjectId("LEON", "2026-11-22"));
});

test("a day whose project Leon closed or deleted gets no new one", async () => {
  const env = setup();
  const { slack, linear, daily, logs } = env;
  const { nov21 } = before(env);
  await daily.run();
  nov21.status = { name: "Canceled", type: "canceled" };

  const result = await daily.run();
  assert.equal(result.status, "closed");
  assert.equal(result.project, null);
  assert.equal(linear.created.length, 0);
  assert.ok(!slack.stars.has(nov21.slackChannelId!), "its channel is unstarred");
  assert.equal(result.next, NOV_22_MIDNIGHT);
  assert.ok(logs.some((l) => l.event === "forgot_day"));

  nov21.status = { name: "Backlog", type: "backlog" };
  nov21.gone = true;
  assert.equal((await daily.run()).status, "closed", "a deleted one neither");
});

test("a slow channel is waited for, asked for once, and stars when it comes", async () => {
  const env = setup();
  const { clock, slack, linear, daily } = env;
  const { nov21 } = before(env);
  await daily.run();
  linear.side.slow = true;

  clock.now = NOV_22_MIDNIGHT;
  const waiting = await daily.run();
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.next, NOV_22_MIDNIGHT + WAITING_RETRY_MS);
  assert.equal(channelOf(slack, nov21).archived, true, "the day before is done all the same");

  clock.now += WAITING_RETRY_MS;
  await daily.run();
  assert.equal(linear.channelRequests.length, 1, "not asked again yet");

  linear.finish();
  clock.now += WAITING_RETRY_MS;
  const ready = await daily.run();
  assert.equal(ready.status, "ready");
  const nov22 = linear.projects.get(ready.project!.id)!;
  assert.deepEqual([...slack.stars], [nov22.slackChannelId]);
});

test("a channel that never comes is asked for again after 30 minutes", async () => {
  const { clock, linear, daily } = setup(NOV_22_MIDNIGHT);
  linear.side.slow = true;
  await daily.run();
  linear.side.pending.length = 0;
  clock.now += CHANNEL_RETRY_MS - 1;
  await daily.run();
  assert.equal(linear.channelRequests.length, 1);
  clock.now += 1;
  linear.side.slow = false;
  assert.equal((await daily.run()).status, "ready");
  assert.equal(linear.channelRequests.length, 2);
});

test("a day's project Leon made in Linear gets Linear's own channel first, renamed for the day", async () => {
  const { clock, slack, linear, daily } = setup(NOV_22_MIDNIGHT);
  const mine = linear.add("2026-11-22", "Backlog:backlog", clock.now);
  const waiting = await daily.run();
  assert.equal(waiting.status, "waiting", "Linear's app has five minutes to make one");
  assert.equal(linear.created.length, 0);
  assert.equal(linear.channelRequests.length, 0);

  mine.slackChannelId = slack.addChannel("project-20261122").id;
  clock.now += 60_000;
  assert.equal((await daily.run()).status, "ready");
  const channel = slack.channels.find((c) => c.id === mine.slackChannelId)!;
  assert.equal(channel.name, "project-2026-11-22");
  assert.ok(slack.stars.has(channel.id));
});

test("with Linear's project channels off, it says so and looks again later", async () => {
  const { linear, daily } = setup(NOV_22_MIDNIGHT);
  linear.side.settings = null;
  const result = await daily.run();
  assert.equal(result.status, "off");
  assert.equal(result.next, NOV_22_MIDNIGHT + CHANNEL_RETRY_MS);
  assert.equal(linear.projects.size, 1, "the project is still made");
});

test("a day's channel Leon unstarred stays unstarred until the next day", async () => {
  const { clock, slack, linear, daily } = setup(NOV_22_MIDNIGHT);
  const result = await daily.run();
  const channel = linear.projects.get(result.project!.id)!.slackChannelId!;
  slack.stars.delete(channel);
  clock.now += 3600_000;
  await daily.run();
  assert.ok(!slack.stars.has(channel));
});

test("tomorrow's project made ahead waits under Projects for its day", async () => {
  const env = setup();
  const { clock, slack, linear, daily } = env;
  const { nov21 } = before(env);
  const nov22 = linear.add("20261122", "Backlog:backlog", NOV_21_AFTERNOON - 3600_000);
  nov22.slackChannelId = slack.addChannel("project-2026-11-22").id;
  await daily.run();
  assert.equal(slack.sectionOf(nov22.slackChannelId), "Projects");
  assert.ok(slack.stars.has(nov21.slackChannelId!));

  clock.now = NOV_22_MIDNIGHT;
  const result = await daily.run();
  assert.equal(result.project!.id, nov22.id, "Leon's is today's; no second one is made");
  assert.equal(linear.created.length, 0);
  assert.deepEqual([...slack.stars], [nov22.slackChannelId]);
  assert.equal(slack.sectionOf(nov22.slackChannelId), null);
  assert.equal(nov21.status.type, "completed");
});

test("a date name another channel holds is left alone, and the channel is still starred", async () => {
  const { slack, linear, daily } = setup(NOV_22_MIDNIGHT);
  slack.addChannel("project-2026-11-22", [LEON]);
  const result = await daily.run();
  const channel = slack.channels.find(
    (c) => c.id === linear.projects.get(result.project!.id)!.slackChannelId,
  )!;
  assert.equal(channel.name, "project-2026-11-22-2", "asked for under a free name");
  assert.ok(slack.stars.has(channel.id));
});

test("loadConfig needs Hermes's Slack user ID", () => {
  assert.throws(() => loadConfig({}), /SLACK_HERMES_USER_ID is required/);
  const config = loadConfig({ SLACK_HERMES_USER_ID: HERMES, SECTION_ORDER: "A,B" });
  assert.equal(config.timeZone, "America/Toronto");
  assert.deepEqual(config.sectionOrder, ["A", "B"]);
  assert.equal(config.projectSection, "Projects");
});
