import {
  createHandler,
  loadConfig,
  sessionClient,
  SlackAsLeon,
} from "@-/ai.leonsilicon.services.slack-as-leon";
import type { RateStore } from "@-/ai.leonsilicon.services.slack-as-leon";
import { serveSite, type Assets } from "@-/ai.leonsilicon.configs.cloudflare";

// Just the KV surface used here. Cloudflare's full type packages redefine globals such as Response,
// which conflicts with the Node types this workspace compiles everything else against.
interface KVNamespace {
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  list(options: { prefix: string }): Promise<{ keys: { name: string }[] }>;
}

interface Env {
  /** The Vite build of www/ (dist/www): this Worker's page is www/ai/leonsilicon/slack-as-leon/index.html. */
  ASSETS: Assets;
  /** One key per post, expiring after an hour: the hourly limits (`post:` Hermes, `grok:` Grok bots, `codex:` Codex sessions). */
  RATE: KVNamespace;
  SLACK_AS_LEON_MCP_TOKEN: string;
  SLACK_SESSION_TOKEN: string;
  SLACK_SESSION_COOKIE: string;
  SLACK_AS_LEON_PUBLIC_ORIGIN?: string;
  SLACK_AS_LEON_MAX_PER_HOUR?: string;
  SLACK_AS_LEON_BLOCKED_USERS?: string;
  SLACK_AS_LEON_GROK_TOKEN?: string;
  SLACK_AS_LEON_GROK_MAX_PER_HOUR?: string;
  SLACK_AS_LEON_CODEX_TOKEN?: string;
  SLACK_AS_LEON_CODEX_MAX_PER_HOUR?: string;
}

function kvRateStore(kv: KVNamespace, prefix = "post"): RateStore {
  return {
    count: async (sinceMs) =>
      (await kv.list({ prefix: `${prefix}:` })).keys.filter(
        (key) => Number(key.name.split(":")[1]) >= sinceMs,
      ).length,
    add: (atMs, id) => kv.put(`${prefix}:${atMs}:${id}`, "1", { expirationTtl: 3900 }),
  };
}

let handler: ((request: Request) => Promise<Response>) | undefined;

function build(env: Env): (request: Request) => Promise<Response> {
  const { ASSETS: _assets, RATE, ...vars } = env;
  const config = loadConfig(vars);
  const service = new SlackAsLeon(config, sessionClient(config.session), kvRateStore(RATE), {
    grokRate: kvRateStore(RATE, "grok"),
    codexRate: kvRateStore(RATE, "codex"),
  });
  return createHandler(config, service);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const page = await serveSite(request, env.ASSETS);
    if (page) return page;
    handler ??= build(env);
    return handler(request);
  },
};
