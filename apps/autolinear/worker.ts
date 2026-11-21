import { Intake, loadConfig, messageFromEvent } from "@-/ai.leonsilicon.services.autolinear";
import type {
  AutolinearConfig,
  EventLookups,
  IntakeCache,
  IntakeMessage,
  IntakeResult,
  Progress,
  SlackMessageEvent,
} from "@-/ai.leonsilicon.services.autolinear";
import { LinearClient, verifySlack } from "@-/ai.leonsilicon.services.slack22linear";
import type { Adoption } from "@-/ai.leonsilicon.services.slack22linear";
import { sessionClient } from "@-/ai.leonsilicon.services.slack-as-leon";
import { serveSite, type Assets } from "@-/ai.leonsilicon.configs.cloudflare";

// Just the Durable Object surface used here. Cloudflare's full type packages redefine globals such
// as Response, which conflicts with the Node types this workspace compiles everything else against.
interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}
interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown, options?: { locationHint?: string }): DurableObjectStub;
}
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
interface DurableObjectState {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    deleteAll(): Promise<void>;
    setAlarm(time: number): Promise<void>;
  };
}

interface Env {
  /** One Durable Object per message. */
  INTAKE: DurableObjectNamespace;
  /** slack22linear's Durable Object (script linear-slack-sync), which adopts the channels. */
  SYNC: DurableObjectNamespace;
  /** The Vite build of www/ (dist/www): this Worker's page is www/ai/leonsilicon/autolinear/index.html. */
  ASSETS: Assets;
  /** Bearer token Hermes's autolinear plugin sends. */
  AUTOLINEAR_TOKEN: string;
  /**
   * Signing secret of the autolinear Slack app, whose user events (Leon's messages) start intakes
   * before Hermes asks. Until it's set, /slack/events answers only Slack's URL check.
   */
  AUTOLINEAR_SLACK_SIGNING_SECRET?: string;
  /** Personal API key of the Linear account issues are created as (slack22linear's). */
  LINEAR_API_KEY: string;
  /** Leon's Slack web session: autolinear acts as him. */
  SLACK_SESSION_TOKEN: string;
  SLACK_SESSION_COOKIE: string;
  [key: string]: unknown;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, ...fields }));

const SLACK_ID = /^[CDG][A-Z0-9]{6,}$/;
const SLACK_TS = /^\d{10}\.\d{6}$/;
const USER_ID = /^[UW][A-Z0-9]{6,}$/;

/**
 * Where each message's Durable Object is created: eastern North America, next to Slack's and
 * Linear's APIs, so the few requests an intake makes in a row are short hops.
 */
const LOCATION = "enam";

/** How long a finished intake is remembered, for retries, before its storage is cleared. */
const KEEP_MS = 24 * 3600_000;

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** The request body, checked: what Hermes's plugin sends about one of Leon's messages. */
function readMessage(body: Record<string, unknown> | null): IntakeMessage | null {
  if (!body) return null;
  const message: IntakeMessage = {
    channel: text(body.channel),
    ts: text(body.ts),
    threadTs: text(body.thread_ts) || null,
    user: text(body.user),
    text: text(body.text),
    where: text(body.where) || "Slack",
    ...(Array.isArray(body.blocks) ? { blocks: body.blocks as unknown[] } : {}),
    ...(Array.isArray(body.files)
      ? {
          files: (body.files as Record<string, unknown>[]).map((f) => ({
            name: text(f?.name),
            title: text(f?.title),
            permalink: text(f?.permalink),
          })),
        }
      : {}),
  };
  const valid =
    SLACK_ID.test(message.channel) &&
    SLACK_TS.test(message.ts) &&
    (!message.threadTs || SLACK_TS.test(message.threadTs)) &&
    USER_ID.test(message.user);
  return valid ? message : null;
}

const session = (env: Env) =>
  sessionClient({ token: env.SLACK_SESSION_TOKEN, cookie: env.SLACK_SESSION_COOKIE });

/** Isolate-wide: Leon's DM with Hermes and channel names, for reading Slack's events. */
let hermesDm: Promise<string | null> | null = null;
const channelNames = new Map<string, string | null>();

function eventLookups(env: Env, config: AutolinearConfig): EventLookups {
  return {
    hermesDmId: () =>
      config.hermesDmId
        ? Promise.resolve(config.hermesDmId)
        : (hermesDm ??= session(env)("conversations.open", { users: config.hermesUserId })
            .then((r) => (r.channel as { id: string }).id)
            .catch((error: unknown) => {
              hermesDm = null;
              log("hermes_dm_lookup_failed", { error: String(error) });
              return null;
            })),
    channelName: async (id) => {
      if (channelNames.has(id)) return channelNames.get(id)!;
      try {
        const info = await session(env)("conversations.info", { channel: id });
        const name = (info.channel as { name?: string }).name ?? null;
        channelNames.set(id, name);
        return name;
      } catch (error) {
        log("channel_lookup_failed", { channel: id, error: String(error) });
        return null;
      }
    },
  };
}

/** Starts a message's intake in its Durable Object. The answer goes to whoever asks for it. */
function startIntake(env: Env, message: IntakeMessage): Promise<Response> {
  const stub = env.INTAKE.get(env.INTAKE.idFromName(`${message.channel}:${message.ts}`), {
    locationHint: LOCATION,
  });
  return stub.fetch(
    new Request("https://intake/run", { method: "POST", body: JSON.stringify(message) }),
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const page = await serveSite(request, env.ASSETS);
    if (page) return page;
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/healthz") {
      const checks: Record<string, string> = {};
      checks.token = env.AUTOLINEAR_TOKEN ? "ok" : "missing";
      checks.events = env.AUTOLINEAR_SLACK_SIGNING_SECRET ? "ok" : "missing";
      try {
        await session(env)("auth.test");
        checks.session = "ok";
      } catch (error) {
        checks.session = String(error);
      }
      try {
        const team = await new LinearClient(env.LINEAR_API_KEY).team(
          loadConfig(env as Record<string, string | undefined>).teamKey,
        );
        checks.linear = team ? "ok" : "no such team";
      } catch (error) {
        checks.linear = String(error);
      }
      const ok = Object.values(checks).every((value) => value === "ok");
      return json({ ok, ...checks }, ok ? 200 : 503);
    }

    // Hermes's autolinear plugin, the moment one of Leon's messages reaches it.
    if (request.method === "POST" && url.pathname === "/intake") {
      if (
        !env.AUTOLINEAR_TOKEN ||
        request.headers.get("authorization") !== `Bearer ${env.AUTOLINEAR_TOKEN}`
      )
        return json({ error: "unauthorized" }, 401);
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      const message = readMessage(body);
      if (!message) return json({ error: "channel, ts and user are required" }, 400);
      return startIntake(env, message);
    }

    // The autolinear Slack app's user events: every message in Leon's DMs and public channels. One
    // of his that Hermes is sure to answer starts its intake now, before Hermes has even seen it;
    // Hermes's own call then finds it running or done. Slack gets its answer at once.
    if (request.method === "POST" && url.pathname === "/slack/events") {
      const body = await request.text();
      const payload = JSON.parse(body) as {
        type?: string;
        challenge?: string;
        is_ext_shared_channel?: boolean;
        event?: SlackMessageEvent;
      };
      // Before the signing secret is set, answer only Slack's URL check, so the app can be created.
      if (!env.AUTOLINEAR_SLACK_SIGNING_SECRET)
        return payload.type === "url_verification"
          ? json({ challenge: payload.challenge })
          : json({ error: "not configured" }, 503);
      const verified = await verifySlack(
        env.AUTOLINEAR_SLACK_SIGNING_SECRET,
        request.headers.get("x-slack-request-timestamp"),
        request.headers.get("x-slack-signature"),
        body,
        Date.now(),
      );
      if (!verified) return json({ error: "bad signature" }, 401);
      if (payload.type === "url_verification") return json({ challenge: payload.challenge });
      if (payload.type === "event_callback" && !payload.is_ext_shared_channel) {
        const config = loadConfig(env as Record<string, string | undefined>);
        ctx.waitUntil(
          messageFromEvent(payload.event, config, eventLookups(env, config)).then(
            async (message) => {
              if (!message) return;
              const response = await startIntake(env, message);
              log("event_intake", {
                channel: message.channel,
                ts: message.ts,
                status: response.status,
              });
            },
          ),
        );
      }
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  },
};

/** Isolate-wide lookups (the team's IDs, the workspace URL), shared by every intake it runs. */
const cache: IntakeCache = {};

/**
 * One message's intake. Concurrent requests for the message share one run, a finished run's answer
 * is returned again, and a failed one carries on from its last step when asked again.
 */
export class IntakeObject {
  readonly #state: DurableObjectState;
  readonly #env: Env;
  #running: Promise<IntakeResult> | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.#state = state;
    this.#env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const message = (await request.json()) as IntakeMessage;
    const done = await this.#state.storage.get<IntakeResult>("result");
    if (done) return json(done);
    this.#running ??= this.#run(message).finally(() => {
      this.#running = null;
    });
    try {
      return json(await this.#running);
    } catch (error) {
      log("intake_failed", { channel: message.channel, ts: message.ts, error: String(error) });
      return json({ ok: false, error: String(error) }, 500);
    }
  }

  async alarm(): Promise<void> {
    await this.#state.storage.deleteAll();
  }

  async #run(message: IntakeMessage): Promise<IntakeResult> {
    const env = this.#env;
    const storage = this.#state.storage;
    const sync = env.SYNC.get(env.SYNC.idFromName("sync"));
    const intake = new Intake({
      config: loadConfig(env as Record<string, string | undefined>),
      linear: new LinearClient(env.LINEAR_API_KEY),
      session: session(env),
      adopt: async (adoption: Adoption) => {
        const response = await sync.fetch(
          new Request("https://sync/adopt", { method: "POST", body: JSON.stringify(adoption) }),
        );
        if (!response.ok) throw new Error(`slack22linear's /adopt answered ${response.status}`);
      },
      progress: {
        get: async () => (await storage.get<Progress>("progress")) ?? {},
        put: (progress) => storage.put("progress", progress),
      },
      cache,
      log,
    });
    const result = await intake.run(message);
    await storage.put("result", result);
    await storage.setAlarm(Date.now() + KEEP_MS);
    return result;
  }
}
