# @-apps/grok-bot-roster

Runs the [Grok Bot admin](../../packages/ai/leonsilicon/services/grok-bot-roster/README.md) as a Cloudflare Worker at `https://grokbot-admin.leonsilicon.ai` (live since 2026-11-21; it was `grok-bot-roster.leonsilicon.ai` for its first hours). Leon's Grok Bot bots reach it as the `grokbot-admin` server in his account-wide MCP config.

| Setting      | Where                                                                                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vars/secrets | `#grok-bot-roster` in the root `.env.schema`; the bearer token is in Infisical `/grok-bot-roster`                                                                       |
| Sign-in      | KV `STATE`, key `session` (`{ accessToken, refreshToken }`). The Worker rewrites it on each refresh; it isn't in Infisical, because a deploy would put the old one back |
| Cron         | `17 9 * * *`: refreshes the sign-in once it has less than 30 days left                                                                                                  |

## Deploy

Automatic on push to `main`; by hand `vpr -w deploy:grok-bot-roster` (typecheck, build, then `varlock-wrangler deploy`, which uploads the `#grok-bot-roster` items).

## Health

`GET /healthz` answers `{ session: "ok" }`, or 503 with `signed_out` when the sign-in has expired or was revoked. Hermes, or a bot, gets the same news as a tool error.

## Signing in again

Only needed if `/healthz` says `signed_out` (Leon signed out every Cursor session, or the cron stopped for 60 days).

1. Make a PKCE pair: a random `verifier` (base64url of 32 bytes), `challenge` = base64url(SHA-256(verifier)), and a random UUID.
2. Open `https://cursor.com/loginDeepControl?challenge=<challenge>&uuid=<uuid>&mode=login&redirectTarget=cli` in Neko `gws-domains` (signed in to Google as leon@leonsilicon.com): Continue to sign in → Continue with Google → leon@leonsilicon.com → Sign in. It asked for no password or code on 2026-11-21.
3. Poll `https://api2.cursor.sh/auth/poll?uuid=<uuid>&verifier=<verifier>` until it answers 200 with `accessToken` and `refreshToken`.
4. Write them to KV without printing them: `vpx wrangler kv key put session --namespace-id d3d601cd3e194d688510d90f77c1daf0 --remote --path <file with {"accessToken","refreshToken"}>`.

To revoke it, sign that session out in Cursor's dashboard, or delete the `session` key.
