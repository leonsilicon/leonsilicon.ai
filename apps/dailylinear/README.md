# @-apps/dailylinear

Runs [dailylinear](../../packages/ai/leonsilicon/services/dailylinear/README.md) as a Cloudflare Worker (since 2026-11-21): at midnight in Toronto it makes the day's Linear project in team LEON (`20261122`), has Linear's Slack app create its channel `#project-2026-11-22` at once, puts Leon and Hermes in it and stars it in Leon's sidebar. Then it marks the day before Completed in Linear and archives its channel, as it does for every past day's project still open. It replaced Grok Bot's midnight routine and the day-project part of [Linear Sync](../linear-slack-sync/README.md), which now only gets Leon and Hermes into a day's channel and archives it when the project closes. It depends on no machine of Leon's.

```text
alarm (midnight Toronto) ─┐
cron hourly (safety net) ─┼─▶ Worker ─▶ DailyObject (one, named `daily`) ─┬─▶ Linear API: projectsNamed, projectCreate,
POST /admin/run ──────────┘                                               │    projectCreateSlackChannel (Linear's Slack app makes the channel)
                                                                          └─▶ Slack as Leon: rename, join, invite Hermes, stars, sidebar sections
```

One Durable Object runs one day at a time, so the alarm, the cron and a hand-run never overlap, and a day's project can't be made twice. After each run it sets its alarm for the next: a second past midnight, or a minute later while the day's channel is on its way. A failed run is tried again after a minute, doubling up to 15 minutes. The hourly cron runs it too, which does nothing once the day is settled and sets the alarm again should it have been lost.

## Pieces

| Piece  | Where                                                                                                                                                                                                                                                                                                                                               |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker | `dailylinear` in the Cloudflare account that holds the leonsilicon.ai zone; Custom Domain `dailylinear.leonsilicon.ai`, no workers.dev address. Config in [`wrangler.jsonc`](wrangler.jsonc)                                                                                                                                                        |
| State  | Durable Object `DailyObject` (one instance, `daily`): a record per open day's project (its channel, when it was asked for, starred or under Projects), the projects it marked done, the last run's result, and the failure count                                                                                                                    |
| Linear | Linear Sync's personal API key: the day's projects are made as its Linear account (Leon's). Channels come from Linear's own Slack app, which must stay installed in Slack with Project channels on ([why](../../packages/ai/leonsilicon/services/linear-slack-sync/README.md#project-channels))                                                     |
| Config | The `#dailylinear` items of the root [`.env.schema`](../../.env.schema): `DAILYLINEAR_ADMIN_TOKEN` in Infisical under `/dailylinear`; Linear Sync's `LINEAR_API_KEY`, `LINEAR_TEAM_KEY`, `SECTION_ORDER` and `PROJECT_SECTION`; Leon's Slack session and Hermes's Slack user ID from `/shared`. Each deploy uploads them as Worker secrets and vars |
| Page   | [`www/ai/leonsilicon/dailylinear/index.html`](../../www/ai/leonsilicon/dailylinear/index.html), for browsers                                                                                                                                                                                                                                        |

## Deploy

Pushes to `main` deploy it automatically when they change its code ([Deploy workflow](../../.github/workflows/deploy.yml)). By hand:

```sh
vpr -w deploy:dailylinear
```

Deploy it together with Linear Sync whenever either changes how day projects are handled: Linear Sync no longer asks for, names or stars a day's channel, so without dailylinear no day gets one.

Check `curl -s https://dailylinear.leonsilicon.ai/healthz`, which returns `{"ok":true,"session":"ok","linear":"ok","projects":"ok","today":"ready","failures":0}`, or 503. `today` is `waiting` for the few seconds after midnight while the channel is made, `closed` when Leon closed or deleted the day's project, and `not run yet today` if midnight's run hasn't happened. Logs: `vpx wrangler tail dailylinear`.

## Operating it

- **Run it now:** `curl -s -X POST -H "Authorization: Bearer $DAILYLINEAR_ADMIN_TOKEN" https://dailylinear.leonsilicon.ai/admin/run` answers the run's result. `GET /admin/status` with the same token shows the state, the failure count and the last error. The token is in Infisical (`vpx varlock run --filter '#dailylinear' -- sh -c '…'` puts it in the environment).
- **Skip a day:** close or delete that day's project in Linear; dailylinear doesn't make it again.
- **Keep a past day open:** reopen its project in Linear (and unarchive the channel, or let Linear Sync do it). dailylinear marks each past day done once, and leaves one Leon reopens alone.
- **A day without a channel:** `/admin/status` shows when it was asked for. Linear's Slack app makes it; if `projects` in `/healthz` isn't `ok`, Linear is disconnected from Slack. It asks again every 30 minutes.
- **Session expired:** runs fail on Slack calls (the project is still made). Re-copy the session into Infisical's `/shared` folder the way the slack-as-leon README describes, then deploy every Worker that holds it, this one included.

## Security

- It acts as Leon through his Slack web session and makes projects with Linear Sync's personal Linear key, both stored as Worker secrets.
- `/healthz` says only whether things work. `/admin/*` needs the bearer token.
