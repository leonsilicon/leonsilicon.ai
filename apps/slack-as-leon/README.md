# @-apps/slack-as-leon

Runs [slack-as-leon](../../packages/ai/leonsilicon/services/slack-as-leon/README.md), served as `slack-puppet.leonsilicon.ai`, as a Cloudflare Worker (since 2026-11-13; it ran on the Mac mini for an hour before that). Hermes Cloud (Captain Claude) uses it to post in Slack as Leon with no bot marker, so the Grok Bot bots answer. It depends on no machine of Leon's.

```text
Hermes Cloud ──▶ slack-puppet.leonsilicon.ai ──▶ Worker "slack-as-leon" ──▶ Slack Web API as Leon (xoxc + d cookie)
     ▲                                                                              │
     └──── slack-as-leon-guard drops Slack's echo of the post (marked client_msg_id) ◀┘
```

This is a Worker of its own, like every `*.leonsilicon.ai` service since 2026-11-21. Until then the others ran on the Mac mini behind an edge Worker. Its Custom Domain has its own certificate, which a two-level name needs.

## Pieces

| Piece  | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Worker | `slack-as-leon` in the Cloudflare account that holds the leonsilicon.ai zone; Custom Domain `slack-puppet.leonsilicon.ai` since 2026-11-19, the precise term for posting as a real user, from chat bridges' "double puppeting". The old `slack-as-leon.leonsilicon.ai` stays as a second route until 2026-11-26 (it was `ai.leonsilicon.com/slack-as-leon` until 2026-11-13, then `slack-as-leon.ai.leonsilicon.com` until 2026-11-18); no workers.dev address. Config in [`wrangler.jsonc`](wrangler.jsonc) |
| Page   | [`www/ai/leonsilicon/slack-puppet/index.html`](../../www/ai/leonsilicon/slack-puppet/index.html) for browsers (the old host's page says it moved); built into `dist/www` and uploaded as the Worker's assets (`ASSETS`)                                                                                                                                                                                                                                                                                      |
| Config | The `#slack-as-leon` items of the root [`.env.schema`](../../.env.schema), values in Infisical under `/slack-as-leon`: `SLACK_SESSION_TOKEN` and `SLACK_SESSION_COOKIE` (Leon's Slack web session, copied 2026-11-13 from the MacBook's Neko profile `hermes-slack-app`; the `d` cookie expires 2027-12), `SLACK_AS_LEON_MCP_TOKEN` (the bearer token, rotated 2026-11-18 when it moved to Infisical) and `SLACK_AS_LEON_BLOCKED_USERS`. Each deploy uploads them as Worker secrets and vars                 |
| State  | KV namespace `slack-as-leon-rate`: one key per post, expiring after about an hour, for the hourly limit. Nothing else is stored                                                                                                                                                                                                                                                                                                                                                                              |
| Hermes | Captain Claude's `slack-puppet` MCP server (named `slack-as-leon` until 2026-11-19), so its tools appear as `mcp__slack_puppet__…`, `Authorization: Bearer ${SLACK_AS_LEON_MCP_TOKEN}` (value in `/opt/data/.env`), plus the [`slack-as-leon-guard`](../../packages/com/leonsilicon/hermes/plugins/slack-as-leon-guard/README.md) plugin                                                                                                                                                                     |

## Deploy

Pushes to `main` deploy it automatically when they change its code ([Deploy workflow](../../.github/workflows/deploy.yml), after CI's checks). By hand:

```sh
vpr -w deploy:slack-as-leon
```

It typechecks and builds `www/` first, then deploys with `varlock-wrangler`, which resolves the `#slack-as-leon` items (the filter is set in this app's `package.json`) and uploads them. A deploy replaces every var and secret the Worker had, so a value set with `wrangler secret put` lasts only until the next deploy: change values in Infisical instead. It needs Infisical access (see [DEVELOPMENT.md](../../DEVELOPMENT.md#secrets-and-config)).

Check: `curl -s https://slack-puppet.leonsilicon.ai/healthz` (`"session":"ok"`; 503 means the session is dead). Logs: `vpx wrangler tail --config apps/slack-as-leon/wrangler.jsonc`; each post logs one `sent` line with its length, never the text.

## Operating it

- **Session expired** (`/healthz` 503, or Hermes reports `invalid_auth`). Sign in to Slack in a Neko profile, then put `localStorage.localConfig_v2.teams.<workspace ID>.token` and the `.slack.com` `d` cookie into Infisical as `SLACK_SESSION_TOKEN` and `SLACK_SESSION_COOKIE` without printing them, and deploy. Signing out of that browser session kills it.
- **Rotate the MCP token.** Put a new `openssl rand -hex 32` in Infisical as `SLACK_AS_LEON_MCP_TOKEN` and deploy, then set the same value on Captain Claude (dashboard `PUT /api/env`) and restart its gateway when no agents are active.
- **Allow Silicon Dot, or block someone else.** Change `SLACK_AS_LEON_BLOCKED_USERS` in Infisical (comma-separated user IDs; empty allows everyone) and deploy.
- **Turn it off.** `vpx wrangler delete --config apps/slack-as-leon/wrangler.jsonc`. To kill the session itself, sign out of that Slack browser session (Slack → profile → Sign out, or "Sign out of all other sessions").
- **Security.** The `xoxc` token and `d` cookie are a full Slack login as Leon, kept in Infisical and stored as Cloudflare Worker secrets: Infisical and Cloudflare can read them, Hermes can't. Through this Worker Hermes can post as Leon anywhere he can, and read only the answers to its own posts. Bots and people can't tell those posts from Leon's own, which is the point.
