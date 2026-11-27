import type { IssueMetadata } from "#issue-metadata";
import { CLIENT_MSG_ID_PREFIX } from "@-/ai.leonsilicon.services.slack-as-leon";
import {
  AWAITING_HERMES,
  commandLine,
  commandUsage,
  matchStatus,
  parseCommand,
  untilDuration,
} from "#command";
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
import type { Routines } from "#routines";

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

interface SlackMessageContent {
  ts: string;
  text?: string;
  thread_ts?: string;
  blocks?: { block_id?: string }[];
}

export interface SlackMessageEvent extends SlackMessageContent {
  type: string;
  channel: string;
  user?: string;
  subtype?: string;
  bot_id?: string;
  client_msg_id?: string;
  files?: SlackFile[];
  /** The edited message, on `message_changed`. */
  message?: SlackMessageContent & {
    user?: string;
    bot_id?: string;
    files?: SlackFile[];
    edited?: { ts?: string };
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

/** A turn Hermes took up (👀) whose end is overdue (`Sync.onStuck`). */
interface Stuck {
  channel: string;
  /** The message Hermes took up. */
  ts: string;
}

/** Leon's message in an issue channel that Hermes hasn't taken up (👀) yet (`Sync.onUnseen`). */
interface Unseen {
  channel: string;
  ts: string;
  text: string;
}

/** The channels where Hermes's gateway is running a turn now (`Sync.onTurns`). */
export interface Turns {
  channels: string[];
}

/**
 * Muse answered a handoff that no running Hermes turn will read (`Sync.onMuseAnswer`), from the
 * hermes22muse relay through autolinear's Worker.
 */
export interface MuseAnswer {
  channel: string;
  /** The handoff's Slack thread. */
  thread: string;
  handoff: string;
  sideChat: string;
}

const SLACK_CHANNEL = /^[CG][A-Z0-9]{1,30}$/;
const SLACK_TS = /^[0-9]{10}\.[0-9]{6}$/;

/** The gateway's report of its running turns, or null when it isn't one. */
export function readTurns(input: unknown): Turns | null {
  const channels = (input as { channels?: unknown } | null)?.channels;
  if (!Array.isArray(channels) || channels.length > 200) return null;
  return {
    channels: channels.filter((c): c is string => typeof c === "string" && SLACK_CHANNEL.test(c)),
  };
}

/** The relay's report of an unread Muse answer, or null when it isn't one. */
export function readMuseAnswer(input: unknown): MuseAnswer | null {
  const { channel, thread, handoff, sideChat } = (input ?? {}) as Record<string, unknown>;
  if (typeof channel !== "string" || !SLACK_CHANNEL.test(channel)) return null;
  if (typeof thread !== "string" || !SLACK_TS.test(thread)) return null;
  if (typeof handoff !== "string" || !/^[0-9a-f-]{36}$/.test(handoff)) return null;
  if (typeof sideChat !== "string" || sideChat !== `https://muse.ai/thread/${handoff}`) return null;
  return { channel, thread, handoff, sideChat };
}

/** A command for Autolinear (`Sync.onCommand`): from Hermes's message, or Leon's `/autolinear`. */
export interface CommandJob {
  channel: string;
  /** Hermes's message ts, progress card ts plus edit ts, or Leon's `slash-<trigger id>`. */
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

interface LeaseJob {
  id: string;
  /** The Slack message that started or explicitly set this lease. */
  messageTs?: string | null;
  /** Saved before the Linear write so retries can finish the same expiration. */
  ending?: { at: number; to: string };
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
  /** Keeps Routine projects in step with Muse's routines (`routines` jobs). Without it they're logged. */
  routines?: Pick<Routines, "run"> | null;
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

/**
 * How long a turn Hermes took up (👀) may go without ending (✅ or ❌) once its gateway stops
 * reporting a turn running in the channel (`Sync.onTurns`, about every minute). Then Autolinear
 * reminds Hermes: a gateway restart drops the turns it was running (LEON-509, 2026-11-25).
 */
export const STUCK_MS = 5 * 60_000;

/**
 * How recent the gateway's last report of its running turns must be for a turn missing from it to
 * count as cut off. The relay reports every minute, with no channels when no turn is running. A
 * gateway that reports nothing has lost track of its turns, as after the live plugin reload of
 * 2026-11-26 (LEON-533 got a reminder 3 seconds before its 5-minute turn ended), so a quiet report
 * proves nothing; Executing's lease still catches a turn that really stopped.
 */
export const REPORTS_MS = 3 * 60_000;

/**
 * How long Leon's message at the top of an issue channel may go without Hermes's 👀 before
 * Autolinear hands it to Hermes. A message sent while the gateway is down never reaches it, and
 * Slack doesn't send it again once the gateway is back (LEON-494's "mark as done" at 12:02 ET,
 * 2026-11-26, during a 20-minute outage). While the gateway reports nothing, Autolinear waits on.
 */
export const UNSEEN_MS = 3 * 60_000;
/** How long Autolinear waits for a gateway that reports nothing before it stops asking about a message. */
export const UNSEEN_GIVE_UP_MS = 6 * 3600_000;

/**
 * What Hermes's gateway posts instead of running a turn on a message: the conversation is paused,
 * the message is saved to run later, or it was turned away (`gateway/session_ingress.py`,
 * `gateway/run_busy.py`). Each opens with an emoji that Slack may spell as a `:shortcode:`. Hermes
 * still swaps its 👀 for ✅, but no turn ended, so it owes Autolinear nothing (LEON-494, 2026-11-26:
 * the pause notice got a reminder, and the reminder's thread answered `stay` for "mark as done").
 */
const NO_TURN_NOTICE =
  /^\s*(?::[a-z0-9_+-]+:|\p{Extended_Pictographic}️?)\s*(?:This conversation is paused|Hermes is restarting|Your message is saved|Too many messages are already waiting|Hermes already received a different message|Hermes refused this message|Hermes did not answer this message|Gateway is \S+ and is not accepting new work|This agent is draining|Another turn is still running|Turn setup stalled)/u;

/**
 * Executing is a lease (Leon's rule, 2026-11-25: nothing may sit in Executing with no one working on
 * it; LEON-479–498 did, for up to 30 hours). Every issue in Executing has an end time, and when it
 * comes the issue moves to `leaseEndedTarget` (`Sync.onLeaseEnded`). Signs of work push the end to
 * at least `LEASE_MS` from now: Hermes's gateway reporting a turn running in the channel
 * (`Sync.onTurns`, about every minute), Hermes's 👀, and any post or edit there other than
 * Autolinear's and this sync's own, such as Hermes's Task progress or an agent's report. An issue
 * that enters Executing any other way gets `LEASE_MS` too.
 */
export const LEASE_MS = 15 * 60_000;
/** How long `move executing` holds an issue without `--until`. */
export const EXECUTING_MS = 60 * 60_000;
/** The furthest `--until` may be. A longer wait is Awaiting Date or Awaiting Trigger. */
export const MAX_LEASE_MS = 24 * 3600_000;

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
/** When an issue in Executing goes to `leaseEndedTarget`, unless something works on it first. */
const leaseKey = (issueId: string) => `lease:${issueId}`;
const leaseCommentKey = (commentId: string) => `lease-comment:${commentId}`;
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
/** The timer of a turn Hermes took up (👀) and hasn't ended (`Sync.onStuck`). */
const stuckKey = (channel: string, ts = "") => `stuck:${channel}:${ts}`;
/** The timer of Leon's message that Hermes hasn't taken up (`Sync.onUnseen`). */
const unseenKey = (channel: string, ts: string) => `unseen:${channel}:${ts}`;
/** Recorded when Hermes answers a message with a notice instead of a turn (`NO_TURN_NOTICE`). */
const noticeKey = (channel: string, ts = "") => `notice:${channel}:${ts}`;
/** When the gateway last reported its running turns (`Sync.onTurns`). */
const TURNS_REPORTED = "turns-reported";
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
  readonly #routines: Pick<Routines, "run"> | null;
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
    this.#routines = deps.routines ?? null;
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
    else if (kind === "stuck") await this.onStuck(payload as Stuck);
    else if (kind === "unseen") await this.onUnseen(payload as Unseen);
    else if (kind === "lease") await this.onLeaseEnded((payload as { id: string }).id);
    else if (kind === "turns") this.onTurns(payload as Turns);
    else if (kind === "muse-answer") await this.onMuseAnswer(payload as MuseAnswer);
    else if (kind === "resume-hermes") return; // Discard continuation jobs queued before deployment.
    else if (kind === "routines") {
      // Muse's schedules, from the hermes22muse relay through autolinear's Worker.
      if (!this.#routines) return this.#log("routines_unconfigured");
      const report = await this.#routines.run(payload);
      if (report.skipped || report.created.length || report.linked.length || report.raised.length)
        this.#log("routines", { ...report });
    } else if (kind === "tick") {
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
      this.#store.setTimer(leaseKey(hook.data.id), "lease", null, null, this.#now());
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
    if (this.#store.fired(leaseCommentKey(id))) return; // Recorded in Linear alongside a Slack reaction.
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
    this.#planLease(issue);
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
    await this.#noteWork(event);
    if (event.subtype === "message_changed") {
      const edited = event.message;
      // Hermes can stream a reply by editing it, so its command can first show up in an edit.
      if (edited?.user === this.#c.hermesUserId)
        return this.#onHermesMessage(event.channel, edited, edited.edited?.ts ?? event.ts);
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
    if (event.user === this.#c.hermesUserId) return this.#onHermesMessage(event.channel, event);
    if (event.bot_id) return;
    // Hermes posting as Leon through slack-as-leon, to wake other bots; not Leon's own words.
    if (event.client_msg_id?.startsWith(CLIENT_MSG_ID_PREFIX)) return;
    if (event.client_msg_id?.startsWith(RETIRED_RESUME_MSG_ID_PREFIX)) return;
    const rec = this.#store.issueByChannel(event.channel);
    if (!rec || rec.archived) return;
    if (this.#store.commentBySlack(event.channel, event.ts)) return;

    const reply = event.thread_ts && event.thread_ts !== event.ts ? event.thread_ts : null;
    if (!reply && event.user === this.#c.leonUserId && !/^\s*[/!]/.test(event.text ?? "")) {
      // Hermes answers each of Leon's messages here; its 👀 says the message reached it.
      const now = this.#now();
      const unseen: Unseen = { channel: event.channel, ts: event.ts, text: event.text ?? "" };
      this.#store.setTimer(
        unseenKey(event.channel, event.ts),
        "unseen",
        unseen,
        now + UNSEEN_MS,
        now,
      );
    }
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
   * - A turn that never ends, because its gateway stopped running it, gets a reminder (`onStuck`).
   * - Any of them says the message reached Hermes, so Autolinear won't hand it over (`onUnseen`).
   */
  async onSlackReaction(event: SlackReactionEvent): Promise<void> {
    const { hermesAckReaction, hermesAnsweredReaction, hermesFailedReaction } = this.#c;
    const ended =
      event.reaction === hermesAnsweredReaction || event.reaction === hermesFailedReaction;
    if (event.reaction !== hermesAckReaction && !ended) return;
    if (event.user !== this.#c.hermesUserId) return;
    const { channel, ts } = event.item;
    if (event.item.type !== "message" || !channel || !ts) return;
    const now = this.#now();
    // The message reached Hermes.
    this.#store.setTimer(unseenKey(channel, ts), "unseen", null, null, now);
    const rec = this.#store.issueByChannel(channel);
    if (!rec || rec.archived) return;
    // The turn now owes an end. Its gateway pushes the timer on while it runs (`onTurns`).
    this.#store.setTimer(
      stuckKey(channel, ts),
      "stuck",
      { channel, ts } satisfies Stuck,
      ended ? null : now + STUCK_MS,
      now,
    );
    if (!ended) {
      this.#workedIn(channel);
      if (event.item_user === this.#c.leonUserId) return this.onHermesAck(rec, ts);
      if (!event.item_user || !this.#c.pingHermesStates.includes(rec.stateName)) return;
      if (event.item_user !== (await this.#botUser())) return;
      const ping = await this.#reactionMessage(channel, ts);
      if (ping?.text && mentions(ping.text, this.#c.hermesUserId)) await this.onHermesAck(rec, ts);
      return;
    }
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
   * on a message Leon has written after is skipped: Hermes's turn on his newer message counts. So is
   * a "turn" in which the gateway only posted a notice (`NO_TURN_NOTICE`): no turn ran on it.
   */
  async onAnswered(answer: Answer): Promise<void> {
    const issue = await this.#openIssueIn(answer.channel);
    if (!issue) return;
    if (this.#store.spokeAfter(answer.channel, answer.ts)) return;
    if (this.#store.firedSince(saidKey(answer.channel), slackTsMs(answer.ts)).length) return;
    if (this.#store.firedSince(noticeKey(answer.channel), slackTsMs(answer.ts)).length)
      return this.#log("autolinear_no_turn", { issue: issue.identifier, ts: answer.ts });
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
   * Hermes's gateway reports the channels where it is running a turn, about every minute, and an
   * empty list when it runs none. Their turns aren't overdue yet, so their timers go off `STUCK_MS`
   * after this report instead.
   */
  onTurns(turns: Turns): void {
    const now = this.#now();
    this.#store.markLatest(TURNS_REPORTED, now);
    for (const channel of new Set(turns.channels)) {
      this.#store.postponeTimers(stuckKey(channel), now + STUCK_MS, now);
      this.#workedIn(channel);
    }
  }

  // ── Executing's lease ──────────────────────────────────────────────────────

  /** Gives an issue in Executing a lease when it has none; any other issue has none. */
  #planLease(issue: LinearIssue): void {
    const now = this.#now();
    const key = leaseKey(issue.id);
    const lease = this.#store.timerJob<LeaseJob>(key);
    if (issue.state.name !== this.#c.hermesAckState) {
      if (lease && !lease.payload.ending) this.#store.setTimer(key, "lease", null, null, now);
    } else if (!lease) {
      const ack = this.#store.ack(issue.id);
      this.#store.setTimer(
        key,
        "lease",
        { id: issue.id, messageTs: ack?.at === null ? ack.messageTs : null } satisfies LeaseJob,
        now + LEASE_MS,
        now,
      );
    }
  }

  /** Work can extend a lease. A command sets its exact end and source (`null` for a slash command). */
  #extendLease(issueId: string, at: number, commandTs?: string | null): void {
    const key = leaseKey(issueId);
    const current = this.#store.timerJob<LeaseJob>(key);
    if (commandTs === undefined && current && (current.payload.ending || current.at >= at)) return;
    const messageTs = commandTs === undefined ? current?.payload.messageTs : commandTs;
    const lease = { id: issueId, messageTs } satisfies LeaseJob;
    if (current?.at === at) this.#store.saveJobPayload(current.id, lease);
    else this.#store.setTimer(key, "lease", lease, at, this.#now());
  }

  /** A sign of work in an issue's channel: an issue in Executing keeps its lease `LEASE_MS` more. */
  #workedIn(channelId: string): void {
    const rec = this.#store.issueByChannel(channelId);
    if (rec && !rec.archived && rec.stateName === this.#c.hermesAckState)
      this.#extendLease(rec.issueId, this.#now() + LEASE_MS);
  }

  /** Any post or edit in an issue's channel is a sign of work, except Autolinear's and the sync's. */
  async #noteWork(event: SlackMessageEvent): Promise<void> {
    const { subtype } = event;
    if (
      subtype &&
      !["message_changed", "file_share", "thread_broadcast", "bot_message"].includes(subtype)
    )
      return;
    const rec = this.#store.issueByChannel(event.channel);
    if (!rec || rec.archived || rec.stateName !== this.#c.hermesAckState) return;
    const author = subtype === "message_changed" ? event.message : event;
    if (author?.user && author.user === this.#c.autolinearUserId) return;
    if (author?.bot_id && author.user === (await this.#botUser())) return;
    this.#workedIn(event.channel);
  }

  /**
   * An issue's lease ended while it was in Executing: no Hermes turn has run in its channel, no one
   * has posted there for `LEASE_MS`, and the time `move executing` gave has passed. Whatever was
   * working on it stopped (a dropped turn, a failed handoff, an agent whose report nobody acted
   * on), so it goes to `leaseEndedTarget`, with a reaction on the source message and a Linear
   * comment that says why. Workflow details stay, so the issue can go back to a wait it had.
   */
  async onLeaseEnded(issueId: string): Promise<void> {
    const now = this.#now();
    const job = this.#store.timerJob<LeaseJob>(leaseKey(issueId));
    if (!job || job.at > now) return;
    const issue = await this.#linear.issue(issueId);
    if (!issue) return;
    const from = this.#c.hermesAckState;
    const { ending } = job.payload;
    if (issue.state.name !== from && issue.state.name !== ending?.to) return;
    const { to, at } = ending ?? { to: this.#c.leaseEndedTarget, at: now };
    const { messageTs = this.#store.ack(issue.id)?.messageTs ?? null } = job.payload;
    if (!ending) this.#store.saveJobPayload(job.id, { id: issueId, messageTs, ending: { at, to } });
    if (issue.state.name === from) await this.#move(issue, to, { keepKeys: true });

    const moved = issue.state.name === to ? issue : await this.#linear.issue(issue.id);
    if (!moved || moved.state.name !== to) return;
    const rec = this.#store.issue(issue.id);
    const id = await stableUuid(`lease-ended:${issue.id}:${at}`);
    if (messageTs && rec && this.#autolinear) {
      await this.#reactStatus(rec.channelId, messageTs, to);
      this.#store.markFired(leaseCommentKey(id), now);
    }
    await this.syncIssue(moved, "live");
    this.#store.dropAck(issue.id);
    try {
      await this.#linear.createComment({
        id,
        issueId: issue.id,
        body: `**slack22linear:** nothing is working on this any more, so it left *${from}*: no Hermes turn is running in its channel, no one has posted there for ${LEASE_MS / 60_000} minutes, and any time given with \`move executing --until\` has passed. Reply in the channel to pick it back up.`,
      });
    } catch (error) {
      if (!/already exists|duplicate|unique/i.test(String(error))) throw error;
    }
    this.#log("lease_ended", { issue: issue.identifier, to });
  }

  /**
   * A turn Hermes took up (👀) never ended (✅ or ❌), and its gateway hasn't reported it running for
   * `STUCK_MS`: the gateway most likely restarted under it, which drops the turn (LEON-509,
   * 2026-11-25). Autolinear reminds Hermes, so the issue isn't left in Executing with no one on it.
   * Skipped once Leon has written again (Hermes's turn on his newer message counts), a command came
   * after the message, or the issue left Executing; and when the gateway hasn't reported its turns
   * for `REPORTS_MS`, because then a missing report says nothing about the turn (the lease decides).
   */
  async onStuck(stuck: Stuck): Promise<void> {
    const issue = await this.#openIssueIn(stuck.channel);
    if (!issue || issue.state.name !== this.#c.hermesAckState) return;
    if (this.#store.spokeAfter(stuck.channel, stuck.ts)) return;
    if (this.#store.firedSince(saidKey(stuck.channel), slackTsMs(stuck.ts)).length) return;
    if (!this.#store.firedSince(TURNS_REPORTED, this.#now() - REPORTS_MS).length)
      return this.#log("autolinear_stuck_unreported", { issue: issue.identifier, ts: stuck.ts });
    const message = `<https://app.slack.com/archives/${stuck.channel}/p${stuck.ts.replace(".", "")}|this message>`;
    await this.#askHermes(
      issue,
      stuck.channel,
      `Your turn on ${message} never ended: no :${this.#c.hermesAnsweredReaction}: or :${this.#c.hermesFailedReaction}:, and your gateway hasn't been running a turn here for ${STUCK_MS / 60_000} minutes, so it was most likely cut off. Pick the task up from where it stopped: check what the agents in this channel's threads came back with, give Leon the outcome, then tell me what to do with ${issue.identifier}, which is *${issue.state.name}*. Answer with a line of its own that starts with my mention:\n${commandUsage("@Autolinear")}`,
    );
    this.#log("autolinear_stuck", { issue: issue.identifier, ts: stuck.ts });
  }

  /**
   * Leon's message at the top of an issue channel never got Hermes's 👀 (nor ✅ or ❌) within
   * `UNSEEN_MS`: it reached the channel while the gateway was down, and Slack doesn't send it again
   * once the gateway is back. Autolinear hands it to Hermes with a quote, at the top of the channel,
   * so the channel's conversation takes it up. While the gateway reports nothing (`REPORTS_MS`), it is
   * most likely still down, so Autolinear waits on, for up to `UNSEEN_GIVE_UP_MS`. A newer message of
   * his that is waiting too is handed over instead, with a word about the ones before it.
   */
  async onUnseen(unseen: Unseen): Promise<void> {
    const { channel, ts } = unseen;
    const issue = await this.#openIssueIn(channel);
    if (!issue) return;
    const latest = this.#store.lastSpoke(channel);
    if (latest && latest > ts && this.#store.timer(unseenKey(channel, latest)) !== null) return;
    const now = this.#now();
    const waited = now - slackTsMs(ts);
    if (!this.#store.firedSince(TURNS_REPORTED, now - REPORTS_MS).length) {
      if (waited >= UNSEEN_GIVE_UP_MS)
        return this.#log("autolinear_unseen_gave_up", { issue: issue.identifier, ts });
      this.#store.setTimer(unseenKey(channel, ts), "unseen", unseen, now + UNSEEN_MS, now);
      return this.#log("autolinear_unseen_unreported", { issue: issue.identifier, ts });
    }
    const message = `<https://app.slack.com/archives/${channel}/p${ts.replace(".", "")}|this message>`;
    await this.#askHermes(
      issue,
      channel,
      `Leon wrote ${message} here ${Math.max(1, Math.round(waited / 60_000))} minutes ago, and it never reached you: your gateway was most likely down, and Slack doesn't send a message again once it's back.\n${excerptQuote(unseen.text, 600)}\nAnswer it, and anything else he wrote here that you haven't answered, then tell me what to do with ${issue.identifier}, which is *${issue.state.name}*. Answer with a line of its own that starts with my mention:\n${commandUsage("@Autolinear")}`,
    );
    this.#log("autolinear_unseen", { issue: issue.identifier, ts });
  }

  /**
   * Muse answered a handoff after the Hermes turn that sent it had ended (it didn't wait, or the
   * gateway restarted under it), so no turn will read the answer. Autolinear asks Hermes in the
   * handoff's thread, with the same budget as its other reminders.
   */
  async onMuseAnswer(answer: MuseAnswer): Promise<void> {
    const issue = await this.#openIssueIn(answer.channel);
    if (!issue) return this.#log("muse_answer_outside_issue", { channel: answer.channel });
    await this.#askHermes(
      issue,
      answer.channel,
      `Muse answered handoff \`${answer.handoff}\` (${answer.sideChat}), but none of your turns has read the answer: the turn that sent it ended or was cut off. Read it with \`muse_wait\` (handoff \`${answer.handoff}\`), check it against Leon's request, give Leon the outcome, then tell me what to do with ${issue.identifier}, which is *${issue.state.name}*. Answer with a line of its own that starts with my mention:\n${commandUsage("@Autolinear")}`,
      answer.thread,
    );
    this.#log("autolinear_muse_answer", { issue: issue.identifier, handoff: answer.handoff });
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
    message: SlackMessageContent,
    editedAt?: string,
  ): Promise<void> {
    const rec = this.#store.issueByChannel(channelId);
    if (!rec || rec.archived) return;
    const { ts, thread_ts: threadTs, blocks } = message;
    if (!editedAt && NO_TURN_NOTICE.test(message.text ?? "")) {
      this.#store.markFired(noticeKey(channelId, ts), this.#now());
      return this.#log("hermes_no_turn_notice", { issue: rec.issueId, ts });
    }
    const blockId = blocks?.[0]?.block_id;
    if (blockId?.startsWith("hermes-task-progress-note/")) return;
    let text = message.text ?? "";
    let commandTs = ts;
    const card = blockId?.startsWith("hermes-task-progress/");
    const legacyCard = !card && /^\*Task progress\*(?:\s|$)/.test(text);
    if ((!threadTs || threadTs === ts) && (card || legacyCard)) {
      const revision = editedAt ?? ts;
      if (!/^[0-9]+\.[0-9]{6}$/.test(revision)) return;
      const heading = "\n\n*Update from Hermes*\n";
      const body = `\n\n${text}`;
      const start =
        legacyCard || blockId?.startsWith("hermes-task-progress/answer/")
          ? body.indexOf(heading)
          : -1;
      text = start === -1 ? "" : body.slice(start + heading.length);
      const digest = text ? await stableUuid(text) : "";
      if (!this.#store.progressAnswerChanged(channelId, ts, revision, digest)) return;
      commandTs = `${ts}:${revision}`;
    }
    if (commandLine(text, this.#c.autolinearUserId) === null) return;
    const now = this.#now();
    this.#store.markFired(saidKey(channelId, commandTs), now);
    if (this.#store.fired(doneKey(channelId, commandTs))) return;
    const job: CommandJob = {
      channel: channelId,
      ts: commandTs,
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
   * command gets its answer privately. Each message or distinct progress answer acts once.
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
    if (command.verb === "stay") return this.#stay(issue, job, lead);
    return this.#commandMove(issue, command, job);
  }

  /**
   * `stay` keeps the status. In Executing, which Hermes's 👀 moved the issue to, it means the
   * status from before the 👀 (Leon's rule, 2026-11-25: LEON-487, 488 and 494 sat in Executing
   * after a `stay`). With no wait to go back to, Hermes has to say who is next, or which agent is
   * still working (`move executing --until`). Leon's `/autolinear stay` keeps the status as it is.
   */
  async #stay(issue: LinearIssue, job: CommandJob, lead: string): Promise<Outcome> {
    const status = issue.state.name;
    if (job.by === "leon" || status !== this.#c.hermesAckState)
      return { ok: true, text: `${issue.identifier} stays *${status}*.` };
    const before = this.#store.ack(issue.id)?.fromState;
    const waits =
      before &&
      ![status, this.#c.intakeState, this.#c.hermesState, ...this.#c.pingHermesStates].includes(
        before,
      );
    if (waits) return this.#commandMove(issue, { verb: "move", status: before, keys: {} }, job);
    return {
      ok: false,
      text: `I couldn't do that: ${issue.identifier} is *${status}*${before ? ` (it was *${before}* before your :${this.#c.hermesAckReaction}:)` : ""}, and an issue only stays *${status}* while something works on it. If an agent is still on it, say \`move executing --until <when it should be done>\`; otherwise say who is next.\n${commandUsage(lead)}`,
    };
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
    const { until, ...keys } = command.keys;
    let leaseEnd: number | null = null;
    if (to === this.#c.hermesAckState) {
      const now = this.#now();
      leaseEnd = until
        ? (untilDuration(until, now) ?? metaInstant(until, this.#c.timeZone)?.getTime() ?? null)
        : now + EXECUTING_MS;
      if (leaseEnd === null)
        return fail(`\`--until ${until}\` needs a duration (\`45m\`, \`2h\`) or an RFC 3339 time`);
      if (leaseEnd <= now) return fail(`\`--until ${until}\` has already passed`);
      if (leaseEnd - now > MAX_LEASE_MS)
        return fail(
          `\`--until\` can be at most ${MAX_LEASE_MS / 3600_000} hours away; for a longer wait, use \`move date\` or \`move trigger\``,
        );
    } else if (until) return fail(`\`--until\` goes with *${this.#c.hermesAckState}* only`);
    const previous = issueWorkflow(issue);
    const meta = { ...previous };
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
    const hold = () => {
      if (leaseEnd === null) return;
      const ts = job.by === "hermes" ? job.ts.split(":", 1)[0]! : null;
      this.#extendLease(issue.id, leaseEnd, ts);
    };
    const held =
      leaseEnd === null
        ? ""
        : ` If nothing happens in its channel by ${localLabel(leaseEnd, this.#c.timeZone, true)}, it goes to *${this.#c.leaseEndedTarget}*.`;
    if (!Object.keys(update).length) {
      hold();
      return { ok: true, text: `${issue.identifier} is already *${to}*.${held}` };
    }
    if (update.stateId !== undefined) {
      this.#store.putCommandMove({
        issueId: issue.id,
        ts: job.ts,
        by: job.by,
        fromState: issue.state.name,
        toState: to,
      });
      // Save the lease before entering Executing so a retry or webhook sees its exact deadline.
      hold();
    }
    await this.#linear.updateIssue(issue.id, update);
    if (update.stateId === undefined) hold();
    const moved = await this.#linear.issue(issue.id);
    const by = job.by === "leon" ? "Leon" : "Hermes";
    if (moved) await this.syncIssue(moved, "live");
    this.#log("autolinear_command", { issue: issue.identifier, from: issue.state.name, to, by });
    return { ok: true, text: `${issue.identifier} is now *${to}*.${held}` };
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
   * whose channel Leon wrote in, adds a reply's thread to the description, then sets the topic
   * and section like any sync.
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
      const root =
        a.sourceThreadTs && a.sourceThreadTs !== a.sourceTs
          ? await this.#threadRoot(a.sourceChannel, a.sourceThreadTs)
          : null;
      if (root?.text)
        update.description = `${issue.description ?? ""}\n\n${await this.#inReplyTo(a.sourceChannel, root)}`;
      if (Object.keys(update).length) await this.#linear.updateIssue(issue.id, update);
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
        this.#planLease(issue);
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

  async #reactStatus(channelId: string, ts: string, status: string): Promise<void> {
    await tolerate(
      this.#autolinearCall("reactions.add", {
        channel: channelId,
        timestamp: ts,
        name:
          STATUS_REACTIONS.get(status) ??
          (status === this.#c.hermesAckState ? "gear" : "white_check_mark"),
      }),
      ["already_reacted", "message_not_found", ...ARCHIVED],
    );
  }

  async #notifyStatus(channelId: string, from: string, issue: LinearIssue): Promise<void> {
    const to = issue.state.name;
    if (this.#autolinear && from === this.#c.hermesAckState) {
      const lease = this.#store.timerJob<LeaseJob>(leaseKey(issue.id))?.payload;
      if (lease?.ending?.to === to && lease.messageTs) return;
    }
    const command = this.#store.commandMove(issue.id);
    const move = command?.toState === to ? command : null;
    if (move?.by === "hermes") return;
    if (!move && to === this.#c.hermesAckState) {
      const ack = this.#store.ack(issue.id);
      if (ack?.at === null) {
        if (ack.messageTs && this.#autolinear)
          await this.#reactStatus(channelId, ack.messageTs, to);
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

  async #postIntro(channelId: string, issue: LinearIssue): Promise<void> {
    const { name } = parseTitle(issue.title);
    const safe = name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const description = linearToSlack(issueDescription(issue.description)).trim();
    const excerpt = description.length > 2500 ? `${description.slice(0, 2500)}…` : description;
    const text = [
      `*<${issue.url}|${issue.identifier}: ${safe}>* · ${issue.state.name}`,
      excerpt,
      this.#mentions(issue),
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
