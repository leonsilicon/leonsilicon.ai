import {
  addDays,
  localDay,
  metaInstant,
  PROJECT_GRACE_MS,
  projectChannelName,
  projectDay,
  Sidebar,
  SlackError,
  stableUuid,
  tolerate,
} from "@-/com.leonsilicon.ai.services.linear-slack-sync";
import type {
  LinearProject,
  LinearState,
  LinearTeam,
  NewProject,
  ProjectChannelSettings,
  SlackCall,
} from "@-/com.leonsilicon.ai.services.linear-slack-sync";
import type { DailyConfig } from "#config";

/** What dailylinear needs from Linear. Linear Sync's `LinearClient` has all of it; tests use a fake. */
export interface DailyLinear {
  openProjects(teamKey: string, closedTypes: string[]): Promise<LinearProject[]>;
  /** The team's projects with one of these names, closed, archived and trashed ones included. */
  projectsNamed(teamKey: string, names: string[]): Promise<LinearProject[]>;
  project(id: string): Promise<LinearProject | null>;
  team(key: string): Promise<LinearTeam | null>;
  projectStatuses(): Promise<LinearState[]>;
  createProject(input: NewProject): Promise<LinearProject>;
  updateProject(id: string, input: { statusId: string }): Promise<void>;
  projectChannelSettings(): Promise<ProjectChannelSettings | null>;
  createProjectChannel(input: {
    projectId: string;
    name: string;
    integrationId: string;
  }): Promise<void>;
}

/**
 * Where dailylinear put a day's channel in Leon's sidebar: Starred on its day, under Projects
 * before it (a day's project made ahead of time).
 */
export type Place = "starred" | "projects";

/** What dailylinear remembers about one open day's project between runs. */
export interface DayRecord {
  projectId: string;
  name: string;
  /** `YYYY-MM-DD`. */
  day: string;
  /** The channel last settled: named `project-YYYY-MM-DD`, with Leon and Hermes in it. */
  channelId: string | null;
  /** When dailylinear last asked Linear for the channel (ms). */
  requestedAt: number | null;
  /** Null until placed, and again whenever the channel changes. */
  place: Place | null;
}

/**
 * How today's project stands after a run. `ready`: it has its channel, starred. `waiting`: its
 * channel isn't there yet. `closed`: Leon closed or deleted it, so it isn't made again. `off`:
 * Linear's project channels are off, so no channel can be asked for.
 */
export type DayStatus = "ready" | "waiting" | "closed" | "off";

export interface DailyResult {
  day: string;
  status: DayStatus;
  project: { id: string; name: string; url: string } | null;
  /** Whether this run made today's project. */
  created: boolean;
  /** The past days (`YYYY-MM-DD`) whose project this run marked done, their channels archived. */
  done: string[];
  /** When the run finished, and when the next should start (ms). */
  at: number;
  next: number;
}

export interface DailyState {
  /** By project ID. */
  days: Record<string, DayRecord>;
  /**
   * The projects dailylinear marked done, by project ID, with their day. One Leon reopens is left
   * alone. Kept for `COMPLETED_KEEP_DAYS`.
   */
  completed?: Record<string, string>;
  last?: DailyResult;
}

/** Where the state lives between runs: the Durable Object's storage, or memory in tests. */
export interface DailyStore {
  get(): Promise<DailyState>;
  put(state: DailyState): Promise<void>;
}

export interface DailyDeps {
  config: DailyConfig;
  linear: DailyLinear;
  /** Leon's Slack web session: it joins him, renames, stars and files the channels. */
  session: SlackCall;
  store: DailyStore;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

/** How long to wait before asking Linear again for a channel that never appeared. */
export const CHANNEL_RETRY_MS = 30 * 60_000;
/** How soon to look again while today's channel isn't there yet. */
export const WAITING_RETRY_MS = 60_000;
/** How long a day's project dailylinear marked done is remembered, so a reopened one stays open. */
export const COMPLETED_KEEP_DAYS = 60;

/** The name of a day's project: `20261122`, the name the day projects have had since 2026-11-19. */
export const dayProjectName = (day: string) => day.replaceAll("-", "");

/**
 * The ID dailylinear gives a day's project: derived from the team and day, so a retry after a lost
 * answer can't make a second one (Linear refuses a second project with the same ID).
 */
export const dayProjectId = (teamKey: string, day: string) =>
  stableUuid(`dailylinear:${teamKey}:${day}`);

interface ChannelInfo {
  id: string;
  name: string;
}

/**
 * Makes each day's Linear project at midnight and gets it its Slack channel: has Linear's Slack app
 * create `project-YYYY-MM-DD` at once, puts Leon and Hermes in it and stars it in Leon's sidebar.
 * Then marks the days before done in Linear and archives their channels. Every run does whatever is
 * still missing, so running it again is always safe.
 */
export class Daily {
  readonly #c: DailyConfig;
  readonly #linear: DailyLinear;
  readonly #session: SlackCall;
  readonly #sidebar: Sidebar;
  readonly #store: DailyStore;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #log: (event: string, fields?: Record<string, unknown>) => void;
  #channels: ChannelInfo[] | null = null;
  #settings: ProjectChannelSettings | null | undefined;
  #teamId: string | null = null;
  #statuses: LinearState[] | null = null;

  constructor(deps: DailyDeps) {
    this.#c = deps.config;
    this.#linear = deps.linear;
    this.#session = deps.session;
    this.#sidebar = new Sidebar(deps.session);
    this.#store = deps.store;
    this.#now = deps.now ?? Date.now;
    this.#sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#log = deps.log ?? (() => {});
  }

  async run(): Promise<DailyResult> {
    const { teamKey, timeZone, closedProjectTypes } = this.#c;
    const today = localDay(this.#now(), timeZone);
    const state = await this.#store.get();
    this.#channels = null;
    this.#settings = undefined;

    const { project: todays, created } = await this.#today(today);
    const open = (await this.#linear.openProjects(teamKey, closedProjectTypes)).filter(
      (p) => projectDay(p.name) !== null,
    );
    // Linear's lists can lag a project made a moment ago.
    if (todays && !open.some((p) => p.id === todays.id)) open.push(todays);
    const completed = (state.completed ??= {});
    const past = open.filter((p) => projectDay(p.name)! < today);
    const live = open.filter((p) => projectDay(p.name)! >= today);

    // Today's channel first, so it takes Starred before the day before is archived.
    let off = false;
    for (const project of live)
      if ((await this.#settleChannel(project, state)) === "off") off = true;
    await this.#settlePlaces(live, state, today);
    const done: string[] = [];
    for (const project of past) {
      if (completed[project.id]) continue;
      await this.#finish(project, state);
      done.push(projectDay(project.name)!);
    }
    await this.#forgetClosed(open, state);
    const oldest = addDays(today, -COMPLETED_KEEP_DAYS);
    for (const [id, day] of Object.entries(completed)) if (day < oldest) delete completed[id];

    const now = this.#now();
    const midnight = metaInstant(addDays(today, 1), timeZone)!.getTime();
    const status: DayStatus = !todays
      ? "closed"
      : state.days[todays.id]?.channelId
        ? "ready"
        : off
          ? "off"
          : "waiting";
    const result: DailyResult = {
      day: today,
      status,
      project: todays ? { id: todays.id, name: todays.name, url: todays.url } : null,
      created,
      done,
      at: now,
      next:
        status === "waiting"
          ? Math.min(now + WAITING_RETRY_MS, midnight)
          : status === "off"
            ? Math.min(now + CHANNEL_RETRY_MS, midnight)
            : midnight,
    };
    state.last = result;
    await this.#store.put(state);
    return result;
  }

  #open(project: LinearProject): boolean {
    return !project.gone && !this.#c.closedProjectTypes.includes(project.status.type);
  }

  /**
   * Today's open project, made when there is none. A day whose project Leon closed or deleted gets
   * no new one (null). When there are several, the one with a channel wins, then the oldest.
   */
  async #today(today: string): Promise<{ project: LinearProject | null; created: boolean }> {
    const { teamKey } = this.#c;
    const matches = (
      await this.#linear.projectsNamed(teamKey, [dayProjectName(today), today])
    ).filter((p) => projectDay(p.name) === today);
    const live = matches
      .filter((p) => this.#open(p))
      .sort(
        (a, b) =>
          Number(Boolean(b.slackChannelId)) - Number(Boolean(a.slackChannelId)) ||
          a.createdAt - b.createdAt,
      );
    if (live.length > 1)
      this.#log("duplicate_day_projects", { day: today, projects: live.map((p) => p.url) });
    if (live[0]) return { project: live[0], created: false };
    if (matches.length) {
      this.#log("day_project_closed", { day: today });
      return { project: null, created: false };
    }

    const id = await dayProjectId(teamKey, today);
    try {
      const project = await this.#linear.createProject({
        id,
        name: dayProjectName(today),
        teamIds: [await this.#team()],
        statusId: await this.#status(this.#c.projectStatus, "backlog"),
        startDate: today,
        targetDate: today,
      });
      this.#log("created_day_project", { day: today, project: project.url });
      return { project, created: true };
    } catch (error) {
      // A retry after a lost answer finds the project made the first time; a deleted one stays deleted.
      const made = await this.#linear.project(id).catch(() => null);
      if (!made) throw error;
      return this.#open(made)
        ? { project: made, created: false }
        : { project: null, created: false };
    }
  }

  async #team(): Promise<string> {
    if (this.#teamId) return this.#teamId;
    const team = await this.#linear.team(this.#c.teamKey);
    if (!team) throw new Error(`no Linear team ${this.#c.teamKey}`);
    return (this.#teamId = team.id);
  }

  /** The ID of the project status with this name, else the first of this type. */
  async #status(name: string, type: string): Promise<string> {
    this.#statuses ??= await this.#linear.projectStatuses();
    const status =
      this.#statuses.find((s) => s.name === name) ?? this.#statuses.find((s) => s.type === type);
    if (!status) throw new Error(`no project status ${name}`);
    return status.id;
  }

  /**
   * Marks a past day's project done (`doneStatus`, Linear's Completed) and archives its channel,
   * unstarred and out of the sidebar's sections first. The channel goes first, so a run that fails
   * partway does it all again: every step tolerates being repeated. Linear Sync, seeing the project
   * close, archives the channel too, which finds it archived already.
   */
  async #finish(project: LinearProject, state: DailyState): Promise<void> {
    const rec = state.days[project.id];
    const channel = project.slackChannelId ?? rec?.channelId ?? null;
    if (channel) {
      if (rec?.place === "starred")
        await tolerate(this.#session("stars.remove", { channel }), ["not_starred"]);
      await this.#sidebar.release(channel, this.#order());
      await tolerate(this.#session("conversations.archive", { channel }), [
        "already_archived",
        "is_archived",
        "channel_not_found",
      ]);
    }
    await this.#linear.updateProject(project.id, {
      statusId: await this.#status(this.#c.doneStatus, "completed"),
    });
    state.completed![project.id] = projectDay(project.name)!;
    delete state.days[project.id];
    await this.#store.put(state);
    this.#log("finished_day", { project: project.name, channel });
  }

  async #channelSettings(): Promise<ProjectChannelSettings | null> {
    if (this.#settings === undefined) this.#settings = await this.#linear.projectChannelSettings();
    return this.#settings;
  }

  /**
   * Gets an open day's project its channel and settles it once: named `project-YYYY-MM-DD`, with
   * Leon and Hermes in it. "off" when Linear's project channels are off.
   */
  async #settleChannel(project: LinearProject, state: DailyState): Promise<"off" | void> {
    const day = projectDay(project.name)!;
    const rec = (state.days[project.id] ??= {
      projectId: project.id,
      name: project.name,
      day,
      channelId: null,
      requestedAt: null,
      place: null,
    });
    rec.name = project.name;
    rec.day = day;
    let channelId = project.slackChannelId;
    if (!channelId) {
      const asked = await this.#requestChannel(project, rec, state);
      if (asked.off) return "off";
      channelId = asked.channelId;
    }
    if (!channelId || rec.channelId === channelId) return;
    await this.#nameDay(channelId, project.name);
    await tolerate(this.#session("conversations.join", { channel: channelId }), [
      "already_in_channel",
    ]);
    await tolerate(
      this.#session("conversations.invite", { channel: channelId, users: this.#c.hermesUserId }),
      ["already_in_channel", "cant_invite_self"],
    );
    rec.channelId = channelId;
    rec.place = null;
    this.#log("day_channel", { project: project.name, channel: channelId });
  }

  /**
   * Asks Linear's Slack app for the channel, named after the day from the start, then waits a few
   * seconds for it. A project Leon made in Linear's own app first gets five minutes to receive the
   * channel Linear makes for new projects; dailylinear's own get no such wait. Asked again after 30
   * minutes at the soonest.
   */
  async #requestChannel(
    project: LinearProject,
    rec: DayRecord,
    state: DailyState,
  ): Promise<{ channelId: string | null; off?: true }> {
    const now = this.#now();
    const ours = project.id === (await dayProjectId(this.#c.teamKey, rec.day));
    if (!ours && now < project.createdAt + PROJECT_GRACE_MS) return { channelId: null };
    if (rec.requestedAt !== null && now - rec.requestedAt < CHANNEL_RETRY_MS)
      return { channelId: null };
    const settings = await this.#channelSettings();
    if (!settings) {
      this.#log("project_channels_off", { project: project.name });
      return { channelId: null, off: true };
    }
    const name = await this.#freeName(
      projectChannelName(settings.prefix, project.name, this.#c.channelNameMax),
    );
    await this.#linear.createProjectChannel({
      projectId: project.id,
      name,
      integrationId: settings.integrationId,
    });
    rec.requestedAt = now;
    // Saved at once: a run that fails after this mustn't ask a second time.
    await this.#store.put(state);
    this.#log("requested_day_channel", { project: project.name, channel: name });
    for (let attempt = 0; attempt < 5; attempt++) {
      await this.#sleep(2_000);
      const fresh = await this.#linear.project(project.id);
      if (fresh?.slackChannelId) {
        this.#channels = null;
        return { channelId: fresh.slackChannelId };
      }
    }
    return { channelId: null };
  }

  /**
   * Keeps today's channel starred and out of custom sections, and the channel of a day made ahead
   * of time under Projects until its day. Only a channel dailylinear starred is unstarred, and only
   * when its place changes: if Leon unstars the day's channel, it stays unstarred.
   */
  async #settlePlaces(open: LinearProject[], state: DailyState, today: string): Promise<void> {
    const days = open.flatMap((project) => {
      const rec = state.days[project.id];
      return rec?.channelId ? [{ project, rec }] : [];
    });
    const current =
      days
        .filter((d) => d.rec.day <= today)
        .sort(
          (a, b) => b.rec.day.localeCompare(a.rec.day) || b.project.createdAt - a.project.createdAt,
        )[0]?.project.id ?? null;
    // The new day's channel first, then the old one leaves Starred.
    days.sort((a, b) => Number(b.project.id === current) - Number(a.project.id === current));
    for (const { project, rec } of days) {
      const channel = rec.channelId!;
      const want: Place = project.id === current ? "starred" : "projects";
      if (rec.place === want) continue;
      if (want === "starred") {
        await tolerate(this.#session("stars.add", { channel }), ["already_starred"]);
        await this.#sidebar.release(channel, this.#order());
      } else {
        if (rec.place === "starred")
          await tolerate(this.#session("stars.remove", { channel }), ["not_starred"]);
        const order = this.#order();
        const sections = await this.#sidebar.ensure(order, [this.#c.projectSection]);
        await this.#sidebar.move(channel, this.#c.projectSection, sections, order);
      }
      rec.place = want;
      this.#log(want === "starred" ? "starred_day" : "filed_day", {
        project: project.name,
        channel,
      });
    }
  }

  /**
   * Forgets the days whose project closed or was deleted, unstarring the channel first when
   * dailylinear starred it. Linear Sync archives the channel itself.
   */
  async #forgetClosed(open: LinearProject[], state: DailyState): Promise<void> {
    const ids = new Set(open.map((p) => p.id));
    for (const rec of Object.values(state.days)) {
      if (ids.has(rec.projectId)) continue;
      const project = await this.#linear.project(rec.projectId);
      // Missing from the list but still open: the next run sees it again.
      if (project && this.#open(project)) continue;
      if (rec.place === "starred" && rec.channelId)
        try {
          await tolerate(this.#session("stars.remove", { channel: rec.channelId }), [
            "not_starred",
          ]);
        } catch (error) {
          if (!(error instanceof SlackError)) throw error;
          this.#log("unstar_failed", { channel: rec.channelId, error: error.code });
        }
      delete state.days[rec.projectId];
      this.#log("forgot_day", { project: rec.name });
    }
  }

  /**
   * Renames a day's channel to `project-YYYY-MM-DD`. Linear's app names a channel it makes for a new
   * project after the project's name (`project-20261122`); Linear keeps the connection by ID, so a
   * rename doesn't break it. A name another channel holds is left alone, and so is a rename Slack
   * refuses.
   */
  async #nameDay(channelId: string, projectName: string): Promise<void> {
    const settings = await this.#channelSettings();
    if (!settings) return;
    const want = projectChannelName(settings.prefix, projectName, this.#c.channelNameMax);
    const channels = await this.#listChannels();
    const self = channels.find((c) => c.id === channelId);
    if (!self || self.name === want) return;
    if (channels.some((c) => c.id !== channelId && c.name === want)) {
      this.#log("day_name_taken", { channel: channelId, name: want });
      return;
    }
    try {
      await this.#session("conversations.rename", { channel: channelId, name: want });
    } catch (error) {
      if (!(error instanceof SlackError)) throw error;
      this.#log("day_rename_failed", { channel: channelId, name: want, error: error.code });
      return;
    }
    this.#log("renamed_day", { from: self.name, to: want });
    self.name = want;
  }

  /** `base`, or `base-2`, `base-3`… when a channel already has the name. */
  async #freeName(base: string): Promise<string> {
    const taken = new Set((await this.#listChannels()).map((c) => c.name));
    if (!taken.has(base)) return base;
    for (let n = 2; n < 10; n++) {
      const name = `${base.slice(0, this.#c.channelNameMax - 3)}-${n}`;
      if (!taken.has(name)) return name;
    }
    throw new Error(`no free channel name for ${base}`);
  }

  /** Every channel Leon can see, archived ones included, once per run. */
  async #listChannels(): Promise<ChannelInfo[]> {
    if (this.#channels) return this.#channels;
    const out: ChannelInfo[] = [];
    let cursor = "";
    do {
      const page = await this.#session("conversations.list", {
        types: "public_channel,private_channel",
        exclude_archived: false,
        limit: 1000,
        cursor: cursor || undefined,
      });
      for (const c of page.channels as { id: string; name: string }[])
        out.push({ id: c.id, name: c.name });
      cursor = (page.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "";
    } while (cursor);
    return (this.#channels = out);
  }

  /** Linear Sync's managed sections, top to bottom: the statuses, then projects. */
  #order(): string[] {
    const { sectionOrder, projectSection } = this.#c;
    return sectionOrder.includes(projectSection) ? sectionOrder : [...sectionOrder, projectSection];
  }
}
