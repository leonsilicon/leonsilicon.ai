import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createGateway } from "#gateway";
import { resolve, ROUTES, type Route } from "#routes";

test("resolve maps /<name> to the MCP endpoint and /<name>/healthz to health, keeping the query", () => {
  const orca = resolve(ROUTES, "/orca");
  assert.equal(orca?.kind, "mcp");
  assert.equal(orca?.target.href, "http://127.0.0.1:18787/mcp");
  assert.equal(resolve(ROUTES, "/orca/")?.target.href, "http://127.0.0.1:18787/mcp");
  assert.equal(resolve(ROUTES, "/beeper")?.target.href, "http://127.0.0.1:23373/v0/mcp");
  assert.equal(
    resolve(ROUTES, "/grok/healthz?deep=1")?.target.href,
    "http://127.0.0.1:18788/healthz?deep=1",
  );
});

test("resolve refuses everything else", () => {
  for (const path of [
    "/",
    "/nope",
    "/orca/mcp",
    "/orca/healthz/x",
    "/beeper/healthz", // no health route
    "/beeper/v0/search-messages",
    "/orca-mcp",
    "//orca",
    "/.well-known/oauth-protected-resource",
  ])
    assert.equal(resolve(ROUTES, path), null, path);
});

test("route names are unique and every target is a loopback URL", () => {
  const names = ROUTES.map((r) => r.name);
  assert.equal(new Set(names).size, names.length);
  for (const r of ROUTES)
    for (const u of [r.mcp, r.health].filter(Boolean))
      assert.equal(new URL(u!).hostname, "127.0.0.1", u);
});

let upstream: http.Server;
let gateway: http.Server;
let base = "";
const seen: {
  host?: string;
  forwardedHost?: string;
  connection?: string;
  auth?: string;
  url?: string;
}[] = [];

before(async () => {
  upstream = http.createServer((req, res) => {
    seen.push({
      host: req.headers.host,
      forwardedHost: req.headers["x-forwarded-host"] as string | undefined,
      connection: req.headers["x-custom-hop"] as string | undefined,
      auth: req.headers.authorization,
      url: req.url,
    });
    if (req.url?.startsWith("/sse")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: one\n\n");
      setTimeout(() => res.end("data: two\n\n"), 150);
      return;
    }
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      if (q.has("split")) {
        // One event split across chunks with a long pause inside it, then a pause between events.
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write('data: {"a":');
        setTimeout(() => res.write("1}\n\n"), 200);
        setTimeout(() => res.end("data: two\n\n"), 400);
        return;
      }
      if (q.has("slow")) {
        const id = (JSON.parse(body) as { id: number }).id;
        const status = Number(q.get("status") ?? 200);
        setTimeout(
          () => {
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(
              status === 200
                ? JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true } })
                : "oops",
            );
          },
          Number(q.get("slow")),
        );
        return;
      }
      res.writeHead(201, { "Content-Type": "application/json", "X-Up": "yes" });
      res.end(JSON.stringify({ echo: body }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const port = (upstream.address() as AddressInfo).port;
  const routes: Route[] = [
    {
      name: "svc",
      description: "test",
      mcp: `http://127.0.0.1:${port}/mcp`,
      health: `http://127.0.0.1:${port}/sse`,
    },
    { name: "down", description: "nothing listens", mcp: "http://127.0.0.1:9/mcp" },
  ];
  gateway = createGateway({ routes, publicSuffix: "ai.example.com", slowMs: 60, pingMs: 40 });
  await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((r) => gateway.close(r));
  await new Promise((r) => upstream.close(r));
});

test("forwards method, body, status, headers and auth; rewrites Host; drops hop-by-hop headers", async () => {
  // fetch() refuses to send a Connection header, so this one goes through node:http.
  const res = await new Promise<{
    status?: number;
    headers: http.IncomingHttpHeaders;
    body: string;
  }>((done, fail) => {
    const req = http.request(
      `${base}/svc?x=1`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer abc",
          Connection: "x-custom-hop",
          "X-Custom-Hop": "secret",
        },
      },
      (r) => {
        let body = "";
        r.on("data", (c: Buffer) => (body += c.toString()));
        r.on("end", () => done({ status: r.statusCode, headers: r.headers, body }));
      },
    );
    req.on("error", fail);
    req.end('{"jsonrpc":"2.0"}');
  });
  assert.equal(res.status, 201);
  assert.equal(res.headers["x-up"], "yes");
  assert.deepEqual(JSON.parse(res.body), { echo: '{"jsonrpc":"2.0"}' });
  const last = seen.at(-1)!;
  assert.match(last.host!, /^127\.0\.0\.1:\d+$/);
  assert.equal(last.forwardedHost, "svc.ai.example.com");
  assert.equal(last.auth, "Bearer abc");
  assert.equal(last.url, "/mcp?x=1");
  assert.equal(last.connection, undefined);
});

test("streams SSE as it arrives", async () => {
  const res = await fetch(`${base}/svc/healthz`);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body!.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /data: one/);
  let rest = "";
  for (let r = await reader.read(); !r.done; r = await reader.read())
    rest += new TextDecoder().decode(r.value);
  assert.match(rest, /data: two/);
});

test("answers 404 for unrouted paths, 502 when the upstream is down, and its own /healthz", async () => {
  assert.equal((await fetch(`${base}/svc/other`)).status, 404);
  assert.equal((await fetch(`${base}/`)).status, 404);
  const down = await fetch(`${base}/down`, { method: "POST", body: "{}" });
  assert.equal(down.status, 502);
  assert.deepEqual(await down.json(), { error: "upstream_unavailable", route: "down" });
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual((await health.json()).routes, ["svc", "down"]);
});

const MCP_POST = {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call" }),
};

test("a quick JSON answer passes through unchanged", async () => {
  const res = await fetch(`${base}/svc?slow=5`, MCP_POST);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.deepEqual(await res.json(), { jsonrpc: "2.0", id: 7, result: { ok: true } });
});

test("a slow MCP call is answered as SSE with keepalives, then the JSON-RPC answer as an event", async () => {
  const res = await fetch(`${base}/svc?slow=250`, MCP_POST);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const text = await res.text();
  assert.match(text, /^: keepalive\n\n/);
  assert.ok(text.split(": keepalive").length > 2, "keepalives while waiting");
  const data = text.split("\n").filter((l) => l.startsWith("data: "));
  assert.deepEqual(
    data.map((l) => JSON.parse(l.slice(6))),
    [{ jsonrpc: "2.0", id: 7, result: { ok: true } }],
  );
  assert.match(text, /event: message\ndata: .*\n\n$/);
});

test("a slow call that fails upstream ends with a JSON-RPC error for its id", async () => {
  const res = await fetch(`${base}/svc?slow=150&status=500`, MCP_POST);
  const data = (await res.text()).split("\n").filter((l) => l.startsWith("data: "));
  assert.deepEqual(
    data.map((l) => JSON.parse(l.slice(6))),
    [{ jsonrpc: "2.0", id: 7, error: { code: -32603, message: "upstream answered HTTP 500" } }],
  );
});

test("a client that does not take SSE waits for the plain answer", async () => {
  const res = await fetch(`${base}/svc?slow=150`, {
    ...MCP_POST,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
  });
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.equal(((await res.json()) as { id: number }).id, 7);
});

test("keepalives on an upstream SSE answer go only between events", async () => {
  const res = await fetch(`${base}/svc?split=1`, MCP_POST);
  const text = await res.text();
  assert.ok(text.startsWith('data: {"a":1}\n\n'), JSON.stringify(text));
  assert.match(text, /\n\n: keepalive\n\n/);
  assert.ok(text.endsWith("data: two\n\n"));
});
