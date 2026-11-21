import {
  decisionsScreener,
  EMAIL_PROMPT,
  GmailClient,
  GmailFeed,
  loadConfig,
  slackBot,
  Store,
} from "@-/ai.leonsilicon.services.gmail-feed";
import type { Logger, Sql, SqlValue } from "@-/ai.leonsilicon.services.gmail-feed";
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

interface Env {
  FEED: DurableObjectNamespace;
  /** The Vite build of www/ (dist/www): this Worker's page is www/ai/leonsilicon/gmail-feed/index.html. */
  ASSETS: Assets;
  /** Bearer token for /admin/* (status, tick, backfill). */
  GMAIL_FEED_ADMIN_TOKEN?: string;
  [key: string]: unknown;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const log: Logger = (level, message, fields = {}) =>
  console[level === "info" ? "log" : level](JSON.stringify({ level, message, ...fields }));

const stub = (env: Env) => env.FEED.get(env.FEED.idFromName("feed"));

const authorized = (request: Request, env: Env) =>
  Boolean(env.GMAIL_FEED_ADMIN_TOKEN) &&
  request.headers.get("authorization") === `Bearer ${env.GMAIL_FEED_ADMIN_TOKEN}`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const page = await serveSite(request, env.ASSETS);
    if (page) return page;
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/healthz") {
      const status = (await (await stub(env).fetch(new Request("https://feed/status"))).json()) as {
        ok: boolean;
        pending: number;
        lastPollOkAgoMs: number | null;
      };
      // Public: freshness and a count, nothing about the mail itself.
      return json(
        { ok: status.ok, pending: status.pending, lastPollOkAgoMs: status.lastPollOkAgoMs },
        status.ok ? 200 : 503,
      );
    }

    if (url.pathname.startsWith("/admin/")) {
      if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
      const action = url.pathname.slice("/admin/".length);
      if (request.method === "GET" && action === "status")
        return stub(env).fetch(new Request("https://feed/status"));
      if (request.method === "POST" && (action === "tick" || action === "backfill"))
        return stub(env).fetch(
          new Request(`https://feed/${action}`, { method: "POST", body: await request.text() }),
        );
      return json({ error: "not found" }, 404);
    }

    return json({ error: "not found" }, 404);
  },

  // Every minute, a backstop: the Durable Object's alarm already re-arms itself each minute.
  async scheduled(_event: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(stub(env).fetch(new Request("https://feed/tick", { method: "POST" })));
  },
};

/**
 * The one place work happens. The alarm polls Gmail's history, posts the queue one message at a
 * time, and sets itself for a minute later. Alarms never overlap, so a slow run can't race the next.
 * A tick (the cron, or /admin/tick) only makes sure an alarm is set.
 */
export class FeedObject {
  readonly #state: DurableObjectState;
  readonly #env: Env;
  readonly #store: Store;
  #feed: GmailFeed | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.#state = state;
    this.#env = env;
    const sql: Sql = {
      exec: (query, ...params) => state.storage.sql.exec(query, ...params).toArray(),
    };
    this.#store = new Store(sql);
  }

  #make(): GmailFeed {
    if (this.#feed) return this.#feed;
    const config = loadConfig(this.#env as Record<string, string | undefined>);
    const screener = decisionsScreener({
      apiKey: config.openaiApiKey,
      model: config.screen.model,
      timeoutMs: config.screen.timeoutMs,
      thresholds: { unsafe: config.screen.unsafe, wake: config.screen.wake },
      prompt: EMAIL_PROMPT,
      log,
    });
    this.#feed = new GmailFeed({
      config: config.feed,
      store: this.#store,
      gmail: new GmailClient(config.google),
      slack: slackBot(config.slackBotToken),
      screener,
      log,
    });
    return this.#feed;
  }

  async #wakeAt(time: number): Promise<void> {
    const current = await this.#state.storage.getAlarm();
    if (current === null || current > time) await this.#state.storage.setAlarm(time);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/status") {
      try {
        return json(this.#make().status());
      } catch (error) {
        return json({ ok: false, error: String(error) });
      }
    }
    if (url.pathname === "/tick") {
      await this.#wakeAt(Date.now());
      return json({ ok: true });
    }
    if (url.pathname === "/backfill") {
      const body = (await request.json().catch(() => ({}))) as { since?: string };
      const since = Date.parse(body.since ?? "");
      if (!Number.isFinite(since)) return json({ error: 'give {"since": "<ISO time>"}' }, 400);
      const result = await this.#make().backfill(since);
      await this.#wakeAt(Date.now());
      return json(result);
    }
    return json({ error: "not found" }, 404);
  }

  async alarm(): Promise<void> {
    try {
      const feed = this.#make();
      try {
        await feed.poll();
      } catch {
        // Logged and recorded by poll; still post what's already queued.
      }
      const deadline = Date.now() + 10 * 60_000;
      while (Date.now() < deadline) {
        const { posted, skipped, failed } = await feed.process(25);
        if (posted + skipped + failed < 25) break;
      }
    } finally {
      // The alarm re-arms itself every minute (sooner for a retry that's due), so polling doesn't
      // depend on the cron, which only restarts the chain if it ever breaks.
      // Set directly: inside the handler, getAlarm() may still report the alarm that's firing.
      const next = this.#store.nextDue();
      const minute = Date.now() + 60_000;
      await this.#state.storage.setAlarm(
        next === null ? minute : Math.max(Date.now() + 1000, Math.min(next, minute)),
      );
    }
  }
}
