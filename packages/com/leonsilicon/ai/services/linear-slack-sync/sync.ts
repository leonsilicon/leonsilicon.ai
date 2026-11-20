import { CLIENT_MSG_ID_PREFIX } from "@-/com.leonsilicon.ai.services.slack-as-leon";
import type { SyncConfig } from "#config";
import {
  addDays,
  channelName,
  channelNumber,
  channelTopic,
  escapeSlack,
  formatTitle,
  hasTime,
  linearToSlack,
  localDay,
  localLabel,
  mentions,
  metaInstant,
  parseTitle,
  projectChannelName,
  projectDay,
  slackToLinear,
  withDay,
} from "#format";
import type { LinearApi, LinearIssue, LinearProject, ProjectChannelSettings } from "#linear";
import { Sidebar, SlackError, tolerate } from "#slack";
import type { SlackCall } from "#slack";
import type { IssueRecord, ProjectRecord, Store } from "#store";

export interface LinearWebhook {
  action: string;
  type: string;
  data: { id: string };
  /** On an update, the changed fields' previous values. */
  updatedFrom?: Record<string, unknown>;
}

export interface SlackFile {
  name?: string;
  title?: string;
  permalink?: string;
}

export interface SlackMessageEvent {
  type: string;
  channel: string;
  ts: string;
  user?: string;
  text?: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
  client_msg_id?: string;
  files?: SlackFile[];
  /** The edited message, on `message_changed`. */
  message?: { ts: string; user?: string; text?: string; bot_id?: string; files?: SlackFile[] };
}

export interface SlackReactionEvent {
  type: "reaction_added";
  /** Who reacted. */
  user: string;
  /** The emoji's name, without colons. */
  reaction: string;
  /** Who wrote the message reacted to. */
  item_user?: string;
  item: { type: string; channel?: string; ts?: string };
}

/** Extras for a live status post. */
interface StatusPost {
  /** Said after the move, e.g. why it happened. */
  note?: string;
  /** Leaves Hermes unpinged, when it already has the issue. */
  quietHermes?: boolean;
  /** Leaves Leon unmentioned, when he was just pinged. */
  quietLeon?: boolean;
}

export interface SyncDeps {
  config: SyncConfig;
  store: Store;
  linear: LinearApi;
  /** The sync's own Slack app. */
  bot: SlackCall;
  /** Leon's web session. Without it, sidebar sections and unarchiving are skipped. */
  session: SlackCall | null;
  now?: () => number;
  /** Waits, while Linear creates a project channel. Tests pass one that returns at once. */
  sleep?: (ms: number) => Promise<void>;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

interface ChannelInfo {
  id: string;
  name: string;
  archived: boolean;
}

/** A UUID derived from a string, so retries of the same Slack message reuse one Linear comment ID. */
export async function stableUuid(seed: string): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)),
  );
  hash[6] = (hash[6]! & 0x0f) | 0x40;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = Array.from(hash.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const ARCHIVED = ["is_archived", "already_archived"];

/**
 * How long a new project is left alone before the sync asks for its channel. Linear's own "Create
 * channel for new projects" makes one within seconds of a project created in its app; projects
 * made through the API get none, so the sync makes those.
 */
export const PROJECT_GRACE_MS = 5 * 60_000;
/** How long to wait before asking Linear again for a channel that never appeared. */
const PROJECT_RETRY_MS = 30 * 60_000;

/**
 * The `section` a project record holds while its channel is in Leon's Starred section: the channel
 * of the latest day's project (see `projectDay`). Slack's Starred isn't a custom section, so this
 * stands in for its name.
 */
export const STARRED = "Starred";

/** The timer of an issue: when its next start, stop or due time comes. */
const issueTimer = (issueId: string) => `timer:${issueId}`;
/** The timer that looks at the day projects again at the next midnight. */
const DAYS_TIMER = "days";
/** Recorded once an issue's due time has been announced, so it is announced once. */
const dueKey = (issueId: string, at: number) => `due:${issueId}:${at}`;
/**
 * Recorded once a ping to Leon has been acted on, so edits of the message or comment that carried
 * it don't act again: `ping:<channel>:<ts>` for Hermes's Slack posts, `ping:comment:<id>` for Linear.
 */
const pingKey = (...parts: string[]) => `ping:${parts.join(":")}`;
/** A notice for a due time (not a bare day) this late says "Overdue". */
const LATE_MS = 3600_000;

interface Due {
  /** When (ms). */
  at: number;
  /** Whether a time of day was given; Linear's own due date has none. */
  timed: boolean;
}

/**
 * Keeps one Slack channel per Linear issue: creates or adopts it, files it in the sidebar section
 * named after the issue's status, mirrors comments both ways, and archives it when the issue
 * closes. Every method runs inside one serial queue, so nothing here races itself.
 */
export class Sync {
  readonly #c: SyncConfig;
  readonly #store: Store;
  readonly #linear: LinearApi;
  readonly #bot: SlackCall;
  readonly #session: SlackCall | null;
  readonly #sidebar: Sidebar | null;
  readonly #now: () => number;
  readonly #log: (event: string, fields?: Record<string, unknown>) => void;
  readonly #sleep: (ms: number) => Promise<void>;
  #botUserId: string | null = null;
  #channels: ChannelInfo[] | null = null;
  #projectChannels: ProjectChannelSettings | null | undefined;
  /** Linear status IDs by name, read once per drain. */
  #states: Map<string, string> | null = null;
  #feedId: string | null = null;

  constructor(deps: SyncDeps) {
    this.#c = deps.config;
    this.#store = deps.store;
    this.#linear = deps.linear;
    this.#bot = deps.bot;
    this.#session = deps.session;
    this.#sidebar = deps.session ? new Sidebar(deps.session) : null;
    this.#now = deps.now ?? Date.now;
    this.#sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#log = deps.log ?? (() => {});
  }

  async run(kind: string, payload: unknown): Promise<void> {
    if (kind === "linear") {
      const hook = payload as LinearWebhook;
      if (hook.type === "Issue") await this.onLinearIssue(hook);
      else if (hook.type === "Comment") await this.onLinearComment(hook);
      else if (hook.type === "Project") await this.onLinearProject(hook);
    } else if (kind === "project") {
      // A delayed look at a new project, once Linear has had time to make its channel.
      const project = await this.#linear.project((payload as { id: string }).id);
      if (project && project.teamKeys.includes(this.#c.teamKey)) await this.syncProject(project);
    } else if (kind === "slack") {
      const event = payload as SlackMessageEvent | SlackReactionEvent;
      if (event.type === "reaction_added") await this.onSlackReaction(event as SlackReactionEvent);
      else await this.onSlackMessage(event as SlackMessageEvent);
    } else if (kind === "timer") await this.onTimer((payload as { id: string }).id);
    else if (kind === "days")
      await this.#settleDays(
        await this.#linear.openProjects(this.#c.teamKey, this.#c.closedProjectTypes),
      );
    else if (kind === "tick") await this.tick();
    else if (kind === "backfill") await this.backfill();
    else this.#log("unknown_job", { kind });
  }

  // ── Linear → Slack ─────────────────────────────────────────────────────────

  async onLinearIssue(hook: LinearWebhook): Promise<void> {
    if (hook.action === "remove") {
      this.#store.setTimer(issueTimer(hook.data.id), "timer", null, null, this.#now());
      const rec = this.#store.issue(hook.data.id);
      if (rec && !rec.archived) {
        await this.#unplace(rec.channelId);
        await this.#archive(rec.channelId);
        this.#store.putIssue({ ...rec, archived: true, section: null });
      }
      return;
    }
    const issue = await this.#linear.issue(hook.data.id);
    if (issue && issue.teamKey === this.#c.teamKey)
      await this.syncIssue(await this.#syncDue(issue, hook.updatedFrom), "live");
  }

  async onLinearComment(hook: LinearWebhook): Promise<void> {
    const id = hook.data.id;
    const known = this.#store.comment(id);
    if (known?.origin === "slack") return; // our own mirror of a Slack message
    if (hook.action === "remove") {
      if (known) {
        await tolerate(this.#bot("chat.delete", { channel: known.channelId, ts: known.slackTs }), [
          "message_not_found",
          "channel_not_found",
          ...ARCHIVED,
        ]);
        this.#store.deleteComment(id);
      }
      return;
    }
    if (hook.action === "update" && !known) return;
    const comment = await this.#linear.comment(id);
    if (!comment) return;
    if (known) {
      const text = this.#text(comment.body);
      await tolerate(
        this.#bot("chat.update", { channel: known.channelId, ts: known.slackTs, text }),
        ["message_not_found", "cant_update_message", "channel_not_found", ...ARCHIVED],
      );
      const key = pingKey("comment", id);
      if (!mentions(text, this.#c.leonUserId) || this.#store.fired(key)) return;
      const issue = await this.#openIssueIn(known.channelId);
      if (issue) await this.#handToLeon(issue, key, comment.authorName);
      return;
    }
    const issue = await this.#linear.issue(comment.issueId);
    if (!issue || issue.teamKey !== this.#c.teamKey) return;
    const rec = await this.syncIssue(issue, "live");
    if (!rec || rec.archived) return;
    const parent = comment.parentId ? this.#store.comment(comment.parentId) : null;
    const threadTs = parent ? (parent.threadTs ?? parent.slackTs) : undefined;
    const text = this.#text(comment.body);
    const posted = await this.#bot("chat.postMessage", {
      channel: rec.channelId,
      text,
      username: comment.authorName,
      icon_url: comment.authorAvatar ?? undefined,
      thread_ts: threadTs,
      unfurl_links: false,
      unfurl_media: false,
    });
    this.#store.putComment({
      commentId: id,
      issueId: issue.id,
      channelId: rec.channelId,
      slackTs: posted.ts as string,
      threadTs: threadTs ?? null,
      rootCommentId: parent ? parent.rootCommentId : id,
      origin: "linear",
    });
    // A comment that pings Leon (an agent asking him something) hands him the issue.
    if (mentions(text, this.#c.leonUserId))
      await this.#handToLeon(issue, pingKey("comment", id), comment.authorName);
  }

  /**
   * Brings an issue's channel and timer in line with the issue. `live` posts what changed (the
   * intro for a new channel, status moves, mentions); `quiet` only fixes state, for backfills.
   * `post` shapes the status post, when there is one.
   */
  async syncIssue(
    issue: LinearIssue,
    mode: "live" | "quiet",
    post: StatusPost = {},
  ): Promise<IssueRecord | null> {
    this.#planTimer(issue);
    const prev = this.#store.issue(issue.id);
    const { name, meta } = parseTitle(issue.title);
    if (this.#c.closedStateTypes.includes(issue.state.type)) {
      if (!prev) return null;
      if (!prev.archived) {
        if (mode === "live" && prev.stateName !== issue.state.name)
          await this.#postStatus(prev.channelId, prev.stateName, issue);
        await this.#unplace(prev.channelId);
        await this.#archive(prev.channelId);
      }
      const closed = {
        ...prev,
        title: issue.title,
        stateName: issue.state.name,
        archived: true,
        section: null,
      };
      this.#store.putIssue(closed);
      return closed;
    }

    let rec: IssueRecord;
    let created = false;
    if (prev && !prev.archived) rec = { ...prev };
    else {
      const opened = await this.#openChannel(issue, prev);
      created = opened.created;
      rec = {
        issueId: issue.id,
        identifier: issue.identifier,
        title: prev?.title ?? issue.title,
        stateName: prev?.stateName ?? issue.state.name,
        channelId: opened.id,
        channelName: opened.name,
        section: null,
        topic: opened.created ? null : (prev?.topic ?? null),
        archived: false,
      };
      this.#store.putIssue(rec);
      if (created && mode === "live") await this.#postIntro(rec.channelId, issue);
    }

    if (prev && !prev.archived && parseTitle(prev.title).name !== name) {
      const wanted = channelName(this.#c.channelPrefix, issue.number, name, this.#c.channelNameMax);
      if (wanted !== rec.channelName && (await this.#rename(rec.channelId, wanted)))
        rec.channelName = wanted;
    }

    const topic = channelTopic(issue.state.name, meta, issue.url);
    if (rec.topic !== topic) {
      await this.#bot("conversations.setTopic", { channel: rec.channelId, topic });
      rec.topic = topic;
    }

    if (mode === "live" && prev && prev.stateName !== issue.state.name)
      await this.#postStatus(rec.channelId, prev.stateName, issue, post);

    if (rec.section !== issue.state.name && (await this.#place(rec.channelId, issue.state.name)))
      rec.section = issue.state.name;

    rec.stateName = issue.state.name;
    rec.title = issue.title;
    rec.identifier = issue.identifier;
    this.#store.putIssue(rec);
    return rec;
  }

  // ── Linear projects ────────────────────────────────────────────────────────

  async onLinearProject(hook: LinearWebhook): Promise<void> {
    if (hook.action === "remove") {
      const rec = this.#store.project(hook.data.id);
      if (rec) await this.#closeProject(rec);
      return;
    }
    const project = await this.#linear.project(hook.data.id);
    if (project && project.teamKeys.includes(this.#c.teamKey)) await this.syncProject(project);
  }

  /**
   * Gives an open project a channel through Linear's own Slack integration, so Linear posts its
   * updates there and syncs their threads, then files it in the projects section with Leon and
   * Hermes in it. A closed project's channel is archived; reopening unarchives it. Linear names,
   * renames, topics and populates the channel itself.
   */
  async syncProject(project: LinearProject): Promise<ProjectRecord | null> {
    const prev = this.#store.project(project.id);
    if (project.gone || this.#c.closedProjectTypes.includes(project.status.type)) {
      const channelId = project.slackChannelId ?? prev?.channelId ?? null;
      if (!channelId && !prev) return null;
      const rec: ProjectRecord = {
        projectId: project.id,
        name: project.name,
        statusName: project.status.name,
        channelId,
        section: prev?.section ?? null,
        archived: prev?.archived === true && prev.channelId === channelId,
        requestedAt: prev?.requestedAt ?? null,
      };
      await this.#closeProject(rec);
      return this.#store.project(project.id);
    }

    const channelId = project.slackChannelId ?? (await this.#requestProjectChannel(project, prev));
    if (!channelId) return prev;
    const same = prev?.channelId === channelId;
    const rec: ProjectRecord = {
      projectId: project.id,
      name: project.name,
      statusName: project.status.name,
      channelId,
      section: same ? prev.section : null,
      archived: false,
      requestedAt: prev?.requestedAt ?? null,
    };
    if (same && prev.archived) {
      if (!this.#session)
        throw new Error(
          `project channel ${channelId} is archived and there is no session to unarchive it`,
        );
      await tolerate(this.#session("conversations.unarchive", { channel: channelId }), [
        "not_archived",
      ]);
    }
    if (!same || prev.archived) await this.#joinProject(channelId);
    const day = projectDay(project.name) !== null;
    const section = this.#c.projectSection;
    // A day's project is filed by #settleDays, which stars the latest day's channel.
    if (!day && rec.section !== section && (await this.#place(channelId, section)))
      rec.section = section;
    this.#store.putProject(rec);
    if (!same) this.#log("project_channel", { project: project.name, channel: channelId });
    if (!day) return rec;
    await this.#settleDays(
      await this.#linear.openProjects(this.#c.teamKey, this.#c.closedProjectTypes),
    );
    return this.#store.project(project.id);
  }

  /**
   * Keeps the channels of day projects (a project named after a date, like Hermes's daily `20261119`)
   * named `project-YYYY-MM-DD`, and keeps the latest one whose day has come (in `timeZone`) in Leon's
   * Starred section, out of every custom section. The day's channel is starred once it exists, and
   * the one before it goes back under Projects then, so Starred is never left without a day.
   * Channels Leon stars himself are never touched: only a channel this starred is unstarred.
   */
  async #settleDays(projects: LinearProject[]): Promise<void> {
    const today = localDay(this.#now(), this.#c.timeZone);
    const days = projects.flatMap((project) => {
      const day = projectDay(project.name);
      return day && project.slackChannelId ? [{ project, day }] : [];
    });
    const current =
      days
        .filter((d) => d.day <= today)
        .sort((a, b) => b.day.localeCompare(a.day) || b.project.createdAt - a.project.createdAt)[0]
        ?.project.id ?? null;
    for (const { project } of days) {
      const rec = this.#store.project(project.id);
      // Not settled by syncProject yet; it comes back here once it is.
      if (!rec?.channelId || rec.archived || rec.channelId !== project.slackChannelId) continue;
      await this.#nameDay(rec.channelId, project.name);
      const want = project.id === current ? STARRED : this.#c.projectSection;
      if (rec.section === want) continue;
      const done =
        want === STARRED
          ? await this.#star(rec.channelId)
          : (rec.section !== STARRED || (await this.#unstar(rec.channelId))) &&
            (await this.#place(rec.channelId, want));
      if (!done) continue;
      this.#store.putProject({ ...rec, section: want });
      this.#log(want === STARRED ? "starred_day" : "unstarred_day", {
        project: project.name,
        channel: rec.channelId,
      });
    }
    // The latest day can change at midnight, when a day project made ahead of time comes due.
    const midnight = metaInstant(addDays(today, 1), this.#c.timeZone)!.getTime();
    this.#store.setTimer(DAYS_TIMER, "days", {}, midnight, this.#now());
  }

  /**
   * Renames a day project's channel to `project-YYYY-MM-DD`. Linear's app names it after the
   * project (`project-20261119`); Linear keeps the connection by ID, so a rename doesn't break it.
   * A name some other channel holds is left alone, and so is a rename Slack refuses.
   */
  async #nameDay(channelId: string, projectName: string): Promise<void> {
    if (!this.#session) return;
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

  /** Stars a channel in Leon's sidebar and takes it out of custom sections. False without a session. */
  async #star(channelId: string): Promise<boolean> {
    if (!this.#session) return false;
    await tolerate(this.#session("stars.add", { channel: channelId }), ["already_starred"]);
    await this.#unplace(channelId);
    return true;
  }

  async #unstar(channelId: string): Promise<boolean> {
    if (!this.#session) return false;
    await tolerate(this.#session("stars.remove", { channel: channelId }), ["not_starred"]);
    return true;
  }

  async #channelSettings(): Promise<ProjectChannelSettings | null> {
    if (this.#projectChannels === undefined)
      this.#projectChannels = await this.#linear.projectChannelSettings();
    return this.#projectChannels;
  }

  /** Takes a closed or deleted project's channel out of the sidebar and archives it. */
  async #closeProject(rec: ProjectRecord): Promise<void> {
    if (rec.channelId && !rec.archived) {
      if (rec.section === STARRED) await this.#unstar(rec.channelId);
      await this.#unplace(rec.channelId);
      await this.#archive(rec.channelId);
      this.#log("archived_project_channel", { project: rec.name, channel: rec.channelId });
    }
    this.#store.putProject({ ...rec, archived: true, section: null });
  }

  /**
   * Asks Linear to create and connect the project's channel, then waits a few seconds for it.
   * Returns the channel, or null when it isn't there yet (a later webhook or tick picks it up).
   */
  async #requestProjectChannel(
    project: LinearProject,
    prev: ProjectRecord | null,
  ): Promise<string | null> {
    const now = this.#now();
    const ready = project.createdAt + PROJECT_GRACE_MS;
    if (now < ready) {
      this.#store.enqueue(`project:${project.id}:grace`, "project", { id: project.id }, now, ready);
      return null;
    }
    if (prev?.requestedAt && now - prev.requestedAt < PROJECT_RETRY_MS) return null;
    const settings = await this.#channelSettings();
    if (!settings) {
      this.#log("project_channels_off", { project: project.name });
      return null;
    }
    const name = await this.#freeName(
      projectChannelName(settings.prefix, project.name, this.#c.channelNameMax),
    );
    await this.#linear.createProjectChannel({
      projectId: project.id,
      name,
      integrationId: settings.integrationId,
    });
    this.#store.putProject({
      projectId: project.id,
      name: project.name,
      statusName: project.status.name,
      channelId: null,
      section: null,
      archived: false,
      requestedAt: now,
    });
    this.#log("requested_project_channel", { project: project.name, channel: name });
    for (let attempt = 0; attempt < 5; attempt++) {
      await this.#sleep(2_000);
      const fresh = await this.#linear.project(project.id);
      if (fresh?.slackChannelId) {
        this.#channels = null;
        return fresh.slackChannelId;
      }
    }
    return null;
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

  /**
   * Linear invites the project's members; this makes sure Leon and Hermes are in too. The channel
   * is public, so Leon joins it himself. The bot stays out: it needs nothing there.
   */
  async #joinProject(channelId: string): Promise<void> {
    if (this.#session) {
      await tolerate(this.#session("conversations.join", { channel: channelId }), [
        "already_in_channel",
      ]);
      await tolerate(
        this.#session("conversations.invite", { channel: channelId, users: this.#c.hermesUserId }),
        ["already_in_channel", "cant_invite_self"],
      );
      return;
    }
    await tolerate(this.#bot("conversations.join", { channel: channelId }), ["already_in_channel"]);
    for (const user of [this.#c.leonUserId, this.#c.hermesUserId])
      await tolerate(this.#bot("conversations.invite", { channel: channelId, users: user }), [
        "already_in_channel",
        "cant_invite_self",
        "user_not_found",
      ]);
  }

  // ── Slack → Linear ─────────────────────────────────────────────────────────

  async onSlackMessage(event: SlackMessageEvent): Promise<void> {
    if (event.type !== "message") return;
    if (event.subtype === "message_changed") {
      const edited = event.message;
      // Hermes streams some replies by editing them, so its ping can first show up in an edit.
      if (edited?.user === this.#c.hermesUserId)
        return this.#onHermesMessage(event.channel, edited.ts, edited.text ?? "");
      if (!edited || edited.bot_id || !edited.user) return;
      const known = this.#store.commentBySlack(event.channel, edited.ts);
      if (known?.origin === "slack")
        await this.#linear.updateComment(
          known.commentId,
          await this.#slackBody(edited.user, edited.text ?? "", edited.files),
        );
      return;
    }
    if (!event.user) return;
    if (event.subtype && event.subtype !== "file_share" && event.subtype !== "thread_broadcast")
      return;
    // Hermes's posts aren't mirrored, but one that pings Leon hands him the issue.
    if (event.user === this.#c.hermesUserId)
      return this.#onHermesMessage(event.channel, event.ts, event.text ?? "");
    if (event.bot_id) return;
    // Hermes posting as Leon through slack-as-leon, to wake other bots; not Leon's own words.
    if (event.client_msg_id?.startsWith(CLIENT_MSG_ID_PREFIX)) return;
    const rec = this.#store.issueByChannel(event.channel);
    if (!rec || rec.archived) return;
    if (this.#store.commentBySlack(event.channel, event.ts)) return;

    const reply = event.thread_ts && event.thread_ts !== event.ts ? event.thread_ts : null;
    const parent = reply ? this.#store.commentBySlack(event.channel, reply) : null;
    const id = await stableUuid(`slack:${event.channel}:${event.ts}`);
    const body = await this.#slackBody(event.user, event.text ?? "", event.files);
    this.#store.putComment({
      commentId: id,
      issueId: rec.issueId,
      channelId: event.channel,
      slackTs: event.ts,
      threadTs: reply,
      rootCommentId: parent?.rootCommentId ?? id,
      origin: "slack",
    });
    try {
      await this.#linear.createComment({
        id,
        issueId: rec.issueId,
        body,
        ...(parent ? { parentId: parent.rootCommentId } : {}),
      });
    } catch (error) {
      if (/already exists|duplicate|unique/i.test(String(error))) return; // an earlier try got through
      this.#store.deleteComment(id);
      throw error;
    }
  }

  /**
   * Hermes reacting 👀 to Leon's message in an issue channel means it has taken the message up, so
   * the issue moves to Awaiting Hermes from whatever status it was in. The channel follows at once,
   * without pinging Hermes, which is already on it; Linear's webhook then finds nothing to do.
   */
  async onSlackReaction(event: SlackReactionEvent): Promise<void> {
    const { hermesAckReaction, hermesAckState } = this.#c;
    if (event.reaction !== hermesAckReaction || event.user !== this.#c.hermesUserId) return;
    if (event.item_user !== this.#c.leonUserId || event.item.type !== "message") return;
    const issue = event.item.channel ? await this.#openIssueIn(event.item.channel) : null;
    if (!issue || issue.state.name === hermesAckState) return;
    const from = issue.state.name;
    await this.#moveNow(issue, hermesAckState, {
      note: `(Hermes reacted :${hermesAckReaction}: to Leon's message)`,
      quietHermes: true,
    });
    this.#log("hermes_ack", { issue: issue.identifier, from });
  }

  /**
   * Hermes mentioning Leon in an issue channel means it needs something from him (Leon's rule,
   * 2026-11-19: Hermes pings him whenever it does), so the issue moves to Awaiting Leon, unless it
   * already waits on him (a status that mentions him). The channel follows at once, without
   * mentioning Leon again; Hermes's message already did. Each message acts once: a later edit of
   * it (Hermes streams some replies that way) doesn't pull the issue back after Leon moves it on.
   */
  async #onHermesMessage(channelId: string, ts: string, text: string): Promise<void> {
    if (!mentions(text, this.#c.leonUserId)) return;
    const key = pingKey(channelId, ts);
    if (this.#store.fired(key)) return;
    const issue = await this.#openIssueIn(channelId);
    if (issue) await this.#handToLeon(issue, key, "Hermes");
  }

  /**
   * Leon was pinged about an open issue, by Hermes in its channel or by anyone in a Linear comment:
   * the issue moves to Awaiting Leon unless it already waits on him, and the post doesn't mention
   * him again. `key` names the message or comment, which acts once.
   */
  async #handToLeon(issue: LinearIssue, key: string, who: string): Promise<void> {
    if (this.#store.fired(key)) return;
    const { leonPingState, mentionLeonStates } = this.#c;
    const from = issue.state.name;
    if (from !== leonPingState && !mentionLeonStates.includes(from)) {
      await this.#moveNow(issue, leonPingState, { note: `(${who} pinged Leon)`, quietLeon: true });
      this.#log("leon_pinged", { issue: issue.identifier, from, by: who });
    }
    this.#store.markFired(key, this.#now());
  }

  /** The open issue whose channel this is, read fresh from Linear. Null for any other channel. */
  async #openIssueIn(channelId: string): Promise<LinearIssue | null> {
    const rec = this.#store.issueByChannel(channelId);
    if (!rec || rec.archived) return null;
    const issue = await this.#linear.issue(rec.issueId);
    if (!issue || this.#c.closedStateTypes.includes(issue.state.type)) return null;
    return issue;
  }

  /**
   * Moves an issue for something said in Slack and brings its channel along at once, posting the
   * move as `post` shapes it. Linear's webhook for the move then finds nothing left to do.
   */
  async #moveNow(issue: LinearIssue, to: string, post: StatusPost): Promise<void> {
    await this.#move(issue, to);
    const moved = await this.#linear.issue(issue.id);
    if (moved) await this.syncIssue(moved, "live", post);
  }

  // ── Times ──────────────────────────────────────────────────────────────────

  /**
   * An issue's timer went off. Acts on whichever of its times have come, then sets the timer for
   * the next one.
   */
  async onTimer(issueId: string): Promise<void> {
    const issue = await this.#linear.issue(issueId);
    if (!issue || issue.teamKey !== this.#c.teamKey) {
      this.#store.setTimer(issueTimer(issueId), "timer", null, null, this.#now());
      return;
    }
    await this.#runTimes(issue);
  }

  /**
   * Moves an Awaiting Date issue whose `start` has come to its target status, sends an Awaiting
   * Listener issue whose `stop` has passed back to Leon, and announces an issue whose due time has
   * come in the feed channel, once. Then sets the issue's timer for whatever is left.
   */
  async #runTimes(issue: LinearIssue): Promise<void> {
    if (this.#c.closedStateTypes.includes(issue.state.type)) return this.#planTimer(issue);
    const now = this.#now();
    const { meta } = parseTitle(issue.title);
    const come = (value: string | undefined) => {
      const at = value ? metaInstant(value, this.#c.timeZone) : null;
      return at !== null && at.getTime() <= now;
    };
    let moved = false;
    if (issue.state.name === this.#c.dateState && come(meta.start)) {
      await this.#move(issue, this.#c.dateTarget);
      this.#log("start_date_reached", { issue: issue.identifier });
      moved = true;
    } else if (issue.state.name === this.#c.listenerState && come(meta.stop)) {
      const { event, stop } = meta;
      await this.#move(issue, this.#c.listenerExpiredTarget);
      await this.#linear.createComment({
        id: await stableUuid(`listener-expired:${issue.id}:${stop}`),
        issueId: issue.id,
        body: `**Linear Sync:** the listener's stop date (${stop}) passed before it fired${event ? `; it was waiting for: ${event}` : ""}. Extend it or cancel the issue.`,
      });
      this.#log("listener_expired", { issue: issue.identifier });
      moved = true;
    }
    const due = this.#due(issue);
    if (due && due.at <= now && !this.#store.fired(dueKey(issue.id, due.at))) {
      await this.#announceDue(issue, due);
      this.#store.markFired(dueKey(issue.id, due.at), now);
    }
    // The move's own webhook syncs the channel; the timer is set from the issue as it now is.
    this.#planTimer(moved ? ((await this.#linear.issue(issue.id)) ?? issue) : issue);
  }

  /**
   * Sets the issue's timer for the earliest of its times still to act on: the `start` of an Awaiting
   * Date issue, the `stop` of an Awaiting Listener one, and a due time not yet announced. A time
   * already past goes off at once. A closed issue has no timer.
   */
  #planTimer(issue: LinearIssue): void {
    const times: number[] = [];
    if (!this.#c.closedStateTypes.includes(issue.state.type)) {
      const { meta } = parseTitle(issue.title);
      const add = (value: string | undefined) => {
        const at = value ? metaInstant(value, this.#c.timeZone) : null;
        if (at) times.push(at.getTime());
      };
      if (issue.state.name === this.#c.dateState) add(meta.start);
      if (issue.state.name === this.#c.listenerState) add(meta.stop);
      const due = this.#due(issue);
      if (due && !this.#store.fired(dueKey(issue.id, due.at))) times.push(due.at);
    }
    const at = times.length ? Math.min(...times) : null;
    this.#store.setTimer(issueTimer(issue.id), "timer", { id: issue.id }, at, this.#now());
  }

  /**
   * When an issue is due: the title's `due` (a bare date is midnight, like `start`), else Linear's
   * own due date, which has no time, at midnight starting that day. Both in `timeZone`.
   */
  #due(issue: LinearIssue): Due | null {
    for (const value of [parseTitle(issue.title).meta.due, issue.dueDate]) {
      const at = value ? metaInstant(value, this.#c.timeZone) : null;
      if (value && at) return { at: at.getTime(), timed: hasTime(value) };
    }
    return null;
  }

  /**
   * Keeps Linear's own due date on the day of the title's `due`, so Linear shows it and sorts by
   * it. When Linear's date is what changed (its date picker, or clearing it), the title follows
   * instead, keeping its time of day. Returns the issue as it now is.
   */
  async #syncDue(issue: LinearIssue, changed: Record<string, unknown> = {}): Promise<LinearIssue> {
    if (this.#c.closedStateTypes.includes(issue.state.type)) return issue;
    const { name, meta } = parseTitle(issue.title);
    const at = meta.due ? metaInstant(meta.due, this.#c.timeZone) : null;
    if (!meta.due || !at) return issue;
    const day = localDay(at.getTime(), this.#c.timeZone);
    if (issue.dueDate === day) return issue;
    if ("dueDate" in changed && !("title" in changed)) {
      const due = issue.dueDate ? withDay(meta.due, issue.dueDate, this.#c.timeZone) : null;
      if (due) meta.due = due;
      else delete meta.due;
      const title = formatTitle(name, meta);
      await this.#linear.updateIssue(issue.id, { title });
      this.#log("due_from_linear", { issue: issue.identifier, due });
      return { ...issue, title };
    }
    await this.#linear.updateIssue(issue.id, { dueDate: day });
    this.#log("due_to_linear", { issue: issue.identifier, day });
    return { ...issue, dueDate: day };
  }

  /** Posts in the feed channel that an issue has come due. */
  async #announceDue(issue: LinearIssue, due: Due): Promise<void> {
    const channel = await this.#feedChannel();
    const rec = this.#store.issue(issue.id);
    const now = this.#now();
    // A bare day is overdue once it's over; a time, once it's an hour gone.
    const late = due.timed
      ? now - due.at > LATE_MS
      : localDay(now, this.#c.timeZone) > localDay(due.at, this.#c.timeZone);
    const name = escapeSlack(parseTitle(issue.title).name);
    const text = [
      `:date: ${late ? "Overdue" : "Due"}: *<${issue.url}|${issue.identifier}: ${name}>*`,
      `due ${localLabel(due.at, this.#c.timeZone, due.timed)}`,
      issue.state.name,
      ...(rec && !rec.archived ? [`<#${rec.channelId}>`] : []),
    ].join(" · ");
    await this.#bot("chat.postMessage", {
      channel,
      text,
      unfurl_links: false,
      unfurl_media: false,
    });
    this.#log("due", { issue: issue.identifier, late });
  }

  /**
   * The feed channel (`#feed-linear`), where issues coming due are announced. An existing one is
   * unarchived and joined; a missing one is created public, with Leon and Hermes in it.
   */
  async #feedChannel(): Promise<string> {
    if (this.#feedId) return this.#feedId;
    const name = this.#c.feedChannel;
    const found = (await this.#listChannels())
      .filter((c) => c.name === name)
      .sort((a, b) => Number(a.archived) - Number(b.archived))[0];
    if (found) {
      if (found.archived) {
        await tolerate(
          (this.#session ?? this.#bot)("conversations.unarchive", { channel: found.id }),
          ["not_archived"],
        );
        found.archived = false;
      }
      try {
        await tolerate(this.#bot("conversations.join", { channel: found.id }), [
          "already_in_channel",
        ]);
      } catch (error) {
        // A private channel: Leon's session invites the bot instead.
        if (!(error instanceof SlackError)) throw error;
        await this.#join(found.id);
      }
      this.#feedId = found.id;
      return found.id;
    }
    const created = await this.#bot("conversations.create", { name });
    const id = (created.channel as { id: string }).id;
    try {
      await this.#bot("conversations.setPurpose", {
        channel: id,
        purpose: `Linear issues of team ${this.#c.teamKey} coming due, posted by Linear Sync.`,
      });
    } catch (error) {
      this.#log("feed_purpose_failed", { error: String(error) });
    }
    for (const user of [this.#c.leonUserId, this.#c.hermesUserId])
      await tolerate(this.#bot("conversations.invite", { channel: id, users: user }), [
        "already_in_channel",
        "cant_invite_self",
        "user_not_found",
      ]);
    this.#channels?.push({ id, name, archived: false });
    this.#log("created_feed_channel", { channel: name });
    this.#feedId = id;
    return id;
  }

  // ── Daily safety net ───────────────────────────────────────────────────────

  /**
   * Once a day, for anything a webhook or timer missed: syncs every open issue whose status or
   * title drifted, sets every open issue's due date and timer (a time already past goes off at
   * once), closes channels of issues that closed or vanished, settles projects, and makes sure the
   * feed channel exists. The times themselves go off on their timers.
   */
  async tick(): Promise<void> {
    try {
      await this.#feedChannel();
    } catch (error) {
      // A due notice retries on its own; the rest of the safety net still runs.
      this.#log("feed_channel_failed", { error: String(error) });
    }
    const issues = await this.#linear.openIssues(this.#c.teamKey, this.#c.closedStateTypes);
    const open = new Set(issues.map((i) => i.id));
    for (const listed of issues) {
      const issue = await this.#syncDue(listed);
      const rec = this.#store.issue(issue.id);
      if (!rec || rec.archived || rec.stateName !== issue.state.name || rec.title !== issue.title)
        await this.syncIssue(issue, "live");
      else this.#planTimer(issue);
    }
    for (const rec of this.#store.allIssues()) {
      if (rec.archived || open.has(rec.issueId)) continue;
      const issue = await this.#linear.issue(rec.issueId);
      if (!issue) {
        this.#store.setTimer(issueTimer(rec.issueId), "timer", null, null, this.#now());
        await this.#unplace(rec.channelId);
        await this.#archive(rec.channelId);
        this.#store.putIssue({ ...rec, archived: true, section: null });
      } else await this.syncIssue(issue, "live");
    }
    await this.#reconcileProjects();
  }

  /** Syncs every open project that isn't settled, and closes the ones that left the open list. */
  async #reconcileProjects(): Promise<void> {
    const projects = await this.#linear.openProjects(this.#c.teamKey, this.#c.closedProjectTypes);
    for (const project of projects) {
      const rec = this.#store.project(project.id);
      if (
        !rec ||
        rec.archived ||
        rec.channelId !== project.slackChannelId ||
        (projectDay(project.name) === null && rec.section !== this.#c.projectSection)
      )
        await this.syncProject(project);
    }
    const open = new Set(projects.map((p) => p.id));
    for (const rec of this.#store.allProjects()) {
      if (rec.archived || open.has(rec.projectId)) continue;
      const project = await this.#linear.project(rec.projectId);
      if (project) await this.syncProject(project);
      else await this.#closeProject(rec);
    }
    // Also sets the midnight timer, should it have been lost.
    await this.#settleDays(projects);
  }

  /**
   * Adopts or creates a channel for every open issue and archives channels of closed ones, quietly.
   * Then gives every open project its channel.
   */
  async backfill(): Promise<void> {
    this.#channels = null;
    const issues = await this.#linear.openIssues(this.#c.teamKey, this.#c.closedStateTypes);
    for (const issue of issues) await this.syncIssue(issue, "quiet");
    const openNumbers = new Set(issues.map((i) => i.number));
    for (const channel of await this.#listChannels()) {
      const number = channelNumber(this.#c.channelPrefix, channel.name);
      if (number === null || channel.archived || openNumbers.has(number)) continue;
      const issue = await this.#linear.issue(`${this.#c.teamKey}-${number}`);
      if (!issue || !this.#c.closedStateTypes.includes(issue.state.type)) continue;
      const rec = this.#store.issue(issue.id);
      if (rec && rec.channelId !== channel.id) continue;
      await this.#unplace(channel.id);
      await this.#archive(channel.id);
      if (rec)
        this.#store.putIssue({
          ...rec,
          stateName: issue.state.name,
          archived: true,
          section: null,
        });
      this.#log("archived_closed", { issue: issue.identifier, channel: channel.name });
    }
    await this.#reconcileProjects();
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  async #stateId(name: string): Promise<string> {
    this.#states ??= new Map(
      (await this.#linear.states(this.#c.teamKey)).map((s) => [s.name, s.id]),
    );
    const id = this.#states.get(name);
    if (!id) throw new Error(`no Linear status named ${name}`);
    return id;
  }

  /** Title metadata that belongs to a status, dropped when an issue leaves it. */
  #statusKeys(status: string): string[] {
    if (status === this.#c.dateState) return ["start"];
    if (status === this.#c.listenerState) return ["event", "stop"];
    return [];
  }

  /** Moves an issue to another status in Linear, stripping the old status's keys from its title. */
  async #move(issue: LinearIssue, to: string): Promise<void> {
    const { name, meta } = parseTitle(issue.title);
    const stale = this.#statusKeys(issue.state.name).filter((key) => key in meta);
    for (const key of stale) delete meta[key];
    await this.#linear.updateIssue(issue.id, {
      stateId: await this.#stateId(to),
      ...(stale.length ? { title: formatTitle(name, meta) } : {}),
    });
  }

  #text(markdown: string): string {
    return linearToSlack(markdown).trim() || "(empty comment)";
  }

  async #slackBody(userId: string, text: string, files?: SlackFile[]): Promise<string> {
    const names = new Map<string, string>();
    for (const [, id] of text.matchAll(/<@([UW][A-Z0-9]+)/g))
      names.set(id!, await this.#nameOf(id!));
    const converted = slackToLinear(text, (id) => names.get(id) ?? id);
    const attachments = (files ?? [])
      .filter((f) => f.permalink)
      .map((f) => `📎 [${f.title || f.name || "file"}](${f.permalink})`);
    const parts = [
      `**${await this.#nameOf(userId)} in Slack:** ${converted}`.trim(),
      ...attachments,
    ];
    return parts.join("\n\n");
  }

  async #nameOf(userId: string): Promise<string> {
    const cached = this.#store.name(userId);
    if (cached) return cached;
    let name = userId;
    try {
      const info = await this.#bot("users.info", { user: userId });
      const user = info.user as {
        name?: string;
        real_name?: string;
        profile?: { display_name?: string; real_name?: string };
      };
      name =
        user.profile?.display_name ||
        user.real_name ||
        user.profile?.real_name ||
        user.name ||
        userId;
    } catch (error) {
      this.#log("users_info_failed", { userId, error: String(error) });
      return userId;
    }
    this.#store.putName(userId, name);
    return name;
  }

  async #botUser(): Promise<string> {
    this.#botUserId ??= (await this.#bot("auth.test")).user_id as string;
    return this.#botUserId;
  }

  /** Channels Leon can see (through his session), else the ones the bot is in. */
  async #listChannels(): Promise<ChannelInfo[]> {
    if (this.#channels) return this.#channels;
    const out: ChannelInfo[] = [];
    let cursor = "";
    do {
      const page = this.#session
        ? await this.#session("conversations.list", {
            types: "public_channel,private_channel",
            exclude_archived: false,
            limit: 1000,
            cursor: cursor || undefined,
          })
        : await this.#bot("users.conversations", {
            types: "public_channel,private_channel",
            exclude_archived: false,
            limit: 1000,
            cursor: cursor || undefined,
          });
      for (const c of page.channels as { id: string; name: string; is_archived: boolean }[])
        out.push({ id: c.id, name: c.name, archived: c.is_archived });
      cursor = (page.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "";
    } while (cursor);
    this.#channels = out;
    return out;
  }

  /** Reopens, adopts or creates the channel for an issue. */
  async #openChannel(
    issue: LinearIssue,
    prev: IssueRecord | null,
  ): Promise<ChannelInfo & { created: boolean }> {
    const reuse = async (channel: ChannelInfo) => {
      if (channel.archived) {
        if (!this.#session)
          throw new Error(
            `channel ${channel.name} is archived and there is no session to unarchive it`,
          );
        await tolerate(this.#session("conversations.unarchive", { channel: channel.id }), [
          "not_archived",
        ]);
      }
      await this.#join(channel.id);
      return { ...channel, archived: false, created: false };
    };
    if (prev) return reuse({ id: prev.channelId, name: prev.channelName, archived: true });
    const existing = (await this.#listChannels())
      .filter((c) => channelNumber(this.#c.channelPrefix, c.name) === issue.number)
      .sort((a, b) => Number(a.archived) - Number(b.archived))[0];
    if (existing) {
      this.#log("adopted_channel", { issue: issue.identifier, channel: existing.name });
      return reuse(existing);
    }

    const base = channelName(
      this.#c.channelPrefix,
      issue.number,
      parseTitle(issue.title).name,
      this.#c.channelNameMax,
    );
    for (let attempt = 0; attempt < 5; attempt++) {
      const name =
        attempt === 0 ? base : `${base.slice(0, this.#c.channelNameMax - 3)}-${attempt + 1}`;
      let id: string;
      try {
        const created = await this.#bot("conversations.create", { name, is_private: true });
        id = (created.channel as { id: string }).id;
      } catch (error) {
        if (error instanceof SlackError && error.code === "name_taken") continue;
        throw error;
      }
      for (const user of [this.#c.leonUserId, this.#c.hermesUserId])
        await tolerate(this.#bot("conversations.invite", { channel: id, users: user }), [
          "already_in_channel",
          "cant_invite_self",
          "user_not_found",
        ]);
      this.#channels?.push({ id, name, archived: false });
      this.#log("created_channel", { issue: issue.identifier, channel: name });
      return { id, name, archived: false, created: true };
    }
    throw new Error(`no free channel name for ${issue.identifier}`);
  }

  /** Makes the bot (and Hermes) members of a channel Leon is in, using his session to invite. */
  async #join(channelId: string): Promise<void> {
    if (!this.#session) {
      await tolerate(this.#bot("conversations.join", { channel: channelId }), [
        "already_in_channel",
        "method_not_supported_for_channel_type",
      ]);
      return;
    }
    for (const user of [await this.#botUser(), this.#c.hermesUserId])
      await tolerate(this.#session("conversations.invite", { channel: channelId, users: user }), [
        "already_in_channel",
        "cant_invite_self",
      ]);
  }

  async #archive(channelId: string): Promise<void> {
    try {
      await tolerate(this.#bot("conversations.archive", { channel: channelId }), [
        ...ARCHIVED,
        "channel_not_found",
      ]);
    } catch (error) {
      if (!(error instanceof SlackError) || !this.#session) throw error;
      await tolerate(this.#session("conversations.archive", { channel: channelId }), [
        ...ARCHIVED,
        "channel_not_found",
      ]);
    }
  }

  async #rename(channelId: string, name: string): Promise<boolean> {
    for (const client of [this.#bot, this.#session]) {
      if (!client) continue;
      try {
        await client("conversations.rename", { channel: channelId, name });
        return true;
      } catch (error) {
        if (error instanceof SlackError && error.code === "name_taken") return false;
        this.#log("rename_failed", { channelId, name, error: String(error) });
      }
    }
    return false;
  }

  /** The managed sections, top to bottom: the statuses, then projects. */
  #order(): string[] {
    const { sectionOrder, projectSection } = this.#c;
    return sectionOrder.includes(projectSection) ? sectionOrder : [...sectionOrder, projectSection];
  }

  /** Files the channel in the named section (a status, or projects). False when there's no session. */
  async #place(channelId: string, name: string): Promise<boolean> {
    if (!this.#sidebar) return false;
    const order = this.#order().includes(name) ? this.#order() : [...this.#order(), name];
    const sections = await this.#sidebar.ensure(order, [name]);
    await this.#sidebar.move(channelId, name, sections, order);
    return true;
  }

  async #unplace(channelId: string): Promise<void> {
    await this.#sidebar?.release(channelId, this.#order());
  }

  #mentions(issue: LinearIssue, post: StatusPost = {}): string {
    const status = issue.state.name;
    const lines: string[] = [];
    if (this.#c.mentionLeonStates.includes(status) && !post.quietLeon)
      lines.push(`<@${this.#c.leonUserId}>`);
    if (this.#c.pingHermesStates.includes(status) && !post.quietHermes)
      lines.push(
        `<@${this.#c.hermesUserId}> ${issue.identifier} is now ${status}: ${
          status === "Awaiting Hermes" ? "an agent is waiting on you." : "please pick it up."
        }`,
      );
    return lines.join(" ");
  }

  async #postStatus(
    channelId: string,
    from: string,
    issue: LinearIssue,
    post: StatusPost = {},
  ): Promise<void> {
    const mentions = this.#mentions(issue, post);
    const move = `*${from}* → *${issue.state.name}*${post.note ? ` ${post.note}` : ""}`;
    await tolerate(
      this.#bot("chat.postMessage", {
        channel: channelId,
        text: `${move}${mentions ? `\n${mentions}` : ""}`,
        unfurl_links: false,
      }),
      ARCHIVED,
    );
  }

  async #postIntro(channelId: string, issue: LinearIssue): Promise<void> {
    const { name } = parseTitle(issue.title);
    const safe = name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const description = issue.description ? linearToSlack(issue.description).trim() : "";
    const excerpt = description.length > 2500 ? `${description.slice(0, 2500)}…` : description;
    const mentions = this.#mentions(issue);
    const text = [
      `*<${issue.url}|${issue.identifier}: ${safe}>* · ${issue.state.name}`,
      excerpt,
      mentions,
    ]
      .filter(Boolean)
      .join("\n\n");
    await this.#bot("chat.postMessage", {
      channel: channelId,
      text,
      unfurl_links: false,
      unfurl_media: false,
    });
  }
}
