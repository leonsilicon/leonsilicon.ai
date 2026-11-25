import type { IssueMetadata } from "#issue-metadata";
import { CLIENT_MSG_ID_PREFIX } from "@-/ai.leonsilicon.services.slack-as-leon";
import { AWAITING_HERMES, commandLine, commandUsage, matchStatus, parseCommand } from "#command";
import type { AutolinearCommand } from "#command";
import type { SyncConfig } from "#config";
import {
  channelName,
  channelNumber,
  escapeSlack,
  hasTime,
  issueDescription,
  issueWorkflow,
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
  workflowDescription,
} from "#format";
import type {
  IssueUpdate,
  LinearApi,
  LinearIssue,
  LinearProject,
  ProjectChannelSettings,
} from "#linear";
import { Sidebar, SlackError, tolerate } from "#slack";
import type { SlackCall, SlackParams, SlackResponse } from "#slack";
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
  message?: {
    ts: string;
    user?: string;
    text?: string;
    thread_ts?: string;
    bot_id?: string;
    files?: SlackFile[];
  };
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

/**
 * A channel autolinear opened for an issue it made from one of Leon's Slack messages, handed over
 * to the sync (`Sync.adopt`). autolinear passes what it already knows, so adopting needs no Linear
 * call.
 */
export interface Adoption {
  issueId: string;
  identifier: string;
  title: string;
  stateName: string;
  channelId: string;
  channelName: string;
  /** Where Leon wrote the message, and its thread when it's a reply. */
  sourceChannel: string;
  sourceTs: string;
  sourceThreadTs?: string | null;
  /** The intro's line saying where the issue came from, in Slack mrkdwn. */
  lead: string;
}

/** A message as `conversations.replies` returns it. */
interface SlackMessage {
  ts: string;
  thread_ts?: string;
  user?: string;
  username?: string;
  bot_profile?: { name?: string };
  text?: string;
}

/** Hermes finished a turn on a message in an issue channel (`Sync.onAnswered`). */
interface Answer {
  channel: string;
  /** The message Hermes took up. */
  ts: string;
  /** Hermes reacted ❌: the turn failed. */
  failed: boolean;
}

/** A command for Autolinear (`Sync.onCommand`): from Hermes's message, or Leon's `/autolinear`. */
export interface CommandJob {
  channel: string;
  /** Hermes's message's ts, or `slash-<trigger id>` for Leon's slash command. */
  ts: string;
  /** The Slack thread parent, or the command's own timestamp for a top-level message. */
  threadTs?: string;
  /** Hermes's whole message, or Leon's words after `/autolinear`. */
  text: string;
  by: "hermes" | "leon";
  /** Where Leon's slash command is answered (Slack's `response_url`, ephemeral). */
  responseUrl?: string;
}

/** What a command came to: told back to Leon, or to Hermes when it didn't work. */
interface Outcome {
  ok: boolean;
  text: string;
}

export interface SyncDeps {
  config: SyncConfig;
  store: Store;
  issueMetadata: IssueMetadata;
  linear: LinearApi;
  /** The sync's own Slack app. */
  bot: SlackCall;
  /** Leon's web session. Without it, sidebar sections and unarchiving are skipped. */
  session: SlackCall | null;
  now?: () => number;
  /** Waits, while Linear creates a project channel. Tests pass one that returns at once. */
  sleep?: (ms: number) => Promise<void>;
  log?: (event: string, fields?: Record<string, unknown>) => void;
  /** The bot's own Slack user ID, when the caller already knows it; else `auth.test` finds it. */
  botUserId?: string;
  /**
   * Autolinear's bot reacts to automatic moves, reminds Hermes when it owes a command, and
   * explains command failures.
   */
  autolinear?: SlackCall | null;
  /** Answers Leon's `/autolinear` at Slack's `response_url`. Tests pass a fake. */
  respond?: (url: string, text: string) => Promise<void>;
}

/** Answers a slash command, visible only to whoever typed it. */
async function respondAt(url: string, text: string): Promise<void> {
  if (!url.startsWith("https://hooks.slack.com/")) throw new Error("not a Slack response URL");
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", text }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Slack's response URL answered ${response.status}`);
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

/**
 * First group of the ID of every issue autolinear creates. The sync waits for autolinear to hand
 * over such an issue's channel instead of making one itself (see `Sync.adopt`).
 */
export const AUTOLINEAR_ID_PREFIX = "a7011ea7";

/** The ID autolinear gives the issue it makes from a message: stable, so a retry finds it. */
export async function autolinearIssueId(seed: string): Promise<string> {
  return `${AUTOLINEAR_ID_PREFIX}${(await stableUuid(`autolinear:${seed}`)).slice(8)}`;
}

export const isAutolinearIssue = (issueId: string) =>
  issueId.startsWith(`${AUTOLINEAR_ID_PREFIX}-`);

/** How long an autolinear issue without a channel waits for its hand-over before getting one anyway. */
export const ADOPT_WAIT_MS = 2 * 60_000;

/**
 * How long after Hermes's ✅ (or ❌) its turn is checked for a command to Autolinear: Hermes reacts
 * right after its last post, and that post can reach the queue after the reaction does.
 */
export const ANSWER_SETTLE_MS = 10_000;

/** How long after Hermes last posted or edited a message its command is read and carried out. */
export const COMMAND_SETTLE_MS = 3000;

/**
 * How many times Autolinear asks Hermes for a command (a reminder, or why a command didn't work)
 * since Leon last wrote or a command last worked, before it tells Leon instead.
 */
export const MAX_REMINDERS = 2;

/** A Slack message ts as milliseconds. */
const slackTsMs = (ts: string) => Math.round(Number(ts) * 1000);

/**
 * The start of a Slack message as an mrkdwn quote, at most `max` characters, never cut inside a
 * `<…>` link or mention or an `&…;` entity.
 */
export function excerptQuote(text: string, max: number): string {
  let cut = text.trim();
  if (cut.length > max) {
    cut = cut.slice(0, max);
    const open = cut.lastIndexOf("<");
    if (open > cut.lastIndexOf(">")) cut = cut.slice(0, open);
    const amp = cut.lastIndexOf("&");
    if (amp > cut.lastIndexOf(";")) cut = cut.slice(0, amp);
    cut = `${cut.trimEnd()}…`;
  }
  return cut
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

const ARCHIVED = ["is_archived", "already_archived"];
const STATUS_REACTIONS = new Map([
  ["Awaiting Init", "seedling"],
  ["Awaiting Clarification", "grey_question"],
  ["Awaiting Date", "calendar"],
  ["Awaiting Start", "checkered_flag"],
  ["Awaiting Hermes", "robot_face"],
  ["Awaiting Leon", "bust_in_silhouette"],
  ["Awaiting Trigger", "bell"],
  ["Executing", "gear"],
  ["Done", "white_check_mark"],
  ["Canceled", "x"],
  ["Duplicate", "repeat"],
]);

/**
 * How long a new project is left alone before the sync asks for its channel. Linear's own "Create
 * channel for new projects" makes one within seconds of a project created in its app; projects
 * made through the API get none, so the sync makes those.
 */
export const PROJECT_GRACE_MS = 5 * 60_000;
/** How long to wait before asking Linear again for a channel that never appeared. */
const PROJECT_RETRY_MS = 30 * 60_000;

/** The timer of an issue: when its next start, stop or due time comes. */
const issueTimer = (issueId: string) => `timer:${issueId}`;
/** Recorded once an issue's due time has been announced, so it is announced once. */
const dueKey = (issueId: string, at: number) => `due:${issueId}:${at}`;
/**
 * Autolinear's records, per channel and message (a prefix with `ts` left out): `said` when Hermes's
 * message (or Leon's slash command) gave a command, so the turn said what to do; `done` once the
 * command was read, so it acts once; `worked` when it moved or kept the status; `asked` for each
 * time Autolinear asked Hermes for one.
 */
const saidKey = (channel: string, ts = "") => `said:${channel}:${ts}`;
const doneKey = (channel: string, ts = "") => `done:${channel}:${ts}`;
const workedKey = (channel: string, ts = "") => `worked:${channel}:${ts}`;
const askedKey = (channel: string, ts = "") => `asked:${channel}:${ts}`;
// Ignore late Slack deliveries of continuation messages sent before the command was retired.
const RETIRED_RESUME_MSG_ID_PREFIX = "a7011eaf-";
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
  readonly #issueMetadata: IssueMetadata;
  readonly #linear: LinearApi;
  readonly #bot: SlackCall;
  readonly #session: SlackCall | null;
  readonly #sidebar: Sidebar | null;
  readonly #now: () => number;
  readonly #log: (event: string, fields?: Record<string, unknown>) => void;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #autolinear: SlackCall | null;
  readonly #respond: (url: string, text: string) => Promise<void>;
  #botUserId: string | null = null;
  #channels: ChannelInfo[] | null = null;
  #projectChannels: ProjectChannelSettings | null | undefined;
  /** Linear status IDs by name, read once per drain. */
  #states: Map<string, string> | null = null;
  #feedId: string | null = null;

  constructor(deps: SyncDeps) {
    this.#c = deps.config;
    this.#store = deps.store;
    this.#issueMetadata = deps.issueMetadata;
    this.#linear = deps.linear;
    this.#bot = deps.bot;
    this.#session = deps.session;
    this.#sidebar = deps.session ? new Sidebar(deps.session) : null;
    this.#now = deps.now ?? Date.now;
    this.#sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#log = deps.log ?? (() => {});
    this.#botUserId = deps.botUserId ?? null;
    this.#autolinear = deps.autolinear ?? null;
    this.#respond = deps.respond ?? respondAt;
  }

  async run(kind: string, payload: unknown): Promise<void> {
    if (kind === "linear") {
      const hook = payload as LinearWebhook;
      if (hook.type === "Issue") await this.onLinearIssue(hook);
      else if (hook.type === "Comment") await this.onLinearComment(hook);
      else if (hook.type === "Project") {
        try {
          await this.onLinearProject(hook);
        } finally {
          await this.#refreshProjectVisibility();
        }
      }
    } else if (kind === "project") {
      // A delayed look at a new project, once Linear has had time to make its channel.
      const project = await this.#linear.project((payload as { id: string }).id);
      if (project && project.teamKeys.includes(this.#c.teamKey)) await this.syncProject(project);
      await this.#refreshProjectVisibility();
    } else if (kind === "slack") {
      const event = payload as SlackMessageEvent | SlackReactionEvent;
      if (event.type === "reaction_added") await this.onSlackReaction(event as SlackReactionEvent);
      else await this.onSlackMessage(event as SlackMessageEvent);
    } else if (kind === "timer") await this.onTimer((payload as { id: string }).id);
    else if (kind === "adopted") await this.onAdopted(payload as Adoption);
    else if (kind === "answered") await this.onAnswered(payload as Answer);
    else if (kind === "command") await this.onCommand(payload as CommandJob);
    else if (kind === "resume-hermes") return; // Discard continuation jobs queued before deployment.
    else if (kind === "tick") {
      await this.tick();
      await this.#refreshProjectVisibility();
    } else if (kind === "backfill") {
      await this.backfill();
      await this.#refreshProjectVisibility();
    } else if (kind === "project-visibility") await this.#refreshProjectVisibility();
    else this.#log("unknown_job", { kind });
  }

  // ── Linear → Slack ─────────────────────────────────────────────────────────

  async onLinearIssue(hook: LinearWebhook): Promise<void> {
    if (hook.action === "remove") {
      this.#store.setTimer(issueTimer(hook.data.id), "timer", null, null, this.#now());
      const rec = this.#store.issue(hook.data.id);
      if (rec) this.#issueMetadata.remove(rec);
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
  }

  /**
   * Brings an issue's channel and timer in line with the issue. `live` announces what changed;
   * `quiet` only fixes state, for backfills.
   */
  async syncIssue(issue: LinearIssue, mode: "live" | "quiet"): Promise<IssueRecord | null> {
    this.#planTimer(issue);
    const prev = this.#store.issue(issue.id);
    if (this.#c.closedStateTypes.includes(issue.state.type)) {
      if (!prev) return null;
      this.#issueMetadata.save(prev.channelId, issue);
      if (!prev.archived) {
        if (mode === "live" && prev.stateName !== issue.state.name)
          await this.#notifyStatus(prev.channelId, prev.stateName, issue);
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

    // autolinear opens its issues' channels itself and hands them over (`adopt`) within a second or
    // so. Wait for that rather than race it to a second channel; if it never comes, the issue gets
    // its channel the usual way (adopting autolinear's by number, if it exists) two minutes later.
    if (!prev && isAutolinearIssue(issue.id)) {
      const wait = `adopt-wait:${issue.id}`;
      if (!this.#store.fired(wait)) {
        const now = this.#now();
        this.#store.markFired(wait, now);
        this.#store.enqueue(
          wait,
          "linear",
          { action: "update", type: "Issue", data: { id: issue.id } },
          now,
          now + ADOPT_WAIT_MS,
        );
        return null;
      }
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

    this.#issueMetadata.save(rec.channelId, issue);

    if (mode === "live" && prev && prev.stateName !== issue.state.name)
      await this.#notifyStatus(rec.channelId, prev.stateName, issue);

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
   * renames, sets the channel summary and populates the channel itself.
   *
   * A day's project (named after a date, see `projectDay`) belongs to dailylinear, which makes it,
   * asks for its `project-YYYY-MM-DD` channel and keeps the day's channel in Starred. Here it only
   * gets Leon and Hermes in its channel, and has the channel archived when it closes.
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

    const day = projectDay(project.name) !== null;
    const channelId =
      project.slackChannelId ?? (day ? null : await this.#requestProjectChannel(project, prev));
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
    const section = this.#c.projectSection;
    // dailylinear files a day's channel: in Starred on its day, under Projects after.
    if (!day && rec.section !== section && (await this.#place(channelId, section)))
      rec.section = section;
    this.#store.putProject(rec);
    if (!same) this.#log("project_channel", { project: project.name, channel: channelId });
    this.#saveProjectAppearance(project, channelId);
    return rec;
  }

  #saveProjectAppearance(project: LinearProject, channelId: string): void {
    this.#store.saveProjectAppearance(project.id, {
      channelId,
      color:
        project.color && /^#[\da-f]{6}$/i.test(project.color) ? project.color.toLowerCase() : null,
      icon: project.icon?.trim() || null,
    });
  }

  async #channelSettings(): Promise<ProjectChannelSettings | null> {
    if (this.#projectChannels === undefined)
      this.#projectChannels = await this.#linear.projectChannelSettings();
    return this.#projectChannels;
  }

  /** Keep the closed Slack and Linear project channels available to the Matrix publisher. */
  async #refreshProjectVisibility(): Promise<void> {
    if (!this.#session) return;
    this.#channels = null;
    const channels = await this.#listChannels();
    const closed = new Set(
      channels
        .filter(({ name, archived }) => archived && name.startsWith("project-"))
        .map(({ id }) => id),
    );
    for (const id of await this.#linear.closedProjectChannels(
      this.#c.teamKey,
      this.#c.closedProjectTypes,
    ))
      closed.add(id);
    for (const { archived, channelId } of this.#store.allProjects()) {
      if (archived && channelId) closed.add(channelId);
    }
    this.#store.saveProjectVisibility([...closed].sort());
  }

  /** Takes a closed or deleted project's channel out of the sidebar and archives it. */
  async #closeProject(rec: ProjectRecord): Promise<void> {
    if (rec.channelId && !rec.archived) {
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
      // Hermes can stream a reply by editing it, so its command can first show up in an edit.
      if (edited?.user === this.#c.hermesUserId)
        return this.#onHermesMessage(event.channel, edited.ts, edited.text ?? "", edited.thread_ts);
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
    // Hermes's posts aren't mirrored, but one can carry a command for Autolinear.
    if (event.user === this.#c.hermesUserId)
      return this.#onHermesMessage(event.channel, event.ts, event.text ?? "", event.thread_ts);
    if (event.bot_id) return;
    // Hermes posting as Leon through slack-as-leon, to wake other bots; not Leon's own words.
    if (event.client_msg_id?.startsWith(CLIENT_MSG_ID_PREFIX)) return;
    if (event.client_msg_id?.startsWith(RETIRED_RESUME_MSG_ID_PREFIX)) return;
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
   * Hermes reacts to each message it takes up: 👀 when it starts, ✅ when its turn is over, ❌ when
   * the turn failed.
   *
   * - 👀 on Leon's message or a handoff ping in an issue channel moves the issue to Executing.
   * - ✅ or ❌ on any message in an issue channel (Leon's, a bot's ping, Autolinear's reminder) ends
   *   a turn, after which Hermes owes Autolinear a command. `onAnswered` checks a few seconds later,
   *   once Hermes's last posts are in. The answer itself moves nothing (Leon's rule, 2026-11-23).
   */
  async onSlackReaction(event: SlackReactionEvent): Promise<void> {
    const { hermesAckReaction, hermesAnsweredReaction, hermesFailedReaction } = this.#c;
    const ended =
      event.reaction === hermesAnsweredReaction || event.reaction === hermesFailedReaction;
    if (event.reaction !== hermesAckReaction && !ended) return;
    if (event.user !== this.#c.hermesUserId) return;
    const { channel, ts } = event.item;
    if (event.item.type !== "message" || !channel || !ts) return;
    const rec = this.#store.issueByChannel(channel);
    if (!rec || rec.archived) return;
    if (!ended) {
      if (event.item_user === this.#c.leonUserId) return this.onHermesAck(rec, ts);
      if (!event.item_user || !this.#c.pingHermesStates.includes(rec.stateName)) return;
      if (event.item_user !== (await this.#botUser())) return;
      const ping = await this.#reactionMessage(channel, ts);
      if (ping?.text && mentions(ping.text, this.#c.hermesUserId)) await this.onHermesAck(rec, ts);
      return;
    }
    const now = this.#now();
    const answer: Answer = { channel, ts, failed: event.reaction === hermesFailedReaction };
    this.#store.enqueue(
      `answered:${channel}:${ts}`,
      "answered",
      answer,
      now,
      now + ANSWER_SETTLE_MS,
    );
  }

  /**
   * Hermes took up a message (👀): the issue moves to Executing without pinging Hermes. The
   * sidebar moves alongside the issue. The previous status and title keys stay available so
   * Hermes can restore the issue with a command.
   */
  async onHermesAck(rec: IssueRecord, ts: string): Promise<void> {
    const issue = await this.#openIssueIn(rec.channelId);
    if (!issue) return;
    const to = this.#c.hermesAckState;
    const from = issue.state.name;
    const prior = this.#store.ack(issue.id);
    // Already Hermes's: from an earlier 👀 (whose `from` still counts), or by someone's choice.
    if (from === to && prior?.at !== null) return;
    // Keep the message timestamp so a retry or the Linear webhook can react to the same message.
    const pending = from === to ? prior : null;
    const ack = {
      issueId: issue.id,
      fromState: pending?.fromState ?? from,
      at: null,
      messageTs: pending?.messageTs ?? ts,
    };
    this.#store.putAck(ack);
    const [placed] = await Promise.all([
      this.#place(rec.channelId, to),
      from !== to ? this.#move(issue, to, { keepKeys: true }) : null,
    ]);
    const current = this.#store.issue(issue.id);
    if (placed && current) this.#store.putIssue({ ...current, section: to });
    const moved = await this.#linear.issue(issue.id);
    if (moved) await this.syncIssue(moved, "live");
    this.#store.putAck({ ...ack, at: this.#now() });
    this.#log("hermes_ack", { issue: issue.identifier, from });
  }

  async #reactionMessage(channel: string, ts: string): Promise<SlackMessage | undefined> {
    const result = await tolerate(this.#bot("reactions.get", { channel, timestamp: ts }), [
      "message_not_found",
    ]);
    return result?.message as SlackMessage | undefined;
  }

  /**
   * Hermes's turn in an issue channel is over. Leon's rule (2026-11-23): every turn ends with Hermes
   * telling Autolinear what to do with the channel, in a line that starts with Autolinear's mention
   * (`onCommand`), and nothing moves on what Hermes answered. A turn that ended without a command, or
   * failed, gets a reminder from Autolinear, which mentions Hermes and so starts another turn. A turn
   * on a message Leon has written after is skipped: Hermes's turn on his newer message counts.
   */
  async onAnswered(answer: Answer): Promise<void> {
    const issue = await this.#openIssueIn(answer.channel);
    if (!issue) return;
    if (this.#store.spokeAfter(answer.channel, answer.ts)) return;
    if (this.#store.firedSince(saidKey(answer.channel), slackTsMs(answer.ts)).length) return;
    const status = issue.state.name;
    const ack = this.#store.ack(issue.id);
    const before =
      ack && status === this.#c.hermesAckState && ack.fromState !== status
        ? ` Before your :${this.#c.hermesAckReaction}: it was *${ack.fromState}*.`
        : "";
    const opening = answer.failed
      ? "Your turn here failed, so I still don't know"
      : "Your turn here is over, but you haven't told me";
    await this.#askHermes(
      issue,
      answer.channel,
      `${opening} what to do with ${issue.identifier}, which is *${status}*.${before} Answer with a line of its own that starts with my mention:\n${commandUsage("@Autolinear")}`,
    );
    this.#log("autolinear_reminded", { issue: issue.identifier, failed: answer.failed });
  }

  /**
   * Hermes's message in an issue channel, new or edited. A line that starts with Autolinear's mention
   * is a command: the turn has said what to do from the moment the line shows up, and the command is
   * read and carried out (`onCommand`) once Hermes hasn't edited the message for a few seconds.
   * Mentioning Leon moves nothing, here or in a Linear comment (Leon's rule, 2026-11-23: issues move
   * only by explicit commands).
   */
  async #onHermesMessage(
    channelId: string,
    ts: string,
    text: string,
    threadTs?: string,
  ): Promise<void> {
    if (commandLine(text, this.#c.autolinearUserId) === null) return;
    const rec = this.#store.issueByChannel(channelId);
    if (!rec || rec.archived) return;
    const now = this.#now();
    this.#store.markFired(saidKey(channelId, ts), now);
    if (this.#store.fired(doneKey(channelId, ts))) return;
    const job: CommandJob = {
      channel: channelId,
      ts,
      threadTs: threadTs ?? ts,
      text,
      by: "hermes",
    };
    this.#store.setTimer(
      `command:${channelId}:${ts}`,
      "command",
      job,
      now + COMMAND_SETTLE_MS,
      now,
    );
  }

  /**
   * A command for Autolinear (Leon's rule, 2026-11-23; `#command`): from the last line of Hermes's
   * message that starts with Autolinear's mention, or from Leon's `/autolinear`. `move` goes through
   * at once, with its workflow details, and the channel follows; `stay` keeps the status. Successful
   * Hermes commands run silently. Autolinear explains failures so Hermes can try again. Leon's slash
   * command gets its answer privately. Each message acts once.
   */
  async onCommand(job: CommandJob): Promise<void> {
    const done = doneKey(job.channel, job.ts);
    if (this.#store.fired(done)) return;
    const words = job.by === "leon" ? job.text : commandLine(job.text, this.#c.autolinearUserId);
    const rec = this.#store.issueByChannel(job.channel);
    const pending = rec && this.#store.commandMove(rec.issueId);
    const move = pending?.ts === job.ts ? pending : null;
    const issue = rec && (!rec.archived || move) ? await this.#linear.issue(rec.issueId) : null;
    const moved = issue !== null && issue.state.name === move?.toState;
    const open = issue && !this.#c.closedStateTypes.includes(issue.state.type);
    if (job.by === "leon") this.#store.markFired(saidKey(job.channel, job.ts), this.#now());
    if (words !== null && (moved || open || job.by === "leon")) {
      let outcome: Outcome;
      if (moved) {
        // A previous attempt wrote to Linear. Finish syncing even if the command closed the issue.
        await this.syncIssue(issue, "live");
        outcome = { ok: true, text: `${issue.identifier} is now *${move.toState}*.` };
      } else if (open) outcome = await this.#command(issue, words, job);
      else outcome = { ok: false, text: "This isn't the channel of an open issue." };
      if (job.by === "leon") {
        if (job.responseUrl) await this.#respond(job.responseUrl, outcome.text);
      } else if (!outcome.ok)
        await this.#askHermes(issue!, job.channel, outcome.text, job.threadTs ?? job.ts);
      if (outcome.ok && issue) {
        this.#store.markFired(workedKey(job.channel, job.ts), this.#now());
        this.#store.dropAck(issue.id);
      }
    }
    if (rec) this.#store.dropCommandMove(rec.issueId, job.ts);
    this.#store.markFired(done, this.#now());
  }

  /** Reads and carries out a command's words for an issue. */
  async #command(issue: LinearIssue, words: string, job: CommandJob): Promise<Outcome> {
    const lead = job.by === "leon" ? "/autolinear" : "@Autolinear";
    const parsed = parseCommand(words);
    if (!parsed.ok)
      return { ok: false, text: `I couldn't do that: ${parsed.error}.\n${commandUsage(lead)}` };
    const { command } = parsed;
    if (command.verb === "help")
      return {
        ok: false,
        text: `Tell me what to do with ${issue.identifier}, which is *${issue.state.name}*:\n${commandUsage(lead)}`,
      };
    if (command.verb === "stay")
      return { ok: true, text: `${issue.identifier} stays *${issue.state.name}*.` };
    return this.#commandMove(issue, command, job);
  }

  /**
   * Moves an issue with workflow details from the command or already on the issue. Awaiting
   * Trigger accepts a person or a timed event. Switching waits clears the previous wait's details.
   */
  async #commandMove(
    issue: LinearIssue,
    command: Extract<AutolinearCommand, { verb: "move" }>,
    job: CommandJob,
  ): Promise<Outcome> {
    const fail = (why: string) => ({ ok: false, text: `I couldn't do that: ${why}.` });
    const names = [...(await this.#stateIds()).keys()].filter(
      (name) => name.toLowerCase() !== AWAITING_HERMES.toLowerCase(),
    );
    // Older Hermes prompts and already queued commands may still use the old status names.
    const status = matchStatus(command.status, ["Awaiting Others", "Awaiting Listener"])
      ? this.#c.triggerState
      : command.status;
    const to = matchStatus(status, names);
    if (!to) return fail(`no status is called "${command.status}"; use one of ${names.join(", ")}`);
    const previous = issueWorkflow(issue);
    const meta = { ...previous };
    const { keys } = command;
    for (const status of [this.#c.dateState, this.#c.triggerState]) {
      if (status === to) continue;
      for (const key of this.#statusKeys(status)) {
        if (key in keys) return fail(`\`--${key}\` goes with *${status}* only`);
        delete meta[key];
      }
    }
    for (const [key, value] of Object.entries(keys))
      if (key !== "event" && key !== "who" && !metaInstant(value, this.#c.timeZone))
        return fail(`\`--${key} ${value}\` needs a day (YYYY-MM-DD) or an RFC 3339 time`);
    Object.assign(meta, keys);
    let required = to === this.#c.dateState ? ["start"] : [];
    if (to === this.#c.triggerState) {
      const timed = keys.event || keys.stop;
      const either = "`--who` or both `--event` and `--stop`";
      if (keys.who && timed) return fail(`*${to}* accepts either ${either}`);
      if (keys.who) {
        delete meta.event;
        delete meta.stop;
      } else if (timed) delete meta.who;
      if (!meta.who) {
        if (!meta.event && !meta.stop) return fail(`*${to}* needs ${either}`);
        required = ["event", "stop"];
      }
    }
    const missing = required.filter((key) => !meta[key]);
    if (missing.length)
      return fail(`*${to}* needs ${missing.map((k) => `\`--${k}\``).join(" and ")}`);
    const update: IssueUpdate = {};
    if (to !== issue.state.name) update.stateId = await this.#stateId(to);
    if (Object.keys({ ...previous, ...meta }).some((key) => previous[key] !== meta[key]))
      update.description = workflowDescription(issue, meta);
    if (keys.due) {
      const due = metaInstant(keys.due, this.#c.timeZone)!;
      const day = localDay(due.getTime(), this.#c.timeZone);
      if (day !== issue.dueDate) update.dueDate = day;
    }
    if (!Object.keys(update).length)
      return { ok: true, text: `${issue.identifier} is already *${to}*.` };
    if (update.stateId !== undefined)
      this.#store.putCommandMove({
        issueId: issue.id,
        ts: job.ts,
        by: job.by,
        fromState: issue.state.name,
        toState: to,
      });
    await this.#linear.updateIssue(issue.id, update);
    const moved = await this.#linear.issue(issue.id);
    const by = job.by === "leon" ? "Leon" : "Hermes";
    if (moved) await this.syncIssue(moved, "live");
    this.#log("autolinear_command", { issue: issue.identifier, from: issue.state.name, to, by });
    return { ok: true, text: `${issue.identifier} is now *${to}*.` };
  }

  /**
   * Autolinear asks Hermes for a command, mentioning it, so the answer starts a turn: a reminder,
   * or why a command didn't work (in a thread under Hermes's message, `threadTs`). After
   * `MAX_REMINDERS` since Leon last wrote or a command last worked, it tells Leon once instead and
   * stops asking, so Hermes and Autolinear can't keep each other going.
   */
  async #askHermes(
    issue: LinearIssue,
    channel: string,
    text: string,
    threadTs?: string,
  ): Promise<void> {
    if (!this.#autolinear || !this.#c.autolinearUserId) {
      this.#log("autolinear_unconfigured", { issue: issue.identifier });
      return;
    }
    const spoke = this.#store.lastSpoke(channel);
    const since = Math.max(
      spoke ? slackTsMs(spoke) : 0,
      this.#store.firedSince(workedKey(channel), 0).at(-1)?.at ?? 0,
    );
    const now = this.#now();
    if (this.#store.firedSince(askedKey(channel), since).length >= MAX_REMINDERS) {
      const key = `gave-up:${channel}:${since}`;
      if (this.#store.fired(key)) return;
      await this.#autolinearCall("chat.postMessage", {
        channel,
        text: `<@${this.#c.leonUserId}> Hermes still hasn't told me what to do with ${issue.identifier} after ${MAX_REMINDERS} reminders, so it stays *${issue.state.name}*.`,
        unfurl_links: false,
      });
      this.#store.markFired(key, now);
      this.#log("autolinear_gave_up", { issue: issue.identifier });
      return;
    }
    const posted = await this.#autolinearCall("chat.postMessage", {
      channel,
      text: `<@${this.#c.hermesUserId}> ${text}`,
      thread_ts: threadTs,
      unfurl_links: false,
    });
    this.#store.markFired(askedKey(channel, posted.ts as string), now);
  }

  /**
   * Autolinear's bot, in an issue channel. A private channel it isn't in answers as if it didn't
   * exist, so Leon's session invites it and the call is made again.
   */
  async #autolinearCall(method: string, params: SlackParams): Promise<SlackResponse> {
    const bot = this.#autolinear!;
    try {
      return await bot(method, params);
    } catch (error) {
      const outside =
        error instanceof SlackError &&
        (error.code === "not_in_channel" || error.code === "channel_not_found");
      if (!outside || !this.#session || !this.#c.autolinearUserId) throw error;
      await tolerate(
        this.#session("conversations.invite", {
          channel: params.channel,
          users: this.#c.autolinearUserId,
        }),
        ["already_in_channel"],
      );
      return bot(method, params);
    }
  }

  /** The open issue whose channel this is, read fresh from Linear. Null for any other channel. */
  async #openIssueIn(channelId: string): Promise<LinearIssue | null> {
    const rec = this.#store.issueByChannel(channelId);
    if (!rec || rec.archived) return null;
    const issue = await this.#linear.issue(rec.issueId);
    if (!issue || this.#c.closedStateTypes.includes(issue.state.type)) return null;
    return issue;
  }

  // ── autolinear's issues ────────────────────────────────────────────────────

  /**
   * Takes over the channel autolinear opened for an issue it made from one of Leon's Slack
   * messages (Leon's rule, 2026-11-21: every message gets an issue and a channel at once).
   * autolinear does only what Leon sees right away (the issue, the channel, the link in his
   * message, the copy Hermes answers) and calls this through a Durable Object binding as soon as
   * the channel exists. This invites the bot and Hermes, records the channel, so Hermes's 👀 and ✅
   * move the issue from then on, and queues an `adopted` job for the rest. Repeating it does nothing.
   */
  async adopt(a: Adoption): Promise<void> {
    if (this.#store.issue(a.issueId)) return;
    const session = this.#session;
    if (!session) throw new Error("adopting a channel needs Leon's session to invite the bot");
    // Invited before the channel is recorded: from then on, any job may post in it.
    const users = [await this.#botUser(), ...this.#helpers()];
    try {
      await session("conversations.invite", { channel: a.channelId, users: users.join(",") });
    } catch (error) {
      if (!(error instanceof SlackError)) throw error;
      for (const user of users)
        await tolerate(session("conversations.invite", { channel: a.channelId, users: user }), [
          "already_in_channel",
          "cant_invite_self",
        ]);
    }
    this.#store.putIssue({
      issueId: a.issueId,
      identifier: a.identifier,
      title: a.title,
      stateName: a.stateName,
      channelId: a.channelId,
      channelName: a.channelName,
      section: null,
      topic: null,
      archived: false,
    });
    this.#store.enqueue(`adopted:${a.issueId}`, "adopted", a, this.#now());
    this.#log("adopted_channel", { issue: a.identifier, channel: a.channelName });
  }

  /**
   * The rest of an adopted channel's setup, off autolinear's path: files the issue in the project
   * whose channel Leon wrote in, adds a reply's thread to the description, posts the intro (saying
   * where the issue came from, pinging no one), then sets the topic and section like any sync.
   */
  async onAdopted(a: Adoption): Promise<void> {
    const rec = this.#store.issue(a.issueId);
    const issue = await this.#linear.issue(a.issueId);
    if (!rec || rec.archived || !issue) return;
    const key = `adopted:${a.issueId}`;
    if (!this.#store.fired(key)) {
      const update: IssueUpdate = {};
      const project = this.#store.projectByChannel(a.sourceChannel);
      if (project) update.projectId = project.projectId;
      let lead = a.lead;
      const root =
        a.sourceThreadTs && a.sourceThreadTs !== a.sourceTs
          ? await this.#threadRoot(a.sourceChannel, a.sourceThreadTs)
          : null;
      if (root?.text) {
        lead += `\n${excerptQuote(root.text, 300)}`;
        update.description = `${issue.description ?? ""}\n\n${await this.#inReplyTo(a.sourceChannel, root)}`;
      }
      if (Object.keys(update).length) await this.#linear.updateIssue(issue.id, update);
      await this.#postIntro(rec.channelId, issue, { lead, quiet: true });
      this.#store.markFired(key, this.#now());
    }
    await this.syncIssue((await this.#linear.issue(a.issueId)) ?? issue, "live");
  }

  /** The first message of a thread, through Leon's session. Null when it can't be read. */
  async #threadRoot(channelId: string, threadTs: string): Promise<SlackMessage | null> {
    if (!this.#session) return null;
    try {
      const page = await this.#session("conversations.replies", {
        channel: channelId,
        ts: threadTs,
        limit: 1,
      });
      const root = (page.messages as SlackMessage[] | undefined)?.[0];
      return root?.ts === threadTs ? root : null;
    } catch (error) {
      if (!(error instanceof SlackError)) throw error;
      this.#log("thread_root_failed", { channel: channelId, error: error.code });
      return null;
    }
  }

  /** A thread's first message, quoted in Markdown for the issue's description. */
  async #inReplyTo(channelId: string, root: SlackMessage): Promise<string> {
    const author = root.user
      ? await this.#nameOf(root.user)
      : (root.username ?? root.bot_profile?.name ?? "someone");
    let link = "";
    try {
      const data = await this.#session!("chat.getPermalink", {
        channel: channelId,
        message_ts: root.ts,
      });
      if (typeof data.permalink === "string") link = ` ([thread](${data.permalink}))`;
    } catch (error) {
      if (!(error instanceof SlackError)) throw error;
    }
    const names = new Map<string, string>();
    for (const [, id] of (root.text ?? "").matchAll(/<@([UW][A-Z0-9]+)/g))
      names.set(id!, await this.#nameOf(id!));
    const quoted = slackToLinear(root.text ?? "", (id) => names.get(id) ?? id)
      .slice(0, 1500)
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    return `In reply to **${author}**${link}:\n\n${quoted}`;
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
   * Trigger issue whose `stop` has passed back to Leon, and announces an issue whose due time has
   * come in the feed channel, once. Then sets the issue's timer for whatever is left.
   */
  async #runTimes(issue: LinearIssue): Promise<void> {
    if (this.#c.closedStateTypes.includes(issue.state.type)) return this.#planTimer(issue);
    const now = this.#now();
    const meta = issueWorkflow(issue);
    const come = (value: string | undefined) => {
      const at = value ? metaInstant(value, this.#c.timeZone) : null;
      return at !== null && at.getTime() <= now;
    };
    let moved = false;
    if (issue.state.name === this.#c.dateState && come(meta.start)) {
      await this.#move(issue, this.#c.dateTarget);
      this.#log("start_date_reached", { issue: issue.identifier });
      moved = true;
    } else if (issue.state.name === this.#c.triggerState && come(meta.stop)) {
      const { event, stop } = meta;
      await this.#move(issue, this.#c.triggerExpiredTarget);
      await this.#linear.createComment({
        id: await stableUuid(`listener-expired:${issue.id}:${stop}`),
        issueId: issue.id,
        body: `**slack22linear:** the trigger's stop date (${stop}) passed${event ? ` while waiting for: ${event}` : ""}. Extend the wait or cancel the issue.`,
      });
      this.#log("trigger_expired", { issue: issue.identifier });
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
   * Date issue, the `stop` of an Awaiting Trigger issue, and a due time not yet announced. A time
   * already past goes off at once. A closed issue has no timer.
   */
  #planTimer(issue: LinearIssue): void {
    const times: number[] = [];
    if (!this.#c.closedStateTypes.includes(issue.state.type)) {
      const meta = issueWorkflow(issue);
      const add = (value: string | undefined) => {
        const at = value ? metaInstant(value, this.#c.timeZone) : null;
        if (at) times.push(at.getTime());
      };
      if (issue.state.name === this.#c.dateState) add(meta.start);
      if (issue.state.name === this.#c.triggerState) add(meta.stop);
      const due = this.#due(issue);
      if (due && !this.#store.fired(dueKey(issue.id, due.at))) times.push(due.at);
    }
    const at = times.length ? Math.min(...times) : null;
    this.#store.setTimer(issueTimer(issue.id), "timer", { id: issue.id }, at, this.#now());
  }

  /**
   * When an issue is due: the workflow's `due` (a bare date is midnight, like `start`), else Linear's
   * own due date, which has no time, at midnight starting that day. Both in `timeZone`.
   */
  #due(issue: LinearIssue): Due | null {
    for (const value of [issueWorkflow(issue).due, issue.dueDate]) {
      const at = value ? metaInstant(value, this.#c.timeZone) : null;
      if (value && at) return { at: at.getTime(), timed: hasTime(value) };
    }
    return null;
  }

  /**
   * Keeps Linear's due date on the day of the workflow's `due`. A change from Linear's date
   * picker updates the workflow's day and keeps its time of day.
   */
  async #syncDue(issue: LinearIssue, changed: Record<string, unknown> = {}): Promise<LinearIssue> {
    if (this.#c.closedStateTypes.includes(issue.state.type)) return issue;
    const meta = issueWorkflow(issue);
    const at = meta.due ? metaInstant(meta.due, this.#c.timeZone) : null;
    if (!meta.due || !at) return issue;
    const day = localDay(at.getTime(), this.#c.timeZone);
    if (issue.dueDate === day) return issue;
    if ("dueDate" in changed && !("title" in changed) && !("description" in changed)) {
      const due = issue.dueDate ? withDay(meta.due, issue.dueDate, this.#c.timeZone) : null;
      if (due) meta.due = due;
      else delete meta.due;
      const description = workflowDescription(issue, meta);
      await this.#linear.updateIssue(issue.id, { description });
      this.#log("due_from_linear", { issue: issue.identifier, due });
      return { ...issue, description };
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
        purpose: `Linear issues of team ${this.#c.teamKey} coming due, posted by slack22linear.`,
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
      else {
        this.#issueMetadata.save(rec.channelId, issue);
        this.#planTimer(issue);
      }
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
      else if (rec.channelId) this.#saveProjectAppearance(project, rec.channelId);
    }
    const open = new Set(projects.map((p) => p.id));
    for (const rec of this.#store.allProjects()) {
      if (rec.archived || open.has(rec.projectId)) continue;
      const project = await this.#linear.project(rec.projectId);
      if (project) await this.syncProject(project);
      else await this.#closeProject(rec);
    }
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

  /** The team's Linear statuses, name to ID, read once per drain. */
  async #stateIds(): Promise<Map<string, string>> {
    this.#states ??= new Map(
      (await this.#linear.states(this.#c.teamKey)).map((s) => [s.name, s.id]),
    );
    return this.#states;
  }

  async #stateId(name: string): Promise<string> {
    const id = (await this.#stateIds()).get(name);
    if (!id) throw new Error(`no Linear status named ${name}`);
    return id;
  }

  /** Workflow details that belong to a status. */
  #statusKeys(status: string): string[] {
    if (status === this.#c.dateState) return ["start"];
    if (status === this.#c.triggerState) return ["who", "event", "stop"];
    return [];
  }

  /**
   * Moves an issue to another status in Linear, clearing details for other statuses.
   * Hermes's 👀 move keeps the details so it can return to its previous status.
   */
  async #move(issue: LinearIssue, to: string, { keepKeys = false } = {}): Promise<void> {
    const meta = issueWorkflow(issue);
    const stale = keepKeys
      ? []
      : [this.#c.dateState, this.#c.triggerState]
          .filter((status) => status !== to)
          .flatMap((status) => this.#statusKeys(status))
          .filter((key) => key in meta);
    for (const key of stale) delete meta[key];
    await this.#linear.updateIssue(issue.id, {
      stateId: await this.#stateId(to),
      ...(stale.length ? { description: workflowDescription(issue, meta) } : {}),
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
      for (const c of page.channels as {
        id: string;
        name: string;
        is_archived: boolean;
      }[])
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
        // Leon never wants private channels.
        const created = await this.#bot("conversations.create", { name, is_private: false });
        id = (created.channel as { id: string }).id;
      } catch (error) {
        if (error instanceof SlackError && error.code === "name_taken") continue;
        throw error;
      }
      for (const user of [this.#c.leonUserId, ...this.#helpers()])
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

  /** Who joins every issue channel besides Leon and the sync's bot: Hermes, and Autolinear's bot. */
  #helpers(): string[] {
    return [this.#c.hermesUserId, ...(this.#c.autolinearUserId ? [this.#c.autolinearUserId] : [])];
  }

  /** Makes the bot, Hermes and Autolinear members of a channel Leon is in, invited by his session. */
  async #join(channelId: string): Promise<void> {
    if (!this.#session) {
      await tolerate(this.#bot("conversations.join", { channel: channelId }), [
        "already_in_channel",
        "method_not_supported_for_channel_type",
      ]);
      return;
    }
    for (const user of [await this.#botUser(), ...this.#helpers()])
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

  #mentions(issue: LinearIssue, quietLeon = false): string {
    const status = issue.state.name;
    const lines: string[] = [];
    if (this.#c.mentionLeonStates.includes(status) && !quietLeon)
      lines.push(`<@${this.#c.leonUserId}>`);
    if (this.#c.pingHermesStates.includes(status))
      lines.push(
        `<@${this.#c.hermesUserId}> ${issue.identifier} is now ${status}: ${
          status === AWAITING_HERMES ? "please continue this task." : "please pick it up."
        }`,
      );
    return lines.join(" ");
  }

  async #notifyStatus(channelId: string, from: string, issue: LinearIssue): Promise<void> {
    const to = issue.state.name;
    const command = this.#store.commandMove(issue.id);
    const move = command?.toState === to ? command : null;
    if (move?.by === "hermes") return;
    if (!move && to === this.#c.hermesAckState) {
      const ack = this.#store.ack(issue.id);
      if (ack?.at === null) {
        if (ack.messageTs && this.#autolinear)
          await tolerate(
            this.#autolinearCall("reactions.add", {
              channel: channelId,
              timestamp: ack.messageTs,
              name: STATUS_REACTIONS.get(to) ?? "gear",
            }),
            ["already_reacted", "message_not_found", ...ARCHIVED],
          );
        return;
      }
    }
    const mentions = this.#mentions(issue, move?.by === "leon");
    const status = `*${move?.fromState ?? from}* → *${to}*${move ? " (Leon told Autolinear)" : ""}`;
    await tolerate(
      this.#bot("chat.postMessage", {
        channel: channelId,
        text: `${status}${mentions ? `\n${mentions}` : ""}`,
        unfurl_links: false,
      }),
      ARCHIVED,
    );
  }

  /** `lead` replaces the description's excerpt; `quiet` mentions no one. */
  async #postIntro(
    channelId: string,
    issue: LinearIssue,
    { lead, quiet = false }: { lead?: string; quiet?: boolean } = {},
  ): Promise<void> {
    const { name } = parseTitle(issue.title);
    const safe = name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const description = linearToSlack(issueDescription(issue.description)).trim();
    const excerpt =
      lead ?? (description.length > 2500 ? `${description.slice(0, 2500)}…` : description);
    const mentions = quiet ? "" : this.#mentions(issue);
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
