import assert from "node:assert/strict";
import { test } from "node:test";
import { ROUTES } from "@-/com.leonsilicon.ai.services.ai-gateway";
import { createEdge, GATEWAY_ORIGIN } from "#edge";
import { gatewayPath, MINI_SERVICES } from "#hosts";

test("every gateway route has a subdomain, and nothing else does", () => {
  assert.deepEqual([...MINI_SERVICES].sort(), ROUTES.map((r) => r.name).sort());
});

test("gatewayPath maps the subdomain to the gateway's path", () => {
  assert.equal(gatewayPath("orca.leonsilicon.ai", "/"), "/orca");
  assert.equal(gatewayPath("ORCA.leonsilicon.ai", "/mcp/"), "/orca");
  assert.equal(gatewayPath("cronometer.leonsilicon.ai", "", "?x=1"), "/cronometer?x=1");
  assert.equal(gatewayPath("muse.leonsilicon.ai", "/"), null);
  assert.equal(gatewayPath("grok.leonsilicon.ai", "/healthz"), "/grok/healthz");
  assert.equal(gatewayPath("watch.leonsilicon.ai:443", "/"), "/watch");
  for (const [host, path] of [
    ["orca.leonsilicon.ai", "/.well-known/oauth-protected-resource"],
    ["orca.leonsilicon.ai", "/orca"],
    ["beeper.leonsilicon.ai", "/v0/mcp"],
    ["ai.leonsilicon.com", "/orca"],
    ["leonsilicon.ai", "/orca"],
    // The old names, retired on 2026-11-18.
    ["orca.ai.leonsilicon.com", "/"],
    ["watch.ai.leonsilicon.com", "/healthz"],
    ["slack-as-leon.leonsilicon.ai", "/"],
    ["evil.leonsilicon.ai", "/"],
    ["orca.leonsilicon.ai.evil.com", "/"],
    ["x.orca.leonsilicon.ai", "/"],
  ])
    assert.equal(gatewayPath(host!, path!), null, `${host}${path}`);
});

test("the edge forwards method, headers and body to the gateway and streams the answer back", async () => {
  const seen: {
    url: string;
    method: string;
    auth: string | null;
    host: string | null;
    body: string;
  }[] = [];
  const edge = createEdge({
    fetch: async (request) => {
      seen.push({
        url: request.url,
        method: request.method,
        auth: request.headers.get("authorization"),
        host: request.headers.get("x-forwarded-host"),
        body: request.method === "POST" ? await request.text() : "",
      });
      return new Response("event: message\ndata: {}\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  const response = await edge(
    new Request("https://grok.leonsilicon.ai/mcp?a=b", {
      method: "POST",
      headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
      body: '{"jsonrpc":"2.0"}',
    }),
  );
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(await response.text(), "event: message\ndata: {}\n\n");
  assert.deepEqual(seen, [
    {
      url: `${GATEWAY_ORIGIN}/grok?a=b`,
      method: "POST",
      auth: "Bearer t",
      host: "grok.leonsilicon.ai",
      body: '{"jsonrpc":"2.0"}',
    },
  ]);
  assert.equal((await edge(new Request("https://grok.leonsilicon.ai/other"))).status, 404);
  assert.equal(seen.length, 1);
});

test("an unreachable mini is a 502, not an exception", async () => {
  const edge = createEdge({
    fetch: async () => {
      throw new Error("tunnel down");
    },
  });
  const response = await edge(new Request("https://orca.leonsilicon.ai/healthz"));
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "mini_unreachable" });
});
