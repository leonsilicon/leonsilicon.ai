# @-apps/gmail2slack

Runs the [Gmail2Slack](../../packages/ai/leonsilicon/services/gmail2slack/README.md) on the existing Cloudflare Worker. Every email that reaches Leon's Gmail is copied into Slack: safe ones in `#feed-gmail`, unsafe ones in `#feed-flagged`, spam in `#feed-spam`.

```text
Gmail watch ─▶ Pub/Sub ─▶ Gmail2Slack webhook ─▶ FeedObject (SQLite)
                                                     │ Gmail history and message reads
                                                     ▼
                                               screener ─▶ Slack
```

## Pieces

| Piece    | Where                                                                                                                                                                                                                                                 |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker   | `gmail-feed`, Custom Domain `gmail2slack.leonsilicon.ai` ([page](../../www/ai/leonsilicon/gmail2slack/index.html)), Durable Object `FeedObject` (one instance, `feed`) holding the queue and state. Its alarm renews the watch and runs work when due |
| Gmail    | Read-only OAuth (`gmail.readonly`): the client and refresh token of the grant Hermes's own Gmail access uses, in Infisical `/gmail-feed`                                                                                                              |
| Slack    | The existing feed bot (`SLACK_BOT_TOKEN`, Infisical `/gmail-feed`), which creates `#feed-gmail` and belongs to the held channels                                                                                                                      |
| Screener | `OPENAI_API_KEY`, Infisical `/gmail-feed`                                                                                                                                                                                                             |
| Config   | The `#gmail2slack` items of the root [`.env.schema`](../../.env.schema), uploaded as the Worker's vars and secrets on deploy                                                                                                                          |

The deployed script ID `gmail-feed` keeps the existing Durable Object, Gmail history cursor and delivery queue. The Infisical folder `/gmail-feed` and the `GMAIL_FEED_*` keys are the existing credential and configuration references.

## Deploy

A push to `main` deploys it when it changed, like the other Workers ([DEVELOPMENT.md](../../DEVELOPMENT.md#deploying)). By hand:

```sh
vpr -w deploy:gmail2slack
```

## Gmail push setup

1. In the Google Cloud project that owns the Gmail OAuth client, enable Pub/Sub and create a topic. Grant `gmail-api-push@system.gserviceaccount.com` the Pub/Sub Publisher role on that topic.
2. Create a push subscription to `https://gmail2slack.leonsilicon.ai/webhooks/gmail`. Enable authentication with a dedicated service account and use the exact endpoint URL as the token audience. Give the Pub/Sub service agent permission to mint tokens for that service account and set the subscription to never expire.
3. Store the full topic name as `GMAIL_FEED_PUBSUB_TOPIC` and the push service account email as `GMAIL_FEED_PUBSUB_SERVICE_ACCOUNT` in Infisical under `/gmail-feed`. Deploy the Worker. The existing read-only Gmail grant can register the watch.
4. Check that `/admin/status` reports `mode: "push"` and a future `watchExpiresAt`. The first authenticated notification confirms the subscription. Until it arrives, the existing history polling continues.

See [Gmail push notifications](https://developers.google.com/workspace/gmail/api/guides/push) and [Pub/Sub push authentication](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions).

## Operating it

The admin endpoints take `Authorization: Bearer $GMAIL_FEED_ADMIN_TOKEN` (Infisical `/gmail-feed`):

```sh
token=$(vpx varlock load --filter '#gmail2slack' --format json | jq -r .GMAIL_FEED_ADMIN_TOKEN)
curl -s -H "authorization: Bearer $token" https://gmail2slack.leonsilicon.ai/admin/status   # watch, delivery counts, dead letters
curl -s -X POST -H "authorization: Bearer $token" https://gmail2slack.leonsilicon.ai/admin/tick
curl -s -X POST -H "authorization: Bearer $token" -d '{"since":"2026-11-19T00:00:00-05:00"}' \
  https://gmail2slack.leonsilicon.ai/admin/backfill   # copy older mail too, without waking Hermes
```

- **Health.** `https://gmail2slack.leonsilicon.ai/healthz` returns 503 when the watch has expired, a known Gmail change has waited over five minutes, or a delivery has waited over 30 minutes. During setup it checks polling freshness. Logs are in the Worker's observability (`wrangler tail gmail-feed`); they hold message IDs and routes, never mail.
- **Gmail access revoked.** Hermes's own Gmail access stops too. Make a new read-only token for the same OAuth client, put it in Infisical as `GMAIL_FEED_GOOGLE_REFRESH_TOKEN` (and in Hermes's `/opt/data/google_token.json`), and redeploy. The feed catches up from where it stopped, for up to about a week.
- **Quieter or louder.** `GMAIL_FEED_WAKE_THRESHOLD` (0.9) sets how sure the screener must be before an email wakes Hermes; the service README has the numbers behind it. `GMAIL_FEED_WAKE=none` posts everything without waking Hermes. `GMAIL_FEED_SPAM_CHANNEL` sends email spam to a custom channel in place of `#feed-spam`.
