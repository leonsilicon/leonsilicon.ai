import {
  Autotrigger,
  feedEvent,
  feedMessage,
  type Delivery,
  type FeedMessage,
} from "@-/ai.leonsilicon.services.autotrigger";
import {
  botClient,
  commandLine,
  IssueMetadata,
  LinearClient,
  loadConfig,
  Routines,
  Store,
  Sync,
  verifyLinear,
  verifySlack,
} from "@-/ai.leonsilicon.services.slack22linear";
import type {
  Adoption,
  SlackCall,
  Sql,
  SqlValue,
  SyncConfig,
} from "@-/ai.leonsilicon.services.slack22linear";
import { sessionClient } from "@-/ai.leonsilicon.services.slack-as-leon";
import { serveSite, type Assets } from "@-/ai.leonsilicon.configs.cloudflare";

// Just the Durable Object surface used here. Cloudflare's full type packages redefine globals such
// as Response, which conflicts with the Node types this workspace compiles everything else against.
interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}
interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}
interface DurableObjectState {
  storage: {
    sql: {
      exec(query: string, ...bindings: SqlValue[]): { toArray(): Record<string, SqlValue>[] };
    };
    getAlarm(): Promise<number | null>;
    setAlarm(time: number): Promise<void>;
  };
}
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface TriggerStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  setAlarm(time: number): Promise<void>;
}
interface TriggerState {
  storage: TriggerStorage & {
    transaction<T>(run: (transaction: TriggerStorage) => Promise<T>): Promise<T>;
    deleteAll(): Promise<void>;
  };
}

interface Env {
  AUTOTRIGGER: DurableObjectNamespace;
  OPENAI_API_KEY?: string;
  FEED_FLAGGED_CHANNEL?: string;
  FEED_SPAM_CHANNEL?: string;
  SYNC: DurableObjectNamespace;
  /** The Vite build of www/ (dist/www): this Worker's page is www/ai/leonsilicon/linear-slack/index.html. */
  ASSETS: Assets;
  /** Personal API key of the Linear account the sync acts as. */
  LINEAR_API_KEY: string;
  /** Signing secret of the Linear webhook. */
  LINEAR_WEBHOOK_SECRET: string;
  /** Bot token and signing secret of the slack22linear Slack app. */
  LINEAR_SYNC_SLACK_BOT_TOKEN: string;
  LINEAR_SYNC_SLACK_SIGNING_SECRET?: string;
  /** Bot token of the Autolinear Slack app, which asks Hermes for commands. Optional. */
  AUTOLINEAR_SLACK_BOT_TOKEN?: string;
  /** Leon's Slack web session, for his sidebar sections. Optional: without it, sections are skipped. */
  SLACK_SESSION_TOKEN?: string;
  SLACK_SESSION_COOKIE?: string;
  /** Bearer token for /admin/* (backfill, tick, status). */
  LINEAR_SYNC_ADMIN_TOKEN: string;
  LINEAR_ISSUE_METADATA_TOKEN?: string;
  [key: string]: unknown;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, ...fields }));

const stub = (env: Env) => env.SYNC.get(env.SYNC.idFromName("sync"));
async function enqueueTrigger(env: Env, event: Record<string, unknown>): Promise<void> {
  const response = await stub(env).fetch(
    new Request("https://sync/autotrigger", { method: "POST", body: JSON.stringify(event) }),
  );
  if (!response.ok) throw new Error(`Autotrigger enqueue failed: ${response.status}`);
}

const slackArchiveEvents = new Set([
  "channel_archive",
  "channel_unarchive",
  "group_archive",
  "group_unarchive",
]);

async function enqueue(env: Env, id: string, kind: string, payload: unknown): Promise<void> {
  const response = await stub(env).fetch(
    new Request("https://sync/enqueue", {
      method: "POST",
      body: JSON.stringify({ id, kind, payload }),
    }),
  );
  if (!response.ok) throw new Error(`enqueue failed: ${response.status}`);
}

/**
 * Slack events worth queueing: people's messages and edits in channels, Hermes's messages and edits
 * with a command for Autolinear, and Hermes's 👀, ✅ and ❌ on messages (the sync checks where).
 */
function wantedSlackEvent(event: Record<string, unknown> | undefined, config: SyncConfig): boolean {
  if (event?.type === "reaction_added")
    return (
      event.user === config.hermesUserId &&
      (event.item as { type?: string } | undefined)?.type === "message" &&
      (event.reaction === config.hermesAckReaction ||
        event.reaction === config.hermesAnsweredReaction ||
        event.reaction === config.hermesFailedReaction)
    );
  if (!event || event.type !== "message") return false;
  if (event.channel_type !== "channel" && event.channel_type !== "group") return false;
  const hermesCommand = (message: Record<string, unknown> | undefined) =>
    typeof message?.text === "string" &&
    commandLine(message.text, config.autolinearUserId) !== null;
  if (event.subtype === "message_changed") {
    // People's edits, and Hermes's edits with a command (it can stream a reply by editing it).
    const edited = event.message as Record<string, unknown> | undefined;
    if (edited?.user === config.hermesUserId) return hermesCommand(edited);
    return !edited?.bot_id;
  }
  if (event.subtype && event.subtype !== "file_share" && event.subtype !== "thread_broadcast")
    return false;
  if (event.user === config.hermesUserId) return hermesCommand(event);
  return !event.bot_id;
}

const authorized = (request: Request, env: Env) =>
  Boolean(env.LINEAR_SYNC_ADMIN_TOKEN) &&
  request.headers.get("authorization") === `Bearer ${env.LINEAR_SYNC_ADMIN_TOKEN}`;

function metadataAuthorized(request: Request, token?: string): boolean {
  if (!token) return false;
  const encoder = new TextEncoder();
  const expected = encoder.encode(`Bearer ${token}`);
  const actual = encoder.encode(request.headers.get("authorization") ?? "");
  // Workers' native constant-time comparison, an extension to Web Crypto.
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  };
  return actual.length === expected.length && subtle.timingSafeEqual(actual, expected);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const page = await serveSite(request, env.ASSETS);
    if (page) return page;
    const url = new URL(request.url);
    const now = Date.now();

    if (request.method === "GET" && url.pathname === "/healthz") {
      const status = await (await stub(env).fetch(new Request("https://sync/health"))).json();
      return json(status, (status as { ok: boolean }).ok ? 200 : 503);
    }

    if (request.method === "POST" && url.pathname === "/slack/events") {
      const body = await request.text();
      const payload = JSON.parse(body) as {
        type: string;
        challenge?: string;
        event_id?: string;
        is_ext_shared_channel?: boolean;
        event?: Record<string, unknown>;
      };
      // Before the signing secret is set, answer only Slack's URL check, so the app can be created.
      if (!env.LINEAR_SYNC_SLACK_SIGNING_SECRET) {
        return payload.type === "url_verification"
          ? json({ challenge: payload.challenge })
          : json({ error: "not configured" }, 503);
      }
      const ok = await verifySlack(
        env.LINEAR_SYNC_SLACK_SIGNING_SECRET,
        request.headers.get("x-slack-request-timestamp"),
        request.headers.get("x-slack-signature"),
        body,
        now,
      );
      if (!ok) return json({ error: "bad signature" }, 401);
      if (payload.type === "url_verification") return json({ challenge: payload.challenge });
      const config = loadConfig(env as Record<string, string | undefined>);
      if (payload.type === "event_callback" && payload.event) {
        const { type, subtype } = payload.event;
        const event = payload.event;
        const feed = !payload.is_ext_shared_channel && feedEvent(event);
        const sync = slackArchiveEvents.has(String(type === "message" ? subtype : type))
          ? enqueue(env, `slack:${payload.event_id}`, "project-visibility", {})
          : wantedSlackEvent(payload.event, config)
            ? enqueue(env, `slack:${payload.event_id}`, "slack", payload.event)
            : undefined;
        await Promise.all([
          sync,
          feed && env.OPENAI_API_KEY ? enqueueTrigger(env, event) : undefined,
        ]);
      }
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/linear/webhook") {
      const body = await request.text();
      if (
        !(await verifyLinear(
          env.LINEAR_WEBHOOK_SECRET,
          request.headers.get("linear-signature"),
          body,
          now,
        ))
      )
        return json({ error: "bad signature" }, 401);
      const payload = JSON.parse(body) as { type: string; action: string; data: { id: string } };
      if (payload.type === "Issue" || payload.type === "Comment" || payload.type === "Project") {
        const delivery =
          request.headers.get("linear-delivery") ??
          `${payload.type}:${payload.action}:${payload.data.id}:${now}`;
        await enqueue(env, `linear:${delivery}`, "linear", payload);
      }
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname.startsWith("/admin/")) {
      if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
      const kind = url.pathname.slice("/admin/".length);
      if (kind !== "backfill" && kind !== "tick") return json({ error: "unknown action" }, 404);
      await enqueue(env, `${kind}:${now}`, kind, {});
      return json({ queued: kind });
    }

    if (request.method === "GET" && url.pathname === "/matrix/issue-metadata") {
      if (!metadataAuthorized(request, env.LINEAR_ISSUE_METADATA_TOKEN))
        return json({ error: "unauthorized" }, 401);
      return stub(env).fetch(new Request("https://sync/issue-metadata"));
    }

    if (request.method === "GET" && url.pathname === "/admin/status") {
      if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
      return stub(env).fetch(new Request("https://sync/status"));
    }

    return json({ error: "not found" }, 404);
  },

  async scheduled(_event: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    const minute = new Date().toISOString().slice(0, 16);
    ctx.waitUntil(enqueue(env, `tick:${minute}`, "tick", {}));
  },
};

/**
 * The one place work happens: webhooks become rows in a SQLite queue, and an alarm drains it one
 * job at a time, retrying failures with backoff. Serial processing means two events for the same
 * issue can never both create a channel. Timers are delayed jobs in the same queue (an issue's next
 * start, stop or due time, the next midnight), so the alarm is always set for the earliest of them.
 */
export class SyncObject {
  readonly #state: DurableObjectState;
  readonly #env: Env;
  readonly #store: Store;
  readonly #issueMetadata: IssueMetadata;
  readonly #sql: Sql;
  #teamId?: string;
  #draining = false;
  readonly #feedChannels: Parameters<typeof feedMessage>[2] = new Map();
  /** The bot's Slack user ID, once `auth.test` has said it. */
  #botUserId: string | undefined;

  constructor(state: DurableObjectState, env: Env) {
    this.#state = state;
    this.#env = env;
    const sql: Sql = {
      exec: (query, ...params) => state.storage.sql.exec(query, ...params).toArray(),
    };
    this.#sql = sql;
    this.#store = new Store(sql);
    this.#issueMetadata = new IssueMetadata(sql);
  }

  #session(): SlackCall | null {
    const { SLACK_SESSION_TOKEN: token, SLACK_SESSION_COOKIE: cookie } = this.#env;
    return token && cookie ? sessionClient({ token, cookie }) : null;
  }

  #sync(): Sync {
    const config = loadConfig(this.#env as Record<string, string | undefined>);
    const linear = new LinearClient(this.#env.LINEAR_API_KEY);
    return new Sync({
      config,
      store: this.#store,
      issueMetadata: this.#issueMetadata,
      linear,
      routines: new Routines({ config, linear, sql: this.#sql, log }),
      bot: botClient(this.#env.LINEAR_SYNC_SLACK_BOT_TOKEN),
      session: this.#session(),
      log,
      botUserId: this.#botUserId,
      autolinear: this.#env.AUTOLINEAR_SLACK_BOT_TOKEN
        ? botClient(this.#env.AUTOLINEAR_SLACK_BOT_TOKEN)
        : null,
    });
  }

  async #schedule(): Promise<void> {
    const due = this.#store.nextDue();
    if (due === null) return;
    const current = await this.#state.storage.getAlarm();
    if (current === null || current > due)
      await this.#state.storage.setAlarm(Math.max(due, Date.now()));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/enqueue") {
      const job = (await request.json()) as { id: string; kind: string; payload: unknown };
      const queued = this.#store.enqueue(job.id, job.kind, job.payload, Date.now());
      if (queued) await this.#schedule();
      return json({ queued });
    }
    if (url.pathname === "/status") return json(this.#store.stats());
    // Internal only, through the binding from AutoLinear or the signed Slack events handler.
    if (request.method === "POST" && url.pathname === "/autotrigger") {
      if (!this.#env.OPENAI_API_KEY) return json({ queued: false });
      const event = feedEvent((await request.json()) as Record<string, unknown>);
      if (!event || this.#store.issueByChannel(event.channel)) return json({ queued: false });
      const reader = this.#session() ?? botClient(this.#env.LINEAR_SYNC_SLACK_BOT_TOKEN);
      const source = await feedMessage(event, reader, this.#feedChannels, [
        this.#env.FEED_FLAGGED_CHANNEL,
        this.#env.FEED_SPAM_CHANNEL,
      ]);
      if (!source) return json({ queued: false });
      const binding = this.#env.AUTOTRIGGER;
      return binding.get(binding.idFromName(`${source.channel}:${source.ts}`)).fetch(
        new Request("https://autotrigger/enqueue", {
          method: "POST",
          body: JSON.stringify(source),
        }),
      );
    }
    if (request.method === "POST" && url.pathname === "/autotrigger-channel") {
      const { issueId } = (await request.json()) as { issueId: string };
      const issue = this.#store.issue(issueId);
      return json({ channel: issue && !issue.archived ? issue.channelId : null });
    }
    if (url.pathname === "/issue-metadata") {
      if (!this.#teamId) {
        const { team_id } = await botClient(this.#env.LINEAR_SYNC_SLACK_BOT_TOKEN)("auth.test");
        if (typeof team_id !== "string" || !/^T[A-Z0-9]+$/.test(team_id))
          return json({ error: "Slack workspace unavailable" }, 503);
        this.#teamId = team_id;
      }
      const closedProjectChannelIds = this.#store.projectVisibility();
      const projectAppearances = this.#store.projectAppearances();
      const header = JSON.stringify({
        teamId: this.#teamId,
        closedProjectChannelIds,
        projectAppearances,
      }).slice(0, -1);
      const body = `${header},"records":${this.#issueMetadata.snapshot()}}`;
      return new Response(body, {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    // autolinear's hand-over of a channel it opened, through its binding to this Durable Object
    // (the Worker above never routes a request here). Answers once the bot and Hermes are in.
    if (url.pathname === "/adopt") {
      const adoption = (await request.json()) as Adoption;
      this.#botUserId ??= (await botClient(this.#env.LINEAR_SYNC_SLACK_BOT_TOKEN)("auth.test"))
        .user_id as string;
      await this.#sync().adopt(adoption);
      await this.#schedule();
      return json({ ok: true });
    }
    if (url.pathname === "/health") {
      const checks: Record<string, string> = {};
      try {
        await botClient(this.#env.LINEAR_SYNC_SLACK_BOT_TOKEN)("auth.test");
        checks.bot = "ok";
      } catch (error) {
        checks.bot = String(error);
      }
      const session = this.#session();
      if (!session) checks.session = "missing";
      else
        try {
          await session("auth.test");
          checks.session = "ok";
        } catch (error) {
          checks.session = String(error);
        }
      // Project channels come from Linear's own Slack app: without it, no project gets a channel.
      try {
        const settings = await new LinearClient(this.#env.LINEAR_API_KEY).projectChannelSettings();
        checks.projects = settings
          ? "ok"
          : "off: connect Linear's Slack app and turn on Project channels";
      } catch (error) {
        checks.projects = String(error);
      }
      // Autolinear's bot asks Hermes for its commands; its user ID must be the one Hermes mentions.
      const autolinearToken = this.#env.AUTOLINEAR_SLACK_BOT_TOKEN;
      if (!autolinearToken) checks.autolinear = "missing";
      else
        try {
          const me = (await botClient(autolinearToken)("auth.test")).user_id;
          const config = loadConfig(this.#env as Record<string, string | undefined>);
          checks.autolinear =
            me === config.autolinearUserId ? "ok" : "AUTOLINEAR_BOT_USER_ID isn't its bot user";
        } catch (error) {
          checks.autolinear = String(error);
        }
      checks.autotrigger = this.#env.OPENAI_API_KEY ? "configured" : "unconfigured";
      const { queued, dead } = this.#store.stats();
      return json({
        ok:
          checks.bot === "ok" &&
          checks.session === "ok" &&
          checks.projects === "ok" &&
          checks.autolinear === "ok",
        ...checks,
        issueMetadata: this.#env.LINEAR_ISSUE_METADATA_TOKEN ? "matrix" : "unconfigured",
        queued,
        dead: dead.length,
      });
    }
    return json({ error: "not found" }, 404);
  }

  async alarm(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      const sync = this.#sync();
      const deadline = Date.now() + 10 * 60_000;
      while (Date.now() < deadline) {
        const jobs = this.#store.dueJobs(Date.now(), 10);
        if (!jobs.length) break;
        for (const job of jobs) {
          try {
            await sync.run(job.kind, JSON.parse(job.payload));
            this.#store.finish(job.id);
          } catch (error) {
            log("job_failed", {
              id: job.id,
              kind: job.kind,
              attempt: job.attempts + 1,
              error: String(error),
            });
            this.#store.fail(job, String(error), Date.now());
          }
        }
      }
    } finally {
      this.#draining = false;
      await this.#schedule();
    }
  }
}

type TriggerJob = { source: FeedMessage; delivery?: Delivery } | "done";
const TRIGGER_KEEP_MS = 3 * 24 * 3600_000;

/** One alarm-backed delivery per source message, shared by both Slack subscriptions. */
export class AutotriggerObject {
  readonly #storage: TriggerState["storage"];
  readonly #env: Env;

  constructor(state: TriggerState, env: Env) {
    this.#storage = state.storage;
    this.#env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const source = (await request.json()) as FeedMessage;
    const queued = await this.#storage.transaction(async (txn) => {
      if (await txn.get<TriggerJob>("job")) return false;
      await txn.put("job", { source });
      await txn.setAlarm(Date.now());
      return true;
    });
    return json({ queued });
  }

  async alarm({ retryCount }: { retryCount: number }): Promise<void> {
    const job = await this.#storage.get<TriggerJob>("job");
    if (job === "done") return this.#storage.deleteAll();
    if (!job) return;
    try {
      await this.#run(job);
    } catch (error) {
      log("autotrigger_failed", {
        channel: job.source.channel,
        ts: job.source.ts,
        attempt: retryCount + 1,
        error: error instanceof Error ? error.name : "unknown",
        ...(error instanceof Error && "status" in error ? { status: error.status } : {}),
      });
      // Cloudflare retries a thrown alarm up to six times.
      if (retryCount < 6) throw new Error("Autotrigger delivery failed");
    }
    await this.#storage.transaction(async (txn) => {
      await txn.put("job", "done");
      await txn.setAlarm(Date.now() + TRIGGER_KEEP_MS);
    });
  }

  async #run(job: Exclude<TriggerJob, "done">): Promise<void> {
    const env = this.#env;
    if (!env.OPENAI_API_KEY) return;
    const config = loadConfig(env as Record<string, string | undefined>);
    const linear = new LinearClient(env.LINEAR_API_KEY);
    const trigger = new Autotrigger({
      apiKey: env.OPENAI_API_KEY,
      linear,
      // Leon's Watcher projects: each new case they're for becomes an issue in them.
      watchers: {
        status: config.watcherProjectStatus,
        hermesState: config.hermesState,
        closedStateTypes: config.closedStateTypes,
        linear,
      },
      channelFor: async (issueId) => {
        const response = await stub(env).fetch(
          new Request("https://sync/autotrigger-channel", {
            method: "POST",
            body: JSON.stringify({ issueId }),
          }),
        );
        if (!response.ok) throw new Error(`Issue channel lookup failed: ${response.status}`);
        const { channel } = (await response.json()) as { channel: string | null };
        return channel;
      },
      session:
        env.SLACK_SESSION_TOKEN && env.SLACK_SESSION_COOKIE
          ? sessionClient({ token: env.SLACK_SESSION_TOKEN, cookie: env.SLACK_SESSION_COOKIE })
          : null,
      bot: botClient(env.LINEAR_SYNC_SLACK_BOT_TOKEN),
      hermesUserId: config.hermesUserId,
      teamKey: config.teamKey,
      state: config.triggerState,
      timeZone: config.timeZone,
    });
    const delivery = job.delivery ?? (await trigger.select(job.source));
    if (!delivery) return;
    if (!job.delivery) {
      if (delivery.kind !== "spawn") delivery.startedAt = Date.now();
      await this.#storage.put("job", { source: job.source, delivery });
    }
    await trigger.deliver(job.source, delivery, Boolean(job.delivery));
  }
}
