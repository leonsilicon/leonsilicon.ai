import {
  authorizePubSub,
  decisionsScreener,
  EMAIL_PROMPT,
  GmailClient,
  GmailFeed,
  GmailPush,
  loadConfig,
  parseGmailNotification,
  slackBot,
  Store,
} from "@-/ai.leonsilicon.services.gmail2slack";
import type { Logger, Sql, SqlValue } from "@-/ai.leonsilicon.services.gmail2slack";
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
  /** The Vite build of www/ (dist/www): this Worker's page is www/ai/leonsilicon/gmail2slack/index.html. */
  ASSETS: Assets;
  /** Bearer token for /admin/* (status, tick, backfill). */
  GMAIL_FEED_ADMIN_TOKEN?: string;
  GMAIL_FEED_PUBSUB_TOPIC?: string;
  GMAIL_FEED_PUBSUB_SERVICE_ACCOUNT?: string;
  [key: string]: unknown;
}

const PUSH_PATH = "/webhooks/gmail";
const PUSH_AUDIENCE = `https://gmail2slack.leonsilicon.ai${PUSH_PATH}`;

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
        mode?: "push" | "polling";
        watchExpiresAt?: number | null;
      };
      // Public: freshness and a count, nothing about the mail itself.
      return json(
        {
          ok: status.ok,
          pending: status.pending,
          lastPollOkAgoMs: status.lastPollOkAgoMs,
          mode: status.mode,
          watchExpiresAt: status.watchExpiresAt,
        },
        status.ok ? 200 : 503,
      );
    }

    if (
      request.method === "POST" &&
      url.pathname === PUSH_PATH &&
      env.GMAIL_FEED_PUBSUB_TOPIC &&
      env.GMAIL_FEED_PUBSUB_SERVICE_ACCOUNT
    ) {
      if (
        !(await authorizePubSub(
          request.headers.get("authorization"),
          env.GMAIL_FEED_PUBSUB_SERVICE_ACCOUNT,
          PUSH_AUDIENCE,
        ))
      )
        return json({ error: "unauthorized" }, 401);
      const notification = parseGmailNotification(await request.json().catch(() => null));
      if (!notification) return json({ error: "invalid Gmail notification" }, 400);
      return stub(env).fetch(
        new Request("https://feed/push", {
          method: "POST",
          body: JSON.stringify(notification),
        }),
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

  // Recover a missing alarm. A healthy watch and queue schedule their own work.
  async scheduled(_event: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(stub(env).fetch(new Request("https://feed/ensure-alarm", { method: "POST" })));
  },
};

/**
 * Pushes record a mailbox history target before acknowledging. One alarm renews the watch,
 * catches up from the stored Gmail cursor, and processes Slack retries when due.
 */
export class FeedObject {
  readonly #state: DurableObjectState;
  readonly #env: Env;
  readonly #store: Store;
  readonly #push: GmailPush | null;
  #services: { feed: GmailFeed; gmail: GmailClient } | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.#state = state;
    this.#env = env;
    const sql: Sql = {
      exec: (query, ...params) => state.storage.sql.exec(query, ...params).toArray(),
    };
    this.#store = new Store(sql);
    this.#push =
      env.GMAIL_FEED_PUBSUB_TOPIC && env.GMAIL_FEED_PUBSUB_SERVICE_ACCOUNT
        ? new GmailPush(this.#store, env.GMAIL_FEED_PUBSUB_TOPIC)
        : null;
  }

  #make() {
    if (this.#services) return this.#services;
    const config = loadConfig(this.#env as Record<string, string | undefined>);
    const screener = decisionsScreener({
      apiKey: config.openaiApiKey,
      model: config.screen.model,
      timeoutMs: config.screen.timeoutMs,
      thresholds: { unsafe: config.screen.unsafe, wake: config.screen.wake },
      prompt: EMAIL_PROMPT,
      log,
    });
    const gmail = new GmailClient(config.google);
    const feed = new GmailFeed({
      config: config.feed,
      store: this.#store,
      gmail,
      slack: slackBot(config.slackBotToken),
      screener,
      log,
    });
    this.#services = { feed, gmail };
    return this.#services;
  }

  async #wakeAt(time: number): Promise<void> {
    const current = await this.#state.storage.getAlarm();
    if (current === null || current > time) await this.#state.storage.setAlarm(time);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/status") {
      try {
        const status = this.#make().feed.status();
        return json(this.#push?.status(status, Date.now()) ?? { ...status, mode: "polling" });
      } catch (error) {
        return json({ ok: false, error: String(error) });
      }
    }
    if (url.pathname === "/push" && this.#push) {
      const { emailAddress, historyId } = (await request.json()) as {
        emailAddress: string;
        historyId: string;
      };
      const mailbox = this.#store.get("mailbox");
      if (!mailbox) return json({ error: "mailbox initializing" }, 503);
      if (emailAddress.toLowerCase() !== mailbox.toLowerCase())
        return json({ error: "unexpected mailbox" }, 403);
      this.#push.notify(historyId, Date.now());
      const due = this.#push.syncAt();
      if (due !== null) await this.#wakeAt(Math.max(due, Date.now()));
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/ensure-alarm") {
      if ((await this.#state.storage.getAlarm()) === null)
        await this.#state.storage.setAlarm(Date.now());
      return json({ ok: true });
    }
    if (url.pathname === "/tick") {
      this.#push?.requestSync(Date.now());
      await this.#wakeAt(Date.now());
      return json({ ok: true });
    }
    if (url.pathname === "/backfill") {
      const body = (await request.json().catch(() => ({}))) as { since?: string };
      const since = Date.parse(body.since ?? "");
      if (!Number.isFinite(since)) return json({ error: 'give {"since": "<ISO time>"}' }, 400);
      const result = await this.#make().feed.backfill(since);
      await this.#wakeAt(Date.now());
      return json(result);
    }
    return json({ error: "not found" }, 404);
  }

  async alarm(): Promise<void> {
    try {
      const { feed, gmail } = this.#make();
      if (this.#push) {
        await this.#push.renew(gmail, log, Date.now());
        const due = this.#push.syncAt();
        if (!this.#push.active || (due !== null && due <= Date.now()))
          await this.#push.sync(feed, Date.now());
      } else {
        try {
          await feed.poll();
        } catch {
          // Logged and recorded by poll. Process deliveries already in the queue.
        }
      }
      const deadline = Date.now() + 10 * 60_000;
      while (Date.now() < deadline) {
        const { posted, skipped, failed } = await feed.process(25);
        if (posted + skipped + failed < 25) break;
      }
    } finally {
      const now = Date.now();
      const next = Math.min(
        this.#store.nextDue() ?? Infinity,
        this.#push?.watchAt() ?? Infinity,
        this.#push?.syncAt() ?? Infinity,
        this.#push?.active ? Infinity : now + 60_000,
      );
      await this.#state.storage.setAlarm(Math.max(now + 1000, next));
    }
  }
}
