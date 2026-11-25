import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { LinearProjectText, NewIssue, NewProject, ProjectUpdate } from "#linear";
import {
  isRoutine,
  readSnapshot,
  ROUTINE_MISSING_GRACE_MS,
  routineLink,
  Routines,
  withRoutineLink,
  type MuseSchedule,
  type RoutinesLinear,
} from "#routines";
import type { Sql, SqlValue } from "#store";

const NOW = Date.UTC(2026, 10, 25, 21, 0);

function memorySql(): Sql {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (query: string, ...params: SqlValue[]) => db.prepare(query).all(...params) as never,
  };
}

const STATUSES = [
  { id: "ps-routine", name: "Routine", type: "backlog" },
  { id: "ps-watcher", name: "Watcher", type: "backlog" },
  { id: "ps-progress", name: "In Progress", type: "started" },
  { id: "ps-done", name: "Completed", type: "completed" },
];

function fakeLinear() {
  const projects = new Map<string, LinearProjectText>();
  const created: NewProject[] = [];
  const updated: { id: string; input: ProjectUpdate }[] = [];
  const issues: NewIssue[] = [];
  const add = (name: string, status = "Routine", content = "", summary = "") => {
    const s = STATUSES.find((x) => x.name === status)!;
    const project: LinearProjectText = {
      id: `p-${projects.size + 1}`,
      name,
      url: `https://linear.app/x/project/${projects.size + 1}`,
      status: { name: s.name, type: s.type },
      slackChannelId: null,
      teamKeys: ["LEON"],
      createdAt: NOW - 86_400_000,
      gone: false,
      summary,
      content,
    };
    projects.set(project.id, project);
    return project;
  };
  const api: RoutinesLinear = {
    projectsInStatus: async (_team, status) =>
      [...projects.values()].filter((p) => p.status.name === status && !p.gone),
    projectStatuses: async () => STATUSES,
    projectText: async (id) => projects.get(id) ?? null,
    createProject: async (input) => {
      if (projects.has(input.id)) throw new Error("Entity already exists");
      created.push(input);
      const s = STATUSES.find((x) => x.id === input.statusId)!;
      const project: LinearProjectText = {
        id: input.id,
        name: input.name,
        url: `https://linear.app/x/project/${input.id}`,
        status: { name: s.name, type: s.type },
        slackChannelId: null,
        teamKeys: ["LEON"],
        createdAt: NOW,
        gone: false,
        summary: input.description ?? "",
        content: input.content ?? "",
      };
      projects.set(project.id, project);
      return project;
    },
    updateProject: async (id, input) => {
      updated.push({ id, input });
      const project = projects.get(id)!;
      if (input.content !== undefined) project.content = input.content;
      if (input.statusId) {
        const s = STATUSES.find((x) => x.id === input.statusId)!;
        project.status = { name: s.name, type: s.type };
      }
    },
    team: async () => ({
      id: "team-leon",
      states: [
        { id: "st-hermes", name: "Awaiting Hermes", type: "started" },
        { id: "st-done", name: "Done", type: "completed" },
      ],
    }),
    createIssue: async (input) => {
      if (issues.some((i) => i.id === input.id)) throw new Error("Entity already exists");
      issues.push(input);
      return {
        id: input.id,
        identifier: `LEON-${600 + issues.length}`,
        number: 600 + issues.length,
        title: input.title,
        url: "",
        description: input.description,
        priority: 0,
        state: { id: input.stateId, name: "Awaiting Hermes", type: "started" },
        teamKey: "LEON",
        dueDate: null,
      };
    },
  };
  return { api, projects, created, updated, issues, add };
}

function setup() {
  const linear = fakeLinear();
  let now = NOW;
  const routines = new Routines({
    config: {
      teamKey: "LEON",
      routineProjectStatus: "Routine",
      hermesState: "Awaiting Hermes",
      closedProjectTypes: ["completed", "canceled"],
    },
    linear: linear.api,
    sql: memorySql(),
    now: () => now,
  });
  return { linear, routines, advance: (ms: number) => (now += ms), now: () => now };
}

const heartbeat: MuseSchedule = {
  id: "heartbeat",
  title: null,
  schedule_key: "interval@30m",
  mode: "heartbeat",
  enabled: true,
  is_heartbeat: true,
  cadence: { kind: "interval" },
};
const briefing: MuseSchedule = {
  id: "morning-briefing",
  title: "Morning briefing",
  schedule_key: "daily@08:00",
  mode: "task",
  enabled: true,
  is_heartbeat: false,
  timezone: "America/Toronto",
  path: "/home/hatch/workspace/goals/briefing/crons/daily/morning-briefing__daily@08:00.md",
  cadence: { kind: "daily" },
};
const reminder: MuseSchedule = {
  id: "bring-gorilla-tripod-reminder",
  title: "Bring gorilla tripod reminder",
  schedule_key: "runonce@2026-11-26T07:45:00",
  mode: "task",
  enabled: true,
  cadence: { kind: "runonce" },
};
const snap = (at: number, ...schedules: MuseSchedule[]) => ({ at, schedules, invalid: [] });

test("a Routine project links to its Muse routine with one line in its body", () => {
  assert.equal(routineLink("Muse routine: `morning-briefing`\n\nMore."), "morning-briefing");
  assert.equal(routineLink("Intro\n**Muse routine:** `weekly_review`"), "weekly_review");
  assert.equal(routineLink("Muse routine: weekly\\_review"), "weekly_review");
  assert.equal(routineLink("The Muse routine: runs daily"), null);
  assert.equal(routineLink(""), null);
  assert.equal(
    withRoutineLink("Muse routine: `old`\n\nNotes stay.", "new-one"),
    "Muse routine: `new-one`\n\nNotes stay.",
  );
  assert.equal(withRoutineLink("", "x"), "Muse routine: `x`");
});

test("only repeating schedules are routines, never Muse's heartbeat", () => {
  assert.equal(isRoutine(briefing), true);
  assert.equal(isRoutine(heartbeat), false);
  assert.equal(isRoutine(reminder), false);
  assert.equal(isRoutine({ id: "x", schedule_key: "weekly@mon-09:00" }), true);
  assert.equal(isRoutine({ id: "x", schedule_key: "runonce@2026-12-01T09:00:00" }), false);
});

test("a snapshot is read defensively", () => {
  assert.equal(readSnapshot(null), null);
  assert.equal(readSnapshot({ at: "now", schedules: [] }), null);
  const read = readSnapshot({
    at: NOW,
    schedules: [briefing, { id: "../etc" }, { title: "no id" }],
    invalid: ["broken-one", { path: "/w/goals/g/crons/daily/other__daily@09:00.md" }, 7],
  });
  assert.deepEqual(
    read?.schedules.map((s) => s.id),
    ["morning-briefing"],
  );
  assert.deepEqual(read?.invalid, ["broken-one", "other"]);
});

test("a routine Muse runs gets a Routine project linked to it, once", async () => {
  const { linear, routines, advance, now } = setup();
  const report = await routines.run(snap(now(), heartbeat, briefing, reminder));
  assert.deepEqual(report.created, ["morning-briefing"]);
  assert.equal(linear.created.length, 1);
  const [made] = linear.created;
  assert.equal(made!.name, "Morning briefing");
  assert.equal(made!.statusId, "ps-routine");
  assert.equal(routineLink(made!.content!), "morning-briefing");
  assert.match(made!.description!, /daily@08:00 \(America\/Toronto\)/);
  assert.match(made!.content!, /goals\/briefing\/crons\/daily/);
  assert.equal(linear.issues.length, 0);

  advance(10 * 60_000);
  const again = await routines.run(snap(now(), heartbeat, briefing, reminder));
  assert.deepEqual(again.created, []);
  assert.equal(linear.created.length, 1);
});

test("a paused routine without a project gets none", async () => {
  const { linear, routines, now } = setup();
  await routines.run(snap(now(), heartbeat, { ...briefing, enabled: false }));
  assert.equal(linear.created.length, 0);
});

test("an unlinked Routine project named like the routine gets the link instead of a twin", async () => {
  const { linear, routines, now } = setup();
  const project = linear.add("Morning Briefing", "Routine", "What it covers.");
  const report = await routines.run(snap(now(), heartbeat, briefing));
  assert.deepEqual(report.linked, ["morning-briefing"]);
  assert.equal(linear.created.length, 0);
  assert.equal(project.content, "Muse routine: `morning-briefing`\n\nWhat it covers.");
  assert.equal(linear.issues.length, 0);
});

test("a Routine project with no link asks Hermes once, in that project", async () => {
  const { linear, routines, advance, now } = setup();
  const taxes = linear.add("Taxes", "Routine");
  linear.add("20261125", "Routine"); // a day's project is dailylinear's, never a routine
  const report = await routines.run(snap(now(), heartbeat));
  assert.deepEqual(report.raised, [`unlinked:${taxes.id}`]);
  assert.equal(linear.issues.length, 1);
  const [issue] = linear.issues;
  assert.equal(issue!.title, "Link Taxes to its Muse routine");
  assert.equal(issue!.projectId, taxes.id);
  assert.equal(issue!.stateId, "st-hermes");
  assert.match(issue!.description, /tasks\.list/);

  advance(10 * 60_000);
  await routines.run(snap(now(), heartbeat));
  assert.equal(linear.issues.length, 1);
});

test("a link to a routine Muse no longer has is raised after a grace period", async () => {
  const { linear, routines, advance, now } = setup();
  const project = linear.add("Weekly review", "Routine", "Muse routine: `weekly-review`");
  await routines.run(snap(now(), heartbeat));
  assert.equal(linear.issues.length, 0);
  advance(10 * 60_000);
  await routines.run(snap(now(), heartbeat));
  assert.equal(linear.issues.length, 0);
  advance(ROUTINE_MISSING_GRACE_MS);
  const report = await routines.run(snap(now(), heartbeat));
  assert.deepEqual(report.raised, [`missing:${project.id}:weekly-review`]);
  assert.equal(linear.issues[0]!.title, "Weekly review's Muse routine is gone");
});

test("a routine that comes back, or is only unreadable, is not raised", async () => {
  const { linear, routines, advance, now } = setup();
  linear.add("Weekly review", "Routine", "Muse routine: `weekly-review`");
  const weekly = { ...briefing, id: "weekly-review", title: "Weekly review" };
  await routines.run(snap(now(), heartbeat));
  advance(15 * 60_000);
  await routines.run(snap(now(), heartbeat, weekly));
  advance(15 * 60_000);
  await routines.run(snap(now(), heartbeat));
  advance(15 * 60_000);
  await routines.run({ at: now(), schedules: [heartbeat], invalid: ["weekly-review"] });
  assert.equal(linear.issues.length, 0);
});

test("a routine still running after its project left Routine asks Hermes, and no twin is made", async () => {
  const { linear, routines, advance, now } = setup();
  await routines.run(snap(now(), heartbeat, briefing));
  const [made] = linear.created;
  const project = linear.projects.get(made!.id)!;
  project.status = { name: "Completed", type: "completed" };
  advance(10 * 60_000);
  const report = await routines.run(snap(now(), heartbeat, briefing));
  assert.deepEqual(report.created, []);
  assert.deepEqual(report.raised, [`left:${project.id}:morning-briefing:Completed`]);
  assert.equal(linear.issues[0]!.projectId, project.id);
  assert.match(linear.issues[0]!.description, /tasks\.pause/);
  assert.equal(linear.created.length, 1);
});

test("a deleted routine project is asked about, not made again", async () => {
  const { linear, routines, advance, now } = setup();
  await routines.run(snap(now(), heartbeat, briefing));
  linear.projects.get(linear.created[0]!.id)!.gone = true;
  advance(10 * 60_000);
  const report = await routines.run(snap(now(), heartbeat, briefing));
  assert.deepEqual(report.raised, ["deleted:morning-briefing"]);
  assert.equal(linear.issues[0]!.projectId, undefined);
  assert.equal(linear.created.length, 1);
});

test("old, repeated or empty snapshots change nothing", async () => {
  const { linear, routines, advance, now } = setup();
  linear.add("Taxes", "Routine");
  assert.equal((await routines.run(snap(now() - 31 * 60_000, heartbeat))).skipped, "stale");
  assert.equal((await routines.run(snap(now()))).skipped, "empty");
  await routines.run(snap(now(), heartbeat));
  assert.equal((await routines.run(snap(now(), heartbeat))).skipped, "older than the last one");
  advance(1);
  assert.equal(linear.issues.length, 1);
});
