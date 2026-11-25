import type { SyncConfig } from "#config";
import { projectDay } from "#format";
import type { LinearClient } from "#linear";
import type { Sql } from "#store";
import { stableUuid } from "#sync";

/**
 * A scheduled task in Leon's Muse, as the Muse app's `tasks.list` answers it. Muse keeps each one as
 * a file in its workspace (`goals/<goal>/crons/<cadence>/<id>__<schedule_key>.md`).
 */
export interface MuseSchedule {
  /** Stable, a slug: `morning-briefing`. */
  id: string;
  title?: string | null;
  /** `daily@08:00`, `weekly@mon,thu-09:30`, `interval@30m`, `runonce@2026-11-26T07:45:00`… */
  schedule_key?: string;
  /** `task`, or `heartbeat` for Muse's own heartbeat. */
  mode?: string;
  enabled?: boolean;
  is_heartbeat?: boolean;
  timezone?: string | null;
  path?: string | null;
  /** `runonce`, `hourly`, `interval`, `daily`, `weekly`, `monthly` or `yearly`. */
  cadence?: { kind?: string } | null;
}

/** What the hermes22muse relay sends: Muse's scheduled tasks as it read them at `at` (ms). */
export interface RoutineSnapshot {
  at: number;
  schedules: MuseSchedule[];
  /** Schedule files Muse couldn't read. Their IDs aren't missing, just broken for now. */
  invalid: string[];
}

/** What a run did, for logs and tests. */
export interface RoutineReport {
  skipped?: string;
  created: string[];
  linked: string[];
  raised: string[];
}

/** The Linear calls the routine sync makes; `LinearClient` has them all. */
export type RoutinesLinear = Pick<
  LinearClient,
  | "projectsInStatus"
  | "projectStatuses"
  | "projectText"
  | "createProject"
  | "updateProject"
  | "team"
  | "createIssue"
>;

export interface RoutinesDeps {
  config: Pick<
    SyncConfig,
    "teamKey" | "routineProjectStatus" | "hermesState" | "closedProjectTypes"
  >;
  linear: RoutinesLinear;
  sql: Sql;
  now?: () => number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

/** A snapshot older than this when its job runs is out of date: the next one is on its way. */
export const ROUTINE_SNAPSHOT_MAX_AGE_MS = 30 * 60_000;
/** A linked routine must be missing from Muse for this long before Hermes is asked about it. */
export const ROUTINE_MISSING_GRACE_MS = 20 * 60_000;

/** The line in a Routine project's body that links it to its Muse routine. */
const LINK_LINE =
  /^[ \t]*(?:\*\*)?Muse routine:(?:\*\*)?[ \t]*`?([A-Za-z0-9](?:[\w.-]|\\[_-])*)`?[ \t]*$/im;

/** The Muse routine a project's body links to, or null. */
export function routineLink(content: string): string | null {
  const match = LINK_LINE.exec(content);
  return match ? match[1]!.replace(/\\/g, "") : null;
}

/** The project body with its link set to `id`: the link line first, the rest kept. */
export function withRoutineLink(content: string, id: string): string {
  const rest = content.replace(LINK_LINE, "").trim();
  return rest ? `Muse routine: \`${id}\`\n\n${rest}` : `Muse routine: \`${id}\``;
}

/** Whether a Muse schedule is a routine: it repeats and isn't Muse's own heartbeat. */
export function isRoutine(schedule: MuseSchedule): boolean {
  if (schedule.is_heartbeat || schedule.mode === "heartbeat") return false;
  const kind = schedule.cadence?.kind ?? schedule.schedule_key?.split("@")[0];
  return kind !== "runonce";
}

/** A routine's name for its project: Muse's title, else its ID in words. */
export function routineName(schedule: MuseSchedule): string {
  const title = schedule.title?.trim();
  if (title) return title.slice(0, 80);
  const words = schedule.id.replace(/[-_]+/g, " ").trim();
  return (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, 80) || schedule.id;
}

const sameName = (a: string, b: string) =>
  a.toLowerCase().replace(/[^a-z0-9]+/g, "") === b.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** When it runs, as Muse names it: `daily@08:00 (America/Toronto)`. */
function cadenceLabel(schedule: MuseSchedule): string {
  const key = schedule.schedule_key || schedule.cadence?.kind || "a schedule";
  return schedule.timezone ? `${key} (${schedule.timezone})` : key;
}

/** The summary and body of a project made for a Muse routine. */
export function routineProjectText(schedule: MuseSchedule): { summary: string; content: string } {
  const file = schedule.path?.replace(/^\/home\/hatch\/workspace\//, "");
  return {
    summary: `Muse routine · ${cadenceLabel(schedule)}`.slice(0, 255),
    content: [
      `Muse routine: \`${schedule.id}\``,
      `One of Leon's routines: Muse runs it on its own schedule, \`${cadenceLabel(schedule)}\`.${
        file ? ` Its definition is \`${file}\` in Muse's workspace.` : ""
      }`,
      "Change, pause or stop it in Muse (through Hermes), never only here. While it runs, this project stays in Routine and work about the routine goes in it.",
    ].join("\n\n"),
  };
}

/** A snapshot from the relay, checked field by field. Null when it isn't one. */
export function readSnapshot(input: unknown): RoutineSnapshot | null {
  if (!input || typeof input !== "object") return null;
  const { at, schedules, invalid } = input as Record<string, unknown>;
  if (typeof at !== "number" || !Number.isFinite(at) || !Array.isArray(schedules)) return null;
  const valid = schedules.filter(
    (s): s is MuseSchedule =>
      Boolean(s) &&
      typeof s === "object" &&
      typeof (s as MuseSchedule).id === "string" &&
      /^[\w.-]{1,200}$/.test((s as MuseSchedule).id),
  );
  const broken = (Array.isArray(invalid) ? invalid : []).flatMap((entry: unknown) => {
    if (typeof entry === "string") return [entry];
    if (entry && typeof entry === "object") {
      const { id, path } = entry as { id?: unknown; path?: unknown };
      if (typeof id === "string") return [id];
      if (typeof path === "string") {
        const stem = path.split("/").pop()?.split("__")[0];
        return stem ? [stem] : [];
      }
    }
    return [];
  });
  return { at, schedules: valid, invalid: broken };
}

interface Problem {
  /** Asked about once: the same key never raises a second issue. */
  key: string;
  /** The project the issue goes in; none when the project is gone. */
  project: { id: string; name: string } | null;
  title: string;
  description: string;
}

/**
 * Keeps Linear's Routine projects in step with Leon's routines in Muse (Leon's rule, 2026-11-25):
 * each routine Muse runs is one project in Routine whose body links to it with a
 * `Muse routine: \`<id>\`` line. A routine without a project gets one; an unlinked project with the
 * routine's name gets the link. What needs judgment (a Routine project with no link, a link to a
 * routine Muse no longer has, a routine still running whose project left Routine) becomes an
 * Awaiting Hermes issue in that project, asked once.
 *
 * Muse's schedules come from Hermes Cloud, where the hermes22muse relay reads them from the Muse
 * app every few minutes and posts them through autolinear's Worker to this sync's queue.
 */
export class Routines {
  readonly #c: RoutinesDeps["config"];
  readonly #linear: RoutinesLinear;
  readonly #sql: Sql;
  readonly #now: () => number;
  readonly #log: (event: string, fields?: Record<string, unknown>) => void;

  constructor(deps: RoutinesDeps) {
    this.#c = deps.config;
    this.#linear = deps.linear;
    this.#sql = deps.sql;
    this.#now = deps.now ?? Date.now;
    this.#log = deps.log ?? (() => {});
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS routine_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
  }

  #get(key: string): string | null {
    const row = this.#sql.exec(`SELECT value FROM routine_state WHERE key = ?`, key)[0];
    return row ? String(row.value) : null;
  }

  #put(key: string, value: string): void {
    this.#sql.exec(
      `INSERT INTO routine_state (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  #drop(key: string): void {
    this.#sql.exec(`DELETE FROM routine_state WHERE key = ?`, key);
  }

  /** Every project the sync has seen linked to a routine, open or not: project ID → routine ID. */
  #links(): Map<string, string> {
    return new Map(
      this.#sql
        .exec(`SELECT key, value FROM routine_state WHERE substr(key, 1, 5) = 'link:'`)
        .map((row) => [String(row.key).slice(5), String(row.value)]),
    );
  }

  async run(input: unknown): Promise<RoutineReport> {
    const report: RoutineReport = { created: [], linked: [], raised: [] };
    const snapshot = readSnapshot(input);
    const now = this.#now();
    if (!snapshot) return { ...report, skipped: "not a snapshot" };
    if (snapshot.at < now - ROUTINE_SNAPSHOT_MAX_AGE_MS) return { ...report, skipped: "stale" };
    const last = Number(this.#get("snapshot-at") ?? 0);
    if (snapshot.at <= last) return { ...report, skipped: "older than the last one" };
    // Muse always lists its own heartbeat. An empty list is a bad read, not a Muse with no routines.
    if (!snapshot.schedules.length) return { ...report, skipped: "empty" };

    const known = new Set([...snapshot.schedules.map((s) => s.id), ...snapshot.invalid]);
    const running = snapshot.schedules.filter((s) => isRoutine(s) && s.enabled !== false);
    const projects = (
      await this.#linear.projectsInStatus(this.#c.teamKey, this.#c.routineProjectStatus)
    ).filter((project) => projectDay(project.name) === null);

    const linkOf = new Map<string, string>();
    for (const project of projects) {
      const id = routineLink(project.content);
      if (!id) continue;
      linkOf.set(project.id, id);
      this.#put(`link:${project.id}`, id);
    }
    const remembered = this.#links();
    const problems: Problem[] = [];

    for (const routine of running) {
      if ([...linkOf.values()].includes(routine.id)) continue;
      const name = routineName(routine);
      const twin = projects.find((p) => !linkOf.has(p.id) && sameName(p.name, name));
      if (twin) {
        await this.#linear.updateProject(twin.id, {
          content: withRoutineLink(twin.content, routine.id),
        });
        linkOf.set(twin.id, routine.id);
        this.#put(`link:${twin.id}`, routine.id);
        report.linked.push(routine.id);
        this.#log("routine_linked", { routine: routine.id, project: twin.name });
        continue;
      }
      // Projects that linked it before and aren't open in Routine now: moved or closed.
      const madeId = await stableUuid(`routine:${this.#c.teamKey}:${routine.id}`);
      const before = [...remembered].filter(([, id]) => id === routine.id).map(([pid]) => pid);
      let elsewhere = false;
      for (const projectId of before) {
        const project = await this.#linear.projectText(projectId);
        if (!project || project.gone) {
          if (projectId !== madeId) {
            this.#drop(`link:${projectId}`);
            continue;
          }
          // Someone deleted the project made for it: ask rather than make it again.
          elsewhere = true;
          problems.push({
            key: `deleted:${routine.id}`,
            project: null,
            title: `${routineName(routine)}'s Routine project was deleted, but the routine still runs`,
            description: [
              `Leon's Muse routine \`${routine.id}\` (${cadenceLabel(routine)}) still runs, and the ${this.#c.routineProjectStatus} project made for it in Linear was deleted.`,
              `Ask Leon whether the routine should stop. If it should, pause it (\`muse_app\` \`tasks.pause\`) or delete it (\`tasks.delete\`) in Muse. If it should keep running, restore the project from Linear's trash.`,
            ].join("\n\n"),
          });
          continue;
        }
        elsewhere = true;
        if (project.status.name === this.#c.routineProjectStatus) continue; // its link line was removed
        const closed = this.#c.closedProjectTypes.includes(project.status.type);
        problems.push({
          key: `left:${project.id}:${routine.id}:${project.status.name}`,
          project,
          title: `${project.name} is ${project.status.name}, but its Muse routine still runs`,
          description: [
            `[${project.name}](${project.url}) is linked to Leon's Muse routine \`${routine.id}\` (${cadenceLabel(routine)}), which Muse still runs, but the project is now **${project.status.name}**${closed ? ", so it's over" : ""}.`,
            `Ask Leon whether the routine should stop. If it should, pause it (\`muse_app\` \`tasks.pause\`) or delete it (\`tasks.delete\`) in Muse. If it should keep running, move the project back to ${this.#c.routineProjectStatus}.`,
          ].join("\n\n"),
        });
      }
      if (elsewhere) continue;

      const team = await this.#team();
      const status = await this.#routineStatus();
      const text = routineProjectText(routine);
      try {
        await this.#linear.createProject({
          id: madeId,
          name,
          teamIds: [team.id],
          statusId: status,
          description: text.summary,
          content: text.content,
        });
      } catch (error) {
        if (!/already exists/i.test(String(error))) throw error;
      }
      this.#put(`link:${madeId}`, routine.id);
      report.created.push(routine.id);
      this.#log("routine_project_created", { routine: routine.id, name });
    }

    for (const project of projects) {
      const id = linkOf.get(project.id);
      if (!id) {
        problems.push({
          key: `unlinked:${project.id}`,
          project,
          title: `Link ${project.name} to its Muse routine`,
          description: [
            `[${project.name}](${project.url}) is in ${this.#c.routineProjectStatus}, and every ${this.#c.routineProjectStatus} project is one of Leon's routines in Muse (Leon's rule, 2026-11-25). Its body has no line like \`Muse routine: morning-briefing\` linking it to one.`,
            `Find the routine with \`muse_app\` \`tasks.list\` (its \`id\`), or, if Leon wants this done on a schedule and Muse has no routine for it yet, have Muse create it. Then add the line at the top of the project's body. If the project isn't a routine, ask Leon and move it to the project status that fits.`,
          ].join("\n\n"),
        });
        continue;
      }
      const missingKey = `missing:${project.id}:${id}`;
      if (known.has(id)) {
        this.#drop(missingKey);
        continue;
      }
      const since = Number(this.#get(missingKey) ?? 0);
      if (!since) {
        this.#put(missingKey, String(snapshot.at));
        continue;
      }
      if (snapshot.at - since < ROUTINE_MISSING_GRACE_MS) continue;
      problems.push({
        key: missingKey,
        project,
        title: `${project.name}'s Muse routine is gone`,
        description: [
          `[${project.name}](${project.url}) links to the Muse routine \`${id}\`, and Leon's Muse no longer has a scheduled task with that ID.`,
          `Ask Leon whether it should still run. If it should, have Muse create it again and put its new ID in the project's \`Muse routine:\` line. If it's over, move the project to Completed (or Canceled).`,
        ].join("\n\n"),
      });
    }

    for (const problem of problems) if (await this.#raise(problem)) report.raised.push(problem.key);
    this.#put("snapshot-at", String(snapshot.at));
    return report;
  }

  /** Asks Hermes about it with an Awaiting Hermes issue in the project, once per problem. */
  async #raise(problem: Problem): Promise<boolean> {
    const done = `raised:${problem.key}`;
    if (this.#get(done)) return false;
    const team = await this.#team();
    const state = team.states.find((s) => s.name === this.#c.hermesState);
    if (!state) throw new Error(`no ${this.#c.hermesState} status in ${this.#c.teamKey}`);
    try {
      await this.#linear.createIssue({
        id: await stableUuid(`routine-problem:${problem.key}`),
        teamId: team.id,
        title: problem.title,
        description: problem.description,
        stateId: state.id,
        ...(problem.project ? { projectId: problem.project.id } : {}),
      });
    } catch (error) {
      if (!/already exists/i.test(String(error))) throw error;
    }
    this.#put(done, String(this.#now()));
    this.#log("routine_problem", { key: problem.key, project: problem.project?.name ?? null });
    return true;
  }

  #teamCache: Awaited<ReturnType<RoutinesLinear["team"]>> | undefined;
  async #team() {
    this.#teamCache ??= await this.#linear.team(this.#c.teamKey);
    if (!this.#teamCache) throw new Error(`no Linear team ${this.#c.teamKey}`);
    return this.#teamCache;
  }

  async #routineStatus(): Promise<string> {
    const status = (await this.#linear.projectStatuses()).find(
      (s) => s.name === this.#c.routineProjectStatus,
    );
    if (!status) throw new Error(`no project status ${this.#c.routineProjectStatus}`);
    return status.id;
  }
}
