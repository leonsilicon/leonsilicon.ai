/**
 * A Worker's static assets binding (`"assets": { "binding": "ASSETS" }` in wrangler.jsonc), holding
 * the Vite build of `www/` (`dist/www`).
 */
export interface Assets {
  fetch(request: Request): Promise<Response>;
}

/** Where Vite puts the hashed scripts and styles the pages share (`build.assetsDir`). */
export const SHARED_ASSETS = "/assets/";

const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Hostname suffixes that moved, old to new. The old names stay Custom Domains as aliases until every
 * client has moved: API requests there still reach the Worker, and a browser is redirected to the
 * same name under the new suffix. `<name>.ai.leonsilicon.com` moved to `<name>.leonsilicon.ai` on
 * 2026-11-18.
 */
export const MOVED: Readonly<Record<string, string>> = { "ai.leonsilicon.com": "leonsilicon.ai" };

/** Where a hostname under a moved suffix lives now, or null if it hasn't moved. */
export function movedHost(host: string): string | null {
  const lower = host.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  for (const [from, to] of Object.entries(MOVED))
    if (lower.endsWith(`.${from}`)) return `${lower.slice(0, -from.length)}${to}`;
  return null;
}

/**
 * The `www/` directory a hostname's pages come from: its labels reversed, like a reverse-DNS
 * package name. `orca.leonsilicon.ai` is `/ai/leonsilicon/orca/`. Returns null for anything
 * that isn't a plain DNS name.
 */
export function sitePath(host: string): string | null {
  const labels = host.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "").split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return null;
  return `/${labels.reverse().join("/")}/`;
}

/** A browser navigating, not an API client: MCP clients ask for JSON or an event stream. */
function wantsPage(request: Request): boolean {
  return (request.headers.get("Accept") ?? "").includes("text/html");
}

/**
 * Answers from the built pages when it should, or returns null so the Worker's own handler answers.
 *
 * - A browser asking for `https://<host>/<path>` (GET or HEAD with `Accept: text/html`) gets
 *   `<sitePath(host)><path>`, with `index.html` added to a path that ends in `/`.
 * - `/assets/*`, the scripts and styles every page shares, are served for any host.
 *
 * - A browser on a hostname under a moved suffix (`MOVED`) is redirected to its new name.
 *
 * Anything the build doesn't have, and every other request, returns null. One host can't reach
 * another's pages: paths are resolved under the host's own directory.
 */
export async function serveSite(request: Request, assets: Assets): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  let path: string;
  if (url.pathname.startsWith(SHARED_ASSETS)) {
    path = url.pathname;
  } else if (wantsPage(request)) {
    const moved = movedHost(url.hostname);
    if (moved) return Response.redirect(`https://${moved}${url.pathname}${url.search}`, 301);
    const root = sitePath(url.hostname);
    if (!root) return null;
    path = `${root}${url.pathname.slice(1)}${url.pathname.endsWith("/") ? "index.html" : ""}`;
  } else {
    return null;
  }
  const response = await assets.fetch(
    new Request(new URL(path, url.origin), { method: request.method, headers: request.headers }),
  );
  return response.status === 404 ? null : response;
}
