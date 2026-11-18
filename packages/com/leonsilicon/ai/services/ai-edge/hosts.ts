/** The zone suffix every service name sits under: `<name>.leonsilicon.ai`. */
export const SUFFIX = ".leonsilicon.ai";

/**
 * Suffixes the services answered under before, still Custom Domains of the edge Worker as aliases
 * until every client has moved: `<name>.ai.leonsilicon.com` until 2026-11-18.
 */
export const LEGACY_SUFFIXES = [".ai.leonsilicon.com"] as const;

/**
 * Services on the Mac mini, reached through its ai-gateway. These are the gateway's route names,
 * and each one is a Custom Domain of the edge Worker (`apps/ai-edge/wrangler.jsonc`).
 */
export const MINI_SERVICES = ["orca", "grok", "beeper", "watch", "cronometer"] as const;

export type MiniService = (typeof MINI_SERVICES)[number];

/**
 * The gateway path a public request goes to, or null when nothing should answer it.
 * `https://<name>.leonsilicon.ai/` (or a legacy suffix) and `/mcp` are the service's MCP endpoint, and `/healthz`
 * its health check; the gateway serves them as `/<name>` and `/<name>/healthz`. The query string
 * is kept. Every other path, and every other host, is refused, as the gateway itself does.
 */
export function gatewayPath(host: string, pathname: string, search = ""): string | null {
  const lower = host.toLowerCase().replace(/:\d+$/, "");
  const suffix = [SUFFIX, ...LEGACY_SUFFIXES].find((s) => lower.endsWith(s));
  if (!suffix) return null;
  const name = lower.slice(0, -suffix.length);
  if (!(MINI_SERVICES as readonly string[]).includes(name)) return null;
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/" || path === "/mcp") return `/${name}${search}`;
  if (path === "/healthz") return `/${name}/healthz${search}`;
  return null;
}
