import { Daily, loadConfig } from "@-/ai.leonsilicon.services.dailylinear";
import type { DailyResult, DailyState } from "@-/ai.leonsilicon.services.dailylinear";
import { LinearClient, localDay } from "@-/ai.leonsilicon.services.linear-slack-sync";
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
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
interface DurableObjectState {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    setAlarm(time: number): Promise<void>;
  };
}

interface Env {
  DAILY: DurableObjectNamespace;
  /** The Vite build of www/ (dist/www): this Worker's page is www/ai/leonsilicon/dailylinear/index.html. */
  ASSETS: Assets;
  /** Personal API key of the Linear account the day's projects are made as (Linear Sync's). */
  LINEAR_API_KEY: string;
  /** Leon's Slack web session: it joins him, renames, stars and files the channels. */
  SLACK_SESSION_TOKEN: string;
  SLACK_SESSION_COOKIE: string;
  /** Bearer token for /admin/* (run, status). */
  DAILYLINEAR_ADMIN_TOKEN: string;
  [key: string]: unknown;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, ...fields }));

const stub = (env: Env) => env.DAILY.get(env.DAILY.idFromName("daily"));

const authorized = (request: Request, env: Env) =>
  Boolean(env.DAILYLINEAR_ADMIN_TOKEN) &&
  request.headers.get("authorization") === `Bearer ${env.DAILYLINEAR_ADMIN_TOKEN}`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const page = await serveSite(request, env.ASSETS);
    if (page) return page;
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/healthz") {
      const health = await (await stub(env).fetch(new Request("https://daily/health"))).json();
      return json(health, (health as { ok: boolean }).ok ? 200 : 503);
    }

    if (url.pathname === "/admin/run" && request.method === "POST") {
      if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
      return stub(env).fetch(new Request("https://daily/run", { method: "POST" }));
    }

    if (url.pathname === "/admin/status" && request.method === "GET") {
      if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
      return stub(env).fetch(new Request("https://daily/status"));
    }

    return json({ error: "not found" }, 404);
  },

  async scheduled(_event: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(stub(env).fetch(new Request("https://daily/run", { method: "POST" })));
  },
};

/** A failed run is tried again after a minute, doubling up to 15 minutes. */
const retryAfter = (failures: number) => Math.min(60_000 * 2 ** (failures - 1), 15 * 60_000);

/**
 * The one place a day is settled. Runs never overlap (the alarm, the hourly cron and /admin/run
 * share one), so a day's project can't be made twice. After each run the alarm is set for the next
 * one: midnight in Toronto, or a minute later while the day's channel is on its way.
 */
export class DailyObject {
  readonly #state: DurableObjectState;
  readonly #env: Env;
  #running: Promise<DailyResult> | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.#state = state;
    this.#env = env;
  }

  #session() {
    return sessionClient({
      token: this.#env.SLACK_SESSION_TOKEN,
      cookie: this.#env.SLACK_SESSION_COOKIE,
    });
  }

  #run(): Promise<DailyResult> {
    this.#running ??= this.#runOnce().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #runOnce(): Promise<DailyResult> {
    const storage = this.#state.storage;
    const daily = new Daily({
      config: loadConfig(this.#env as Record<string, string | undefined>),
      linear: new LinearClient(this.#env.LINEAR_API_KEY),
      session: this.#session(),
      store: {
        get: async () => (await storage.get<DailyState>("state")) ?? { days: {} },
        put: (state) => storage.put("state", state),
      },
      log,
    });
    try {
      const result = await daily.run();
      await storage.put("failures", 0);
      // A second past midnight, so the run that wakes is surely on the new day.
      await storage.setAlarm(result.next + 1_000);
      log("ran", { day: result.day, status: result.status, created: result.created });
      return result;
    } catch (error) {
      const failures = ((await storage.get<number>("failures")) ?? 0) + 1;
      await storage.put("failures", failures);
      await storage.put("error", { at: Date.now(), error: String(error) });
      await storage.setAlarm(Date.now() + retryAfter(failures));
      log("run_failed", { failures, error: String(error) });
      throw error;
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      try {
        return json(await this.#run());
      } catch (error) {
        return json({ ok: false, error: String(error) }, 500);
      }
    }
    if (url.pathname === "/status") {
      const storage = this.#state.storage;
      return json({
        state: (await storage.get<DailyState>("state")) ?? null,
        failures: (await storage.get<number>("failures")) ?? 0,
        error: (await storage.get("error")) ?? null,
      });
    }
    if (url.pathname === "/health") return json(await this.#health());
    return json({ error: "not found" }, 404);
  }

  async alarm(): Promise<void> {
    // A failure has already set the retry; the error is in the log and /admin/status.
    await this.#run().catch(() => {});
  }

  /** Whether Slack and Linear answer, and how today's project stands. */
  async #health(): Promise<Record<string, unknown>> {
    const config = loadConfig(this.#env as Record<string, string | undefined>);
    const checks: Record<string, string> = {};
    try {
      await this.#session()("auth.test");
      checks.session = "ok";
    } catch (error) {
      checks.session = String(error);
    }
    const linear = new LinearClient(this.#env.LINEAR_API_KEY);
    try {
      checks.linear = (await linear.team(config.teamKey)) ? "ok" : "no such team";
    } catch (error) {
      checks.linear = String(error);
    }
    // The day's channel comes from Linear's own Slack app: without it, no channel can be made.
    try {
      checks.projects = (await linear.projectChannelSettings())
        ? "ok"
        : "off: connect Linear's Slack app and turn on Project channels";
    } catch (error) {
      checks.projects = String(error);
    }
    const last = (await this.#state.storage.get<DailyState>("state"))?.last;
    const today = localDay(Date.now(), config.timeZone);
    checks.today = last?.day === today ? last.status : "not run yet today";
    const failures = (await this.#state.storage.get<number>("failures")) ?? 0;
    const ok =
      checks.session === "ok" &&
      checks.linear === "ok" &&
      checks.projects === "ok" &&
      (checks.today === "ready" || checks.today === "closed") &&
      failures === 0;
    return { ok, ...checks, failures };
  }
}
