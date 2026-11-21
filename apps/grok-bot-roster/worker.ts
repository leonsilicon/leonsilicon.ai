import {
  createHandler,
  GrokBotApi,
  loadConfig,
  Roster,
} from "@-/ai.leonsilicon.services.grok-bot-roster";
import type { Session, SessionStore } from "@-/ai.leonsilicon.services.grok-bot-roster";
import { serveSite, type Assets } from "@-/ai.leonsilicon.configs.cloudflare";

// Just the KV surface used here. Cloudflare's full type packages redefine globals such as Response,
// which conflicts with the Node types this workspace compiles everything else against.
interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

interface Env {
  /** The Vite build of www/ (dist/www): this Worker's page is www/ai/leonsilicon/grokbot-admin/index.html. */
  ASSETS: Assets;
  /** `session`: Leon's Grok Bot sign-in for this service. */
  STATE: KVNamespace;
  GROK_BOT_ROSTER_MCP_TOKEN: string;
  GROK_BOT_ROSTER_PUBLIC_ORIGIN?: string;
}

function kvSessionStore(kv: KVNamespace): SessionStore {
  return {
    get: async () => {
      const raw = await kv.get("session");
      return raw ? (JSON.parse(raw) as Session) : null;
    },
    put: (session) => kv.put("session", JSON.stringify(session)),
  };
}

let built: { api: GrokBotApi; handler: (request: Request) => Promise<Response> } | undefined;

function build(env: Env) {
  const { ASSETS: _assets, STATE, ...vars } = env;
  const config = loadConfig(vars);
  const api = new GrokBotApi(kvSessionStore(STATE));
  const roster = new Roster(api);
  return { api, handler: createHandler(config, roster, api) };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const page = await serveSite(request, env.ASSETS);
    if (page) return page;
    built ??= build(env);
    return built.handler(request);
  },

  /** Daily: refresh the sign-in once it has less than 30 days left, so it never lapses. */
  async scheduled(_event: unknown, env: Env): Promise<void> {
    built ??= build(env);
    const expiry = await built.api.ensureFresh();
    console.log(
      JSON.stringify({
        event: "session",
        expires_at: expiry ? new Date(expiry).toISOString() : null,
      }),
    );
  },
};
