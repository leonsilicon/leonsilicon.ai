import { CLIENT_MSG_ID_PREFIX } from "@-/com.leonsilicon.ai.services.slack-as-leon";
import type { SyncConfig } from "#config";
import {
  channelName,
  channelNumber,
  channelTopic,
  formatTitle,
  linearToSlack,
  metaInstant,
  parseTitle,
  projectChannelName,
  slackToLinear,
} from "#format";
import type { LinearApi, LinearIssue, LinearProject, ProjectChannelSettings } from "#linear";
import { Sidebar, SlackError, tolerate } from "#slack";
import type { SlackCall } from "#slack";
import type { IssueRecord, ProjectRecord, Store } from "#store";

export interface LinearWebhook {
  action: string;
  type: string;
  data: { id: string };
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
    } else if (kind === "tick") await this.tick();
    else if (kind === "backfill") await this.backfill();
    else this.#log("unknown_job", { kind });
  }

  // ── Linear → Slack ─────────────────────────────────────────────────────────

  async onLinearIssue(hook: LinearWebhook): Promise<void> {
    if (hook.action === "remove") {
      const rec = this.#store.issue(hook.data.id);
      if (rec && !rec.archived) {
        await this.#unplace(rec.channelId);
        await this.#archive(rec.channelId);
        this.#store.putIssue({ ...rec, archived: true, section: null });
      }
      return;
    }
    const issue = await this.#linear.issue(hook.data.id);
    if (issue && issue.teamKey === this.#c.teamKey) await this.syncIssue(issue, "live");
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
      await tolerate(
        this.#bot("chat.update", {
          channel: known.channelId,
          ts: known.slackTs,
          text: this.#text(comment.body),
        }),
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
    const posted = await this.#bot("chat.postMessage", {
      channel: rec.channelId,
      text: this.#text(comment.body),
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
   * Brings an issue's channel in line with the issue. `live` posts what changed (the intro for a
   * new channel, status moves, mentions); `quiet` only fixes state, for backfills. `post` shapes
   * the status post, when there is one.
   */
  async syncIssue(
    issue: LinearIssue,
    mode: "live" | "quiet",
    post: StatusPost = {},
  ): Promise<IssueRecord | null> {
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
    const section = this.#c.projectSection;
    if (rec.section !== section && (await this.#place(channelId, section))) rec.section = section;
    this.#store.putProject(rec);
    if (!same) this.#log("project_channel", { project: project.name, channel: channelId });
    return rec;
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
    if (this.#projectChannels === undefined)
      this.#projectChannels = await this.#linear.projectChannelSettings();
    const settings = this.#projectChannels;
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
      if (!edited || edited.bot_id || !edited.user) return;
      const known = this.#store.commentBySlack(event.channel, edited.ts);
      if (known?.origin === "slack")
        await this.#linear.updateComment(
          known.commentId,
          await this.#slackBody(edited.user, edited.text ?? "", edited.files),
        );
      return;
    }
    if (event.bot_id || !event.user) return;
    if (event.subtype && event.subtype !== "file_share" && event.subtype !== "thread_broadcast")
      return;
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
    const rec = event.item.channel ? this.#store.issueByChannel(event.item.channel) : null;
    if (!rec || rec.archived) return;
    const issue = await this.#linear.issue(rec.issueId);
    if (!issue || this.#c.closedStateTypes.includes(issue.state.type)) return;
    if (issue.state.name === hermesAckState) return;
    await this.#move(issue, hermesAckState);
    this.#log("hermes_ack", { issue: issue.identifier, from: issue.state.name });
    const moved = await this.#linear.issue(issue.id);
    if (moved)
      await this.syncIssue(moved, "live", {
        note: `(Hermes reacted :${hermesAckReaction}: to Leon's message)`,
        quietHermes: true,
      });
  }

  // ── Scheduled work ─────────────────────────────────────────────────────────

  /**
   * Moves issues whose `start` date arrived to their target status, sends expired listeners back to
   * Leon, and re-syncs anything a missed webhook left out of date.
   */
  async tick(): Promise<void> {
    const now = this.#now();
    const issues = await this.#linear.openIssues(this.#c.teamKey, this.#c.closedStateTypes);
    for (const issue of issues) {
      const { meta } = parseTitle(issue.title);
      if (issue.state.name === this.#c.dateState && meta.start) {
        const at = metaInstant(meta.start, this.#c.timeZone);
        if (at && at.getTime() <= now) {
          await this.#move(issue, this.#c.dateTarget);
          this.#log("start_date_reached", { issue: issue.identifier });
        }
      } else if (issue.state.name === this.#c.listenerState && meta.stop) {
        const at = metaInstant(meta.stop, this.#c.timeZone);
        if (at && at.getTime() <= now) {
          const { event, stop } = meta;
          await this.#move(issue, this.#c.listenerExpiredTarget);
          await this.#linear.createComment({
            id: await stableUuid(`listener-expired:${issue.id}:${stop}`),
            issueId: issue.id,
            body: `**Linear Sync:** the listener's stop date (${stop}) passed before it fired${event ? `; it was waiting for: ${event}` : ""}. Extend it or cancel the issue.`,
          });
          this.#log("listener_expired", { issue: issue.identifier });
        }
      }
    }
    // Reconcile: anything whose stored status or title drifted gets a live sync.
    const open = new Set(issues.map((i) => i.id));
    for (const issue of issues) {
      const rec = this.#store.issue(issue.id);
      if (!rec || rec.archived || rec.stateName !== issue.state.name || rec.title !== issue.title)
        await this.syncIssue(issue, "live");
    }
    for (const rec of this.#store.allIssues()) {
      if (rec.archived || open.has(rec.issueId)) continue;
      const issue = await this.#linear.issue(rec.issueId);
      if (!issue) {
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
        rec.section !== this.#c.projectSection
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
    if (this.#c.mentionLeonStates.includes(status)) lines.push(`<@${this.#c.leonUserId}>`);
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
