# @-apps/cronometer

Cronometer's food diary over MCP for Leon's agents, as a Cloudflare Python Worker at `https://cronometer.leonsilicon.ai` (since 2026-11-21). The Grok bots use it: 41 tools that read the diary and add, change and delete entries, custom foods, recipes, notes, biometrics, exercise, fasts and nutrient targets.

Until 2026-11-21 the same server ran on the Mac mini behind the gateway ([`configs/cronometer-mcp-http`](../../packages/com/leonsilicon/ai/configs/cronometer-mcp-http/README.txt)). The address and the bearer token didn't change, so the Grok bots' connector needed nothing.

## What runs

[rollecode/cronometer-mcp](https://github.com/rollecode/cronometer-mcp) (MIT) does the work. It talks to `mobile.cronometer.com`, the API Cronometer's Android app uses, over plain HTTPS with JSON. It is unofficial: a Cronometer app update can break it until upstream catches up.

- **Upstream, unchanged**, is in [`src/cronometer_mcp/`](src/cronometer_mcp): the four source files of v1.11.1 at commit `e123a4721093efa55adac665e10a546c105eb117`, byte for byte, with its licence. That commit was reviewed on 2026-11-06: its only network host is `mobile.cronometer.com`.
  - It is a copy and not a dependency because Cloudflare's Python tooling installs only prebuilt packages, so it can't take a git commit, and the `cronometer-mcp` name on PyPI is a different project by another author.
  - To update: copy the four files from a reviewed upstream commit, read the diff (search it for new hosts), change the commit above, and deploy.
- **[`src/entry.py`](src/entry.py)** is ours. It adds:
  - the bearer token on every MCP request (401 otherwise), and a Host check for `cronometer.leonsilicon.ai`;
  - the Cronometer login, from the Worker's secrets into the environment variables upstream reads;
  - the session key, kept in KV (`SESSION`) between requests. Upstream caches it in a file; a Worker's files last only as long as one instance, and Cronometer throttles repeated logins. An instance that finds a newer key in KV takes it instead of signing in;
  - the page in `www/` for a browser, as `@-/com.leonsilicon.www` does for the TypeScript Workers.
- **Stateless.** Each request gets its own MCP session manager and a JSON answer (no event stream).

`POST /` and `POST /mcp` are the MCP endpoint. `GET /healthz` answers without a token and says only that the Worker is up.

## Things Python Workers needed

Found by trying it on 2026-11-21:

- **Import upstream at the top of `entry.py`.** Cloudflare runs the entry module once at deploy and snapshots its memory, so what is imported at the top is already loaded when a new instance starts. Imported on the first request instead, upstream and the MCP SDK cost every new instance 5 to 9 s. Now a new instance answers in 1.4 to 2 s and a warm one in 0.2 to 0.35 s.
- **`tzdata` as a dependency.** Upstream works in the account's time zone, and Python has no time zone data of its own here; without it the diary tools fail with `ZoneInfoNotFoundError`.
- **One session manager per request.** The Worker's ASGI adapter starts the app's lifespan on every request, and this MCP SDK's session manager can run only once.
- **Blocking HTTP works.** Upstream's `httpx.Client` and its plain (not `async`) tool functions run as they are.
- **Size.** 19.5 MB of Python packages, 5.3 MB compressed: under the 10 MB limit of the paid plan, over the free plan's.
- **The compatibility date** is the newest the repo's Wrangler supports, not today's.

## Pieces

| Piece    | Where                                                                                                                                                                                  |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker   | `cronometer`, config in [`wrangler.jsonc`](wrangler.jsonc); Custom Domain `cronometer.leonsilicon.ai`, no workers.dev address                                                          |
| Packages | [`pyproject.toml`](pyproject.toml) and `uv.lock`: `mcp` (below 2), `httpx`, `tzdata`. `pywrangler sync` puts them in `python_modules/` (not committed)                                 |
| Session  | KV namespace `cronometer-session` (`52aae9cdc5ff4f15b1e0b29f67c98d6a`), key `session`                                                                                                  |
| Secrets  | The `#cronometer` items of the root [`.env.schema`](../../.env.schema), values in Infisical under `/cronometer`: `CRONOMETER_HTTP_TOKEN`, `CRONOMETER_USERNAME`, `CRONOMETER_PASSWORD` |
| Page     | [`www/ai/leonsilicon/cronometer/index.html`](../../www/ai/leonsilicon/cronometer/index.html), from the Worker's static assets                                                          |

## Deploy

Pushes to `main` deploy it automatically when they change it ([Deploy workflow](../../.github/workflows/deploy.yml)). By hand:

```sh
vpr -w deploy:cronometer
```

It builds `www/`, gathers the Python packages (`uv run pywrangler sync`, which needs uv 0.13.4 or newer) and runs `varlock-wrangler deploy`, which uploads the vars and secrets too.

Check, from somewhere that can reach the hostname:

```sh
curl -s https://cronometer.leonsilicon.ai/healthz
curl -s -X POST https://cronometer.leonsilicon.ai/mcp \
  -H "authorization: Bearer $CRONOMETER_HTTP_TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_profile","arguments":{}}}'
```

Locally, `uv run pywrangler dev` in this directory with a `.dev.vars` file holding the four values. Wrangler gives the local server the Custom Domain's hostname, so `CRONOMETER_HTTP_PUBLIC_HOST` stays `cronometer.leonsilicon.ai` there.

## Operating it

- **Rotate the token.** A new `openssl rand -hex 32` as `CRONOMETER_HTTP_TOKEN` in Infisical, deploy, then have a Grok bot ask for `CRONOMETER_MCP_TOKEN` again through its secure field and restart its connector.
- **Change the login.** Update `CRONOMETER_USERNAME` and `CRONOMETER_PASSWORD` in Infisical and deploy. Upstream ties the saved session to the username, so a new account signs in afresh.
- **Force a new sign-in.** `vpx wrangler kv key delete session --namespace-id 52aae9cdc5ff4f15b1e0b29f67c98d6a --remote`. Don't do it often: Cronometer throttles logins and can lock the account for a while.
- **Turn it off.** `vpx wrangler delete --config apps/cronometer/wrangler.jsonc`.

## Verified (2026-11-21)

- A throwaway copy on a workers.dev address first, with the real login: the 41 tools listed; `get_profile`, `get_food_log` for the day and `search_foods` answered; the session key in KV stayed the same across the calls.
- Then on `cronometer.leonsilicon.ai`, called from the Mac mini with the token there: health, 401 without a token, the browser page, 41 tools, `get_profile` and `get_food_log`, again with no new sign-in.
- The mini's `com.leonsilicon.cronometer-mcp-http` was then stopped and disabled, and the throwaway copy deleted.
