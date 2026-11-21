# @-apps/gmail-feed

Runs the [Gmail feed](../../packages/ai/leonsilicon/services/gmail-feed/README.md) as the Cloudflare Worker `gmail-feed` (set up 2026-11-19). Every email that reaches Leon's Gmail is copied into Slack: safe ones in `#feed-gmail`, unsafe ones in `#feed-flagged`, spam in `#feed-spam`.

```text
cron (every minute) ─▶ FeedObject (Durable Object, SQLite)
                         │ history.list since the last poll (read-only)
                         ▼
                       Gmail ──▶ screener (OpenAI Decisions) ──▶ Slack, as the Beeper Watch bot
```

## Pieces

| Piece    | Where                                                                                                                                                                                                                                                            |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker   | `gmail-feed`, Custom Domain `gmail-feed.leonsilicon.ai` ([page](../../www/ai/leonsilicon/gmail-feed/index.html)), Durable Object `FeedObject` (one instance, `feed`) holding the queue and state, whose alarm polls every minute; cron `* * * * *` as a backstop |
| Gmail    | Read-only OAuth (`gmail.readonly`): the client and refresh token of the grant Hermes's own Gmail access uses, in Infisical `/gmail-feed`                                                                                                                         |
| Slack    | The Beeper Watch bot (`SLACK_BOT_TOKEN`, Infisical `/beeper-watch`), which creates `#feed-gmail` and is already in the held channels                                                                                                                             |
| Screener | `OPENAI_API_KEY`, shared with Beeper Watch                                                                                                                                                                                                                       |
| Config   | The `#gmail-feed` items of the root [`.env.schema`](../../.env.schema), uploaded as the Worker's vars and secrets on deploy                                                                                                                                      |

## Deploy

A push to `main` deploys it when it changed, like the other Workers ([DEVELOPMENT.md](../../DEVELOPMENT.md#deploying)). By hand:

```sh
vpr -w deploy:gmail-feed
```

## Operating it

The admin endpoints take `Authorization: Bearer $GMAIL_FEED_ADMIN_TOKEN` (Infisical `/gmail-feed`):

```sh
token=$(vpx varlock load --filter '#gmail-feed' --format json | jq -r .GMAIL_FEED_ADMIN_TOKEN)
curl -s -H "authorization: Bearer $token" https://gmail-feed.leonsilicon.ai/admin/status   # counts, last poll, dead letters
curl -s -X POST -H "authorization: Bearer $token" https://gmail-feed.leonsilicon.ai/admin/tick
curl -s -X POST -H "authorization: Bearer $token" -d '{"since":"2026-11-19T00:00:00-05:00"}' \
  https://gmail-feed.leonsilicon.ai/admin/backfill   # copy older mail too, without waking Hermes
```

- **Health.** `https://gmail-feed.leonsilicon.ai/healthz` returns 503 when the last good poll is over 5 minutes old or an email has waited over 30. Logs are in the Worker's observability (`wrangler tail gmail-feed`); they hold message IDs and routes, never mail.
- **Gmail access revoked.** Hermes's own Gmail access stops too. Make a new read-only token for the same OAuth client, put it in Infisical as `GMAIL_FEED_GOOGLE_REFRESH_TOKEN` (and in Hermes's `/opt/data/google_token.json`), and redeploy. The feed catches up from where it stopped, for up to about a week.
- **Quieter or louder.** `GMAIL_FEED_WAKE_THRESHOLD` (0.9) sets how sure the screener must be before an email wakes Hermes; the service README has the numbers behind it. `GMAIL_FEED_WAKE=none` posts everything without waking Hermes. `GMAIL_FEED_SPAM_CHANNEL` sends email spam somewhere other than Beeper's `#feed-spam`.
- **Turn it off.** `wrangler delete gmail-feed`, or remove the cron trigger and deploy.
