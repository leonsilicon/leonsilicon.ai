import http from "node:http";
import { resolve, type Route } from "#routes";

export type Logger = (event: string, fields?: Record<string, unknown>) => void;

export interface GatewayOptions {
  routes: readonly Route[];
  /** Public domain the services sit under; `<route>.<publicSuffix>` is sent upstream as X-Forwarded-Host. */
  publicSuffix: string;
  log?: Logger;
  /** An MCP POST still unanswered after this long is answered as SSE with keepalives. */
  slowMs?: number;
  /** Idle time on an SSE answer after which a keepalive comment is sent. */
  pingMs?: number;
}

// Cloudflare drops a proxied response after about 120 s without a byte (measured 2026-11-12:
// cut at 125 s whether or not headers had gone out; a comment every 30 s kept one alive for 200 s).
const SLOW_MS = 15_000;
const PING_MS = 20_000;
const MAX_CAPTURE = 1024 * 1024;
const MAX_JSON_ANSWER = 16 * 1024 * 1024;
const KEEPALIVE = ": keepalive\n\n";

// Hop-by-hop headers (RFC 9110 §7.6.1) never cross a proxy.
const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function strip(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const listed = new Set(
    String(headers.connection ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
  const out: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || HOP.has(key) || listed.has(key)) continue;
    out[key] = value;
  }
  return out;
}

function reply(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

const isSse = (headers: http.IncomingHttpHeaders): boolean =>
  String(headers["content-type"] ?? "").startsWith("text/event-stream");

/** JSON-RPC request ids in a request body, so a failure can be answered per request. */
function requestIds(body: Buffer): (string | number)[] {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    const messages: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    return messages
      .map((m) => (m as { id?: unknown } | null)?.id)
      .filter((id): id is string | number => typeof id === "string" || typeof id === "number");
  } catch {
    return [];
  }
}

/**
 * Writes to an SSE answer and adds a keepalive comment whenever the stream has been idle for
 * `pingMs`, but only between events: upstream chunks can split an event anywhere.
 */
class SseWriter {
  private last = Date.now();
  private boundary = true;
  private readonly timer: NodeJS.Timeout;
  private readonly res: http.ServerResponse;

  constructor(res: http.ServerResponse, pingMs: number) {
    this.res = res;
    this.timer = setInterval(
      () => {
        if (this.boundary && Date.now() - this.last >= pingMs) this.write(KEEPALIVE);
      },
      Math.max(10, Math.floor(pingMs / 4)),
    );
    res.on("close", () => this.stop());
  }

  write(chunk: string | Buffer): void {
    if (this.res.writableEnded) return;
    this.res.write(chunk);
    this.last = Date.now();
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (text.length) this.boundary = /\r?\n\r?\n$/.test(text);
  }

  end(): void {
    this.stop();
    if (!this.res.writableEnded) this.res.end();
  }

  stop(): void {
    clearInterval(this.timer);
  }
}

/**
 * A reverse proxy for the routes in `routes.ts`.
 *
 * - Streams both ways; rewrites Host to the local upstream so each service's DNS-rebinding check
 *   passes unchanged; logs the route name, never the raw path or any header.
 * - Keeps long MCP calls alive through Cloudflare: an SSE answer gets a keepalive comment after
 *   `pingMs` of silence, and an MCP POST whose client accepts SSE but which is still unanswered
 *   after `slowMs` is answered as SSE right away (keepalives while waiting, then the upstream's
 *   JSON-RPC answer as an `event: message`), as the Streamable HTTP transport allows.
 */
export function createGateway({
  routes,
  publicSuffix,
  log = () => {},
  slowMs = SLOW_MS,
  pingMs = PING_MS,
}: GatewayOptions): http.Server {
  const server = http.createServer((req, res) => {
    const started = Date.now();
    const url = req.url ?? "/";
    if (url === "/healthz" || url.startsWith("/healthz?")) {
      return reply(res, 200, {
        service: "ai-gateway",
        up: true,
        routes: routes.map((r) => r.name),
      });
    }
    const match = resolve(routes, url);
    if (!match) {
      log("not_found", { method: req.method });
      return reply(res, 404, { error: "not_found" });
    }
    const { route, kind, target } = match;
    const headers = strip(req.headers);
    headers.host = target.host;
    headers["x-forwarded-host"] = `${route.name}.${publicSuffix}`;
    headers["x-forwarded-proto"] = "https";
    const client = req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress;
    if (client) headers["x-forwarded-for"] = client;

    const done = (status: number | undefined, mode: string): void =>
      log("request", {
        route: route.name,
        kind,
        method: req.method,
        status,
        mode,
        ms: Date.now() - started,
      });

    // Long-call handling applies to MCP POSTs whose client takes SSE (every Streamable HTTP client must).
    const mayStream =
      kind === "mcp" &&
      req.method === "POST" &&
      String(req.headers.accept ?? "").includes("text/event-stream");
    const captured: Buffer[] = [];
    let capturedBytes = 0;
    if (mayStream)
      req.on("data", (chunk: Buffer) => {
        if (capturedBytes + chunk.length <= MAX_CAPTURE) captured.push(chunk);
        capturedBytes += chunk.length;
      });

    let sse: SseWriter | null = null; // set once the gateway answers as SSE before the upstream did
    let slow: NodeJS.Timeout | undefined;
    const startSlowTimer = (): void => {
      if (!mayStream) return;
      slow = setTimeout(() => {
        if (res.headersSent) return;
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        res.flushHeaders();
        sse = new SseWriter(res, pingMs);
        sse.write(KEEPALIVE);
      }, slowMs);
    };

    const upstream = http.request(target, { method: req.method, headers }, (up) => {
      clearTimeout(slow);
      const status = up.statusCode ?? 502;
      const held = sse;

      if (!held) {
        res.writeHead(status, strip(up.headers));
        res.flushHeaders();
        if (isSse(up.headers)) {
          const writer = new SseWriter(res, pingMs);
          up.on("data", (chunk: Buffer) => writer.write(chunk));
          up.on("end", () => {
            writer.end();
            done(status, "sse");
          });
        } else {
          up.pipe(res);
          up.on("end", () => done(status, "pass"));
        }
        return;
      }

      // Already answering as SSE: relay the upstream's answer as events.
      if (status < 300 && isSse(up.headers)) {
        up.on("data", (chunk: Buffer) => held.write(chunk));
        up.on("end", () => {
          held.end();
          done(status, "held-sse");
        });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      up.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_JSON_ANSWER) chunks.push(chunk);
      });
      up.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let messages: unknown[] | null = null;
        if (status < 300 && size <= MAX_JSON_ANSWER) {
          try {
            const parsed: unknown = text.trim() ? JSON.parse(text) : [];
            messages = Array.isArray(parsed) ? parsed : [parsed];
          } catch {
            messages = null;
          }
        }
        if (messages === null) {
          const message = `upstream answered HTTP ${status}${size > MAX_JSON_ANSWER ? " (answer too large)" : ""}`;
          messages = requestIds(Buffer.concat(captured)).map((id) => ({
            jsonrpc: "2.0",
            id,
            error: { code: -32603, message },
          }));
        }
        for (const m of messages) held.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
        held.end();
        done(status, "held-json");
      });
    });
    upstream.on("error", (error) => {
      clearTimeout(slow);
      log("upstream_error", { route: route.name, kind, error: error.message });
      const held = sse;
      if (held) {
        for (const id of requestIds(Buffer.concat(captured)))
          held.write(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: `${route.name} is unavailable` } })}\n\n`,
          );
        held.end();
      } else if (!res.headersSent)
        reply(res, 502, { error: "upstream_unavailable", route: route.name });
      else res.destroy();
    });
    // The client went away before the answer was complete: drop the upstream call too.
    res.on("close", () => {
      clearTimeout(slow);
      if (!res.writableFinished) upstream.destroy();
    });
    req.on("end", startSlowTimer);
    req.pipe(upstream);
  });
  // Only the request body has to arrive within this; long answers stream for as long as they need.
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;
  return server;
}
