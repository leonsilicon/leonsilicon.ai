/**
 * The services on the Mac mini behind the gateway, each public as https://<name>.leonsilicon.ai
 * through the ai-edge Worker (Workers VPC → tunnel ai-mini → this gateway).
 *
 * `/<name>` is the service's MCP endpoint and `/<name>/healthz` its health check, when it has
 * one. Nothing else under a route is forwarded, so a service's other paths (Beeper Desktop's
 * REST API, for example) stay private. Every MCP endpoint checks its own bearer token; the
 * gateway adds no authentication of its own.
 */
export interface Route {
  /** The service's name: `https://<name>.leonsilicon.ai`, and the gateway path `/<name>`. */
  name: string;
  /** What it is, for the README and the gateway's own /healthz. */
  description: string;
  /** Local MCP endpoint the public path forwards to. */
  mcp: string;
  /** Local health endpoint `/<name>/healthz` forwards to, if any. */
  health?: string;
}

export const ROUTES: readonly Route[] = [
  {
    name: "orca",
    description: "Orca on the mini (full CLI incl. computer use, plus orca-mcp worker tools)",
    mcp: "http://127.0.0.1:18787/mcp",
    health: "http://127.0.0.1:18787/healthz",
  },
  {
    name: "grok",
    description: "Grok Bot relay through Beeper",
    mcp: "http://127.0.0.1:18788/mcp",
    health: "http://127.0.0.1:18788/healthz",
  },
  {
    name: "beeper",
    description: "Beeper Desktop's own MCP",
    mcp: "http://127.0.0.1:23373/v0/mcp",
  },
  {
    name: "watch",
    description: "Beeper Watch",
    mcp: "http://127.0.0.1:18789/mcp",
    health: "http://127.0.0.1:18789/healthz",
  },
];

export interface Match {
  route: Route;
  kind: "mcp" | "health";
  target: URL;
}

/** The local URL a public request path (plus query) goes to, or null for anything unrouted. */
export function resolve(routes: readonly Route[], url: string): Match | null {
  const parsed = new URL(url, "http://gateway.invalid");
  const parts = parsed.pathname.split("/");
  // "/name" → ["", "name"]; "/name/healthz" → ["", "name", "healthz"]; a trailing slash is allowed.
  if (parts[0] !== "" || parts.length < 2 || parts.length > 3) return null;
  const route = routes.find((r) => r.name === parts[1]);
  if (!route) return null;
  const rest = parts[2] ?? "";
  const kind = rest === "" ? "mcp" : rest === "healthz" ? "health" : null;
  if (kind === null) return null;
  const base = kind === "mcp" ? route.mcp : route.health;
  if (!base) return null;
  const target = new URL(base);
  target.search = parsed.search;
  return { route, kind, target };
}
