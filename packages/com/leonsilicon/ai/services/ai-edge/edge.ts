import { gatewayPath } from "#hosts";

/** What the Worker calls to reach the mini: a Workers VPC binding to the ai-mini tunnel. */
export interface Upstream {
  fetch(request: Request): Promise<Response>;
}

/** Where the gateway listens on the mini, as the VPC service sees it. */
export const GATEWAY_ORIGIN = "http://127.0.0.1:18800";

const notFound = () =>
  new Response(JSON.stringify({ error: "not_found" }), {
    status: 404,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

/**
 * Forwards `<name>.leonsilicon.ai` to the mini's gateway path for that name. Method, headers
 * (the bearer token included) and body pass through untouched, and the response streams back as
 * it arrives, so SSE and the gateway's keepalives work. No authentication is added here: every
 * service checks its own bearer token.
 */
export function createEdge(upstream: Upstream): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const path = gatewayPath(url.hostname, url.pathname, url.search);
    if (!path) return notFound();
    const headers = new Headers(request.headers);
    headers.set("X-Forwarded-Host", url.hostname);
    headers.set("X-Forwarded-Proto", "https");
    const init: RequestInit & { duplex: "half" } = {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
      redirect: "manual",
      // Streams the body instead of buffering it (required by Node's fetch; Workers accept it).
      duplex: "half",
    };
    const forwarded = new Request(`${GATEWAY_ORIGIN}${path}`, init);
    try {
      return await upstream.fetch(forwarded);
    } catch {
      return new Response(JSON.stringify({ error: "mini_unreachable" }), {
        status: 502,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
  };
}
