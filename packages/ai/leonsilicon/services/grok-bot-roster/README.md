# @-/ai.leonsilicon.services.grok-bot-roster

An MCP server that lets Leon's Grok Bot bots list his bots and delete any of them. The Grok Bot app gives bots tools to create, rename and message bots, but not to delete one: only Leon can, by right-clicking it in the sidebar. So a bot that spins up a helper for one task (to work in parallel, or to answer in one place) had no way to clean up, and the roster fills toward its limit of about 50 bots. It is served as `grokbot-admin.leonsilicon.ai` (named `grokbot-admin` in Grok Bot) and runs as a Cloudflare Worker; the package, app and Worker kept their first name, grok-bot-roster. Deployment is in [`apps/grok-bot-roster`](../../../../../apps/grok-bot-roster/README.md).

## How it reaches Grok Bot

Grok Bot's backend is Cursor's `aiserver.v1.GrokBotService`, a Connect RPC API on `api2.cursor.sh` that also takes JSON. The desktop app deletes a bot with `DeleteGrokBotAgent {id}` and lists them with `ListGrokBotAgents {}`; this server makes the same two calls (`api.ts`), with the headers the app sends (`x-cursor-client-type: sand`).

It signs in as Leon with a session of its own, made with Cursor's CLI sign-in (`cursor.com/loginDeepControl`, then `api2.cursor.sh/auth/poll`), not the desktop app's. So it can be signed out on its own, and its refreshes never touch the app's session. A session token lasts 60 days. `POST /oauth/token` with Cursor's public client ID returns a new 60-day token and no new refresh token, and the newest token works as the next refresh token (checked 2026-11-21). The Worker refreshes once less than 30 days are left, on any call and in a daily cron, so it stays signed in without anyone.

## Tools

| Tool              | Does                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grok_bots_list`  | Every bot: `id` (numeric, what the API takes), `agent_id` (the UUID a bot sees as its own ID), `name` and `created_at`.                                  |
| `grok_bot_delete` | Deletes one bot, by `bot` (its ID or agent ID) alone. Deleting erases its profile, conversations, memory, routines and attachments, and can't be undone. |

A refused call comes back as `{ ok: false, refused }` with a message written for the bot that asked.

## Which bots can be deleted

Any of them, Leon's own bots and the calling bot included, as often as asked (Leon's decision, 2026-11-21; the first version allowed only bots named "Helper …" or "Reply …", never his 14 original bots, at most 20 an hour). The ID alone is enough; a version that also asked for the bot's exact name lasted under an hour. Deleting is permanent and the API has no restore call. An ID that isn't one of Leon's bots is refused, and Grok Bot's backend decides the rest (it refuses a bot Leon may not delete).

Each deletion is logged with the bot's ID and name (Workers observability).

## Where Grok Bot gets it

It is in Leon's account-wide MCP config, which every bot uses, as `grokbot-admin` with the URL `https://grokbot-admin.leonsilicon.ai/mcp` and an `Authorization: Bearer …` header. That config is `DashboardService/GetMcpConfig` and `SetMcpConfig` on the same API. The app edits it by reading it with secrets redacted and saving it back with one change, the server keeping the redacted values; the entry was added the same way on 2026-11-21 (as `grok-bot-roster`, renamed the same day with `serverRenames`), and the other servers' headers were checked afterwards.

## Waking the cloud computer

`POST /sandbox/ensure` with the same bearer token calls `GrokBotService/EnsureSandBox`, as the desktop app does, and answers only `{ runState }`. Grok Bot pauses Leon's cloud computer when no bot is running; [grok-box-browser](../../../../../apps/hermes-plugin-grok-box-browser/README.md) calls this so Hermes's Chrome in that machine answers. The descriptor's gateway, VNC and port tokens stay in the Worker.

## API

- `GrokBotApi(store, options?)`: `call(method, body)`, `ensureFresh()`, `sessionState()` (`ok`, `signed_out` or `unknown`). A `SessionStore` holds `{ accessToken, refreshToken }`; `memorySessionStore()` is the in-memory one.
- `Roster(api, options?)`: `list()`, `delete({ bot })`.
- `createHandler(config, roster, api)`: stateless MCP over Streamable HTTP as a `(Request) => Promise<Response>`. `POST /` or `/mcp` needs the bearer token; `GET /healthz` answers 503 when the sign-in is gone.
- `loadConfig(env)`, `TOOLS`, `instructions`, `jwtExpiryMs(token)`.

## Test

```sh
node --test packages/ai/leonsilicon/services/grok-bot-roster/__tests__/*.test.ts
```

Offline, with a fake GrokBotService: the list, deleting any bot by ID or agent ID, no hourly limit, refusals that delete nothing, refreshing near expiry and after a 401, the fallback to the newest token, and the MCP endpoint.
