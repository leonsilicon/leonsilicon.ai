import assert from "node:assert/strict";
import { test } from "node:test";
import { forward, withServerSection } from "#hermes-thread";

const answer = (body: string, status = 200, type = "application/json") =>
  (async () => new Response(body, { status, headers: { "content-type": type } })) as typeof fetch;

test("forward passes a request on with the token and returns the answer", async () => {
  let seen: { url: string; auth: string | null; body: string } | undefined;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen = {
      url: String(url),
      auth: new Headers(init?.headers).get("authorization"),
      body: String(init?.body),
    };
    return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
  }) as typeof fetch;
  const line = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(await forward(line, "tok", fetchImpl), [
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
  ]);
  assert.equal(seen?.auth, "Bearer tok");
  assert.equal(seen?.body, line);
  assert.equal(seen?.url, "https://slack-puppet.leonsilicon.ai/mcp");
});

test("forward unwraps an event stream, drops keepalives and answers nothing for notifications", async () => {
  const sse = ': keepalive\n\nevent: message\ndata: {"jsonrpc":"2.0","id":7,"result":{}}\n\n';
  assert.deepEqual(
    await forward(
      '{"jsonrpc":"2.0","id":7,"method":"tools/call"}',
      "t",
      answer(sse, 200, "text/event-stream"),
    ),
    ['{"jsonrpc":"2.0","id":7,"result":{}}'],
  );
  assert.deepEqual(
    await forward('{"jsonrpc":"2.0","method":"notifications/initialized"}', "t", answer("", 202)),
    [],
  );
  assert.deepEqual(await forward("not json", "t", answer("{}")), []);
});

test("forward turns failures into JSON-RPC errors for requests", async () => {
  const [refused] = await forward(
    '{"jsonrpc":"2.0","id":3,"method":"tools/list"}',
    "t",
    answer("no", 401),
  );
  assert.match(refused ?? "", /"id":3.*refused the Codex token/);
  const down = (async () => {
    throw new Error("ENOTFOUND");
  }) as typeof fetch;
  const [unreachable] = await forward('{"jsonrpc":"2.0","id":4,"method":"tools/list"}', "t", down);
  assert.match(unreachable ?? "", /unreachable: ENOTFOUND/);
});

test("the Codex config gets one slack-puppet section, replacing an old one and keeping the rest", () => {
  const toml = [
    'model = "gpt"',
    "",
    "[mcp_servers.kernel]",
    'url = "https://mcp.onkernel.com/mcp"',
    "",
    "[mcp_servers.slack-puppet]",
    'command = "old"',
    "",
    "[mcp_servers.slack-puppet.tools.x]",
    "enabled = true",
    "",
    '[projects."/x"]',
    'trust_level = "trusted"',
  ].join("\n");
  const out = withServerSection(
    toml,
    "/usr/local/bin/node",
    "/Users/me/.local/bin/hermes-thread-mcp",
  );
  assert.equal(out.split("[mcp_servers.slack-puppet]").length - 1, 1);
  assert.ok(!out.includes('command = "old"') && !out.includes("slack-puppet.tools.x"));
  assert.ok(out.includes("[mcp_servers.kernel]") && out.includes('[projects."/x"]'));
  assert.match(
    out,
    /command = "\/usr\/local\/bin\/node"\nargs = \["\/Users\/me\/\.local\/bin\/hermes-thread-mcp"\]/,
  );
  assert.match(out, /tool_timeout_sec = 180/);
  assert.equal(
    withServerSection(out, "/usr/local/bin/node", "/Users/me/.local/bin/hermes-thread-mcp"),
    out,
  );
});
