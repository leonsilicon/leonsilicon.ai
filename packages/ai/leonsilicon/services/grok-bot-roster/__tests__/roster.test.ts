import assert from "node:assert/strict";
import { test } from "node:test";
import { GrokBotApi, jwtExpiryMs, memorySessionStore } from "#api";
import { loadConfig } from "#config";
import { createHandler } from "#mcp";
import { Refused, Roster, type ApiBot } from "#roster";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 21);

/** A JWT-shaped token that expires `days` from NOW (the signature isn't checked here). */
function token(days: number, tag = "a"): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor((NOW + days * DAY) / 1000), tag }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
}

const bot = (id: string, name: string, extra: Partial<ApiBot> = {}): ApiBot => ({
  id,
  agentId: `uuid-${id}`,
  name,
  createdAtMs: String(NOW - DAY),
  kind: "GROK_BOT_AGENT_KIND_AGENT",
  viewerIsOwner: true,
  sharedWithOthers: false,
  ...extra,
});

/** A tiny GrokBotService: the bots, the calls made, and an optional refresh behaviour. */
function fakeBackend(
  bots: ApiBot[],
  options: { acceptTokens?: Set<string>; refreshTo?: string; refreshAccepts?: Set<string> } = {},
) {
  const calls: { path: string; body: Record<string, unknown>; auth: string | null }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ path: url.pathname, body, auth });
    if (url.pathname === "/oauth/token") {
      const ok =
        options.refreshTo &&
        (!options.refreshAccepts || options.refreshAccepts.has(String(body.refresh_token)));
      return ok
        ? Response.json({ access_token: options.refreshTo, id_token: "x", shouldLogout: false })
        : Response.json({ error: "invalid_grant" }, { status: 401 });
    }
    if (options.acceptTokens && !options.acceptTokens.has((auth ?? "").slice(7)))
      return Response.json({ code: "unauthenticated", message: "no" }, { status: 401 });
    const method = url.pathname.split("/").pop();
    if (method === "ListGrokBotAgents") return Response.json({ agents: bots });
    if (method === "DeleteGrokBotAgent") {
      const index = bots.findIndex((b) => b.id === body.id);
      if (index < 0)
        return Response.json({ code: "not_found", message: "no bot" }, { status: 404 });
      bots.splice(index, 1);
      return Response.json({});
    }
    return Response.json({ code: "unimplemented", message: method }, { status: 404 });
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

function setup(bots: ApiBot[]) {
  const backend = fakeBackend(bots);
  const store = memorySessionStore({ accessToken: token(50), refreshToken: token(50) });
  const api = new GrokBotApi(store, { fetch: backend.fetch, now: () => NOW });
  const logs: unknown[] = [];
  const roster = new Roster(api, { log: (event, fields) => logs.push({ event, ...fields }) });
  return { backend, api, roster, logs };
}

test("the list gives each bot's IDs, name and creation time", async () => {
  const { roster } = setup([bot("1", "Grok Bot"), bot("3", "Helper 1")]);
  assert.deepEqual(await roster.list(), [
    {
      id: "1",
      agent_id: "uuid-1",
      name: "Grok Bot",
      created_at: new Date(NOW - DAY).toISOString(),
    },
    {
      id: "3",
      agent_id: "uuid-3",
      name: "Helper 1",
      created_at: new Date(NOW - DAY).toISOString(),
    },
  ]);
});

test("any bot is deleted by its ID or agent ID alone, Leon's own included", async () => {
  const bots = [
    bot("1", "Grok Bot"),
    bot("2", "Pine Bot", { sharedWithOthers: true }),
    bot("3", "Helper 1"),
    bot("4", "Team bot", { kind: "GROK_BOT_AGENT_KIND_TEAM" }),
  ];
  const { roster, backend, logs } = setup(bots);
  assert.equal((await roster.delete({ bot: "1" })).deleted.name, "Grok Bot");
  await roster.delete({ bot: "uuid-2" });
  await roster.delete({ bot: "3" });
  await roster.delete({ bot: "4" });
  assert.equal(bots.length, 0);
  const deletes = backend.calls.filter((c) => c.path.endsWith("/DeleteGrokBotAgent"));
  assert.deepEqual(
    deletes.map((c) => c.body),
    [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }],
    "the API always gets the numeric ID",
  );
  assert.equal(logs.length, 4);
});

test("there is no hourly limit", async () => {
  const bots = Array.from({ length: 30 }, (_, i) => bot(String(100 + i), `Bot ${i}`));
  const { roster } = setup(bots);
  for (let i = 0; i < 30; i++) await roster.delete({ bot: String(100 + i) });
  assert.equal(bots.length, 0);
});

test("nothing is deleted for an unknown or empty ID", async () => {
  const bots = [bot("3", "Helper 1")];
  const { roster, backend } = setup(bots);
  await assert.rejects(roster.delete({ bot: "99" }), /No bot has the ID/);
  await assert.rejects(roster.delete({ bot: "" }), Refused);
  assert.equal(bots.length, 1);
  assert.ok(!backend.calls.some((c) => c.path.endsWith("/DeleteGrokBotAgent")));
});

test("a session near its expiry is refreshed first, and the new token is stored", async () => {
  const fresh = token(60, "fresh");
  const backend = fakeBackend([bot("3", "Helper 1")], {
    acceptTokens: new Set([fresh]),
    refreshTo: fresh,
  });
  const store = memorySessionStore({ accessToken: token(5), refreshToken: token(5) });
  const api = new GrokBotApi(store, { fetch: backend.fetch, now: () => NOW });
  await api.call("ListGrokBotAgents", {});
  assert.equal(store.value?.accessToken, fresh);
  assert.equal(store.value?.refreshToken, fresh, "the newest token refreshes next time");
  assert.equal(backend.calls[0]?.path, "/oauth/token");
  assert.equal(backend.calls[0]?.body.client_id, "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB");
  assert.equal(backend.calls[1]?.auth, `Bearer ${fresh}`);
  assert.equal(await api.ensureFresh(), jwtExpiryMs(fresh));
});

test("a 401 refreshes once and retries; a refresh that fails says to sign in again", async () => {
  const old = token(50, "old");
  const fresh = token(60, "fresh");
  const backend = fakeBackend([], { acceptTokens: new Set([fresh]), refreshTo: fresh });
  const store = memorySessionStore({ accessToken: old, refreshToken: old });
  const api = new GrokBotApi(store, { fetch: backend.fetch, now: () => NOW });
  await api.call("ListGrokBotAgents", {});
  assert.equal(store.value?.accessToken, fresh);

  const dead = fakeBackend([], { acceptTokens: new Set(["nothing"]) });
  const deadApi = new GrokBotApi(memorySessionStore({ accessToken: old, refreshToken: old }), {
    fetch: dead.fetch,
    now: () => NOW,
  });
  await assert.rejects(deadApi.call("ListGrokBotAgents", {}), /sign in again/);
  assert.equal(await deadApi.sessionState(), "signed_out");
});

test("the refresh falls back to the newest access token when the refresh token is refused", async () => {
  const access = token(5, "access");
  const fresh = token(60, "fresh");
  const backend = fakeBackend([], {
    refreshTo: fresh,
    refreshAccepts: new Set([access]),
  });
  const store = memorySessionStore({ accessToken: access, refreshToken: token(-1, "expired") });
  const api = new GrokBotApi(store, { fetch: backend.fetch, now: () => NOW });
  await api.call("ListGrokBotAgents", {});
  assert.equal(store.value?.accessToken, fresh);
  assert.equal(backend.calls.filter((c) => c.path === "/oauth/token").length, 2);
});

test("config needs a strong token", () => {
  const config = loadConfig({ GROK_BOT_ROSTER_MCP_TOKEN: "t".repeat(40) });
  assert.equal(config.publicOrigin, "https://grokbot-admin.leonsilicon.ai");
  assert.throws(() => loadConfig({ GROK_BOT_ROSTER_MCP_TOKEN: "short" }), /strong token/);
});

test("the MCP endpoint needs the token, lists tools and explains a refusal", async () => {
  const bots = [bot("1", "Grok Bot"), bot("3", "Helper 1")];
  const { roster, api } = setup(bots);
  const handler = createHandler(
    { token: "t".repeat(40), publicOrigin: "https://grokbot-admin.leonsilicon.ai" },
    roster,
    api,
  );
  const rpc = (body: unknown, auth = `Bearer ${"t".repeat(40)}`) =>
    handler(
      new Request("https://grokbot-admin.leonsilicon.ai/mcp", {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  assert.equal(
    (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "Bearer nope")).status,
    401,
  );
  const init = (await (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize" })).json()) as {
    result: { serverInfo: { name: string }; instructions: string };
  };
  assert.equal(init.result.serverInfo.name, "grokbot-admin");
  assert.match(init.result.instructions, /permanent/);
  const tools = (await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as {
    result: { tools: { name: string }[] };
  };
  assert.deepEqual(
    tools.result.tools.map((t) => t.name),
    ["grok_bots_list", "grok_bot_delete"],
  );
  const refused = (await (
    await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "grok_bot_delete", arguments: { bot: "nope" } },
    })
  ).json()) as { result: { isError: boolean; content: { text: string }[] } };
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0]?.text ?? "", /No bot has the ID/);
  const deleted = (await (
    await rpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "grok_bot_delete", arguments: { bot: "uuid-3" } },
    })
  ).json()) as { result: { isError: boolean } };
  assert.equal(deleted.result.isError, false);
  assert.deepEqual(
    bots.map((b) => b.name),
    ["Grok Bot"],
  );
  const health = await handler(new Request("https://grokbot-admin.leonsilicon.ai/healthz"));
  assert.equal(health.status, 200);
});
