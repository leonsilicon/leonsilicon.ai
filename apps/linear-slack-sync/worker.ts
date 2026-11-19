import {
  botClient,
  LinearClient,
  loadConfig,
  mentions,
  Store,
  Sync,
  verifyLinear,
  verifySlack,
} from "@-/com.leonsilicon.ai.services.linear-slack-sync";
import type {
  SlackCall,
  Sql,
  SqlValue,
  SyncConfig,
} from "@-/com.leonsilicon.ai.services.linear-slack-sync";
import { sessionClient } from "@-/com.leonsilicon.ai.services.slack-as-leon";
import { serveSite, type Assets } from "@-/com.leonsilicon.www";

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

interface Env {
  SYNC: DurableObjectNamespace;
  /** The Vite build of www/ (dist/www): this Worker's page is www/ai/leonsilicon/linear-slack/index.html. */
  ASSETS: Assets;
  /** Personal API key of the Linear account the sync acts as. */
  LINEAR_API_KEY: string;
  /** Signing secret of the Linear webhook. */
  LINEAR_WEBHOOK_SECRET: string;
  /** Bot token and signing secret of the Linear Sync Slack app. */
  LINEAR_SYNC_SLACK_BOT_TOKEN: string;
  LINEAR_SYNC_SLACK_SIGNING_SECRET?: string;
  /** Leon's Slack web session, for his sidebar sections. Optional: without it, sections are skipped. */
  SLACK_SESSION_TOKEN?: string;
  SLACK_SESSION_COOKIE?: string;
  /** Bearer token for /admin/* (backfill, tick, status). */
  LINEAR_SYNC_ADMIN_TOKEN: string;
  /** Hermes's reaction that moves an issue to Awaiting Hermes; `eyes` unless set. */
  HERMES_ACK_REACTION?: string;
  [key: string]: unknown;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, ...fields }));

const stub = (env: Env) => env.SYNC.get(env.SYNC.idFromName("sync"));

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
 * Slack events worth queueing: people's messages and edits in channels, Hermes's messages that
 * mention Leon, and 👀 reactions to messages (the sync checks who reacted to whom, and where).
 */
function wantedSlackEvent(event: Record<string, unknown> | undefined, config: SyncConfig): boolean {
  if (event?.type === "reaction_added")
    return (
      event.reaction === config.hermesAckReaction &&
      (event.item as { type?: string } | undefined)?.type === "message"
    );
  if (!event || event.type !== "message") return false;
  if (event.channel_type !== "channel" && event.channel_type !== "group") return false;
  if (event.subtype === "message_changed") return true;
  if (event.subtype && event.subtype !== "file_share" && event.subtype !== "thread_broadcast")
    return false;
  if (event.user === config.hermesUserId)
    return typeof event.text === "string" && mentions(event.text, config.leonUserId);
  return !event.bot_id;
}

const authorized = (request: Request, env: Env) =>
  Boolean(env.LINEAR_SYNC_ADMIN_TOKEN) &&
  request.headers.get("authorization") === `Bearer ${env.LINEAR_SYNC_ADMIN_TOKEN}`;

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
      if (payload.type === "event_callback" && wantedSlackEvent(payload.event, config))
        await enqueue(env, `slack:${payload.event_id}`, "slack", payload.event);
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
  #draining = false;

  constructor(state: DurableObjectState, env: Env) {
    this.#state = state;
    this.#env = env;
    const sql: Sql = {
      exec: (query, ...params) => state.storage.sql.exec(query, ...params).toArray(),
    };
    this.#store = new Store(sql);
  }

  #session(): SlackCall | null {
    const { SLACK_SESSION_TOKEN: token, SLACK_SESSION_COOKIE: cookie } = this.#env;
    return token && cookie ? sessionClient({ token, cookie }) : null;
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
      const { queued, dead } = this.#store.stats();
      return json({
        ok: checks.bot === "ok" && checks.session === "ok" && checks.projects === "ok",
        ...checks,
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
      const sync = new Sync({
        config: loadConfig(this.#env as Record<string, string | undefined>),
        store: this.#store,
        linear: new LinearClient(this.#env.LINEAR_API_KEY),
        bot: botClient(this.#env.LINEAR_SYNC_SLACK_BOT_TOKEN),
        session: this.#session(),
        log,
      });
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
