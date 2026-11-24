# @-apps/slack22linear

The `22` in slack22linear stands for two-way sync between Slack and Linear.

Runs [slack22linear](../../packages/ai/leonsilicon/services/slack22linear/README.md) as a Cloudflare Worker (since 2026-11-18). It keeps one Slack channel per Linear issue in team LEON, files each channel in Leon's sidebar section named exactly after its status, and mirrors comments both ways. Since 2026-11-19 it also gives every open project a channel connected through Linear's own Slack app, filed under Projects; the day's project and its channel (`project-YYYY-MM-DD`, in Starred) are [dailylinear](../dailylinear/README.md)'s since 2026-11-21. Since 2026-11-21 it also takes over the channels [autolinear](../autolinear/README.md) opens for the issues it makes from Leon's Slack messages ([autolinear](#autolinear)). It depends on no machine of Leon's.

```text
Linear (webhook: Issue, Comment, Project) ──┐                       ┌──▶ Slack Web API as the slack22linear bot (channels, posts)
Slack Events (message.*, reaction_added) ───┼─▶ Worker ─▶ SyncObject ┤
autolinear (SyncObject /adopt binding) ─────┘   (verify)  (SQLite    ├──▶ Slack as Leon's web session (sidebar sections, invites,
cron daily ─────────────────────────────────────────────▶  queue)    │     invites to autolinear's channels)
                                                                     └──▶ Linear API (issues, comments, status moves, project channels)
```

The Worker only verifies and queues. One Durable Object, `SyncObject`, drains a SQLite queue on an alarm, one job at a time. That serializes everything, so two events about one issue can't both create a channel. Failures retry with backoff (30 s, doubling); after six attempts a job moves to `dead`. Timers are delayed jobs in the same queue (an issue's next start, stop or due time), so the alarm wakes the Worker when a time comes; nothing polls. The daily cron (08:00 UTC) is only a safety net ([Times](../../packages/ai/leonsilicon/services/slack22linear/README.md#times)).

## Pieces

| Piece              | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker             | `linear-slack-sync` in the Cloudflare account that holds the leonsilicon.ai zone; Custom Domain `linear-slack.leonsilicon.ai`, no workers.dev address. Config in [`wrangler.jsonc`](wrangler.jsonc)                                                                                                                                                                                                                                                                                                                                                                                         |
| State              | Durable Object `SyncObject` (SQLite-backed, one instance named `sync`): issue ↔ channel and comment ↔ message maps, a name cache, the queue                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Slack app          | **slack22linear**, with its own bot user, created 2026-11-18 through `apps.manifest.create` with Leon's session. Bot scopes: channels/groups history, read, manage/write, join, chat:write(.customize), users:read, reactions:read (added 2026-11-19). Events: `message.channels`, `message.groups` and `reaction_added` to `/slack/events`                                                                                                                                                                                                                                                 |
| Linear             | Webhook "Linear Sync (Slack)" (team LEON, Issue + Comment + Project) to `/linear/webhook`. Personal API key "Linear Sync (Slack)" on Leon's account (named Hermes in Linear), created through `apiKeyCreate`; the key was generated locally and piped straight into the secret                                                                                                                                                                                                                                                                                                              |
| Linear's Slack app | Linear's own Slack integration, connected by Leon on 2026-11-19, with Project channels and "Automatically create channel for new projects" on, prefix `project-`. It creates and owns the `project-…` project channels. Don't uninstall Linear from Slack: the 2026-11-19 app cleanup did, and project channels stopped until it was reconnected; the sync asks it to through `projectCreateSlackChannel` ([why](../../packages/ai/leonsilicon/services/slack22linear/README.md#project-channels))                                                                                          |
| Config             | The `#slack22linear` items of the root [`.env.schema`](../../.env.schema), values in Infisical under `/linear-slack-sync`: `LINEAR_API_KEY`, `LINEAR_WEBHOOK_SECRET`, `LINEAR_SYNC_SLACK_BOT_TOKEN`, `LINEAR_SYNC_SLACK_SIGNING_SECRET`, and `LINEAR_SYNC_ADMIN_TOKEN`, plus Leon's Slack web session and both Slack user IDs from `/shared` (the same login slack-as-leon holds), and the Autolinear bot's token and user ID from `/autolinear` (`AUTOLINEAR_SLACK_BOT_TOKEN`, `AUTOLINEAR_BOT_USER_ID`), which it posts reminders as. Each deploy uploads them as Worker secrets and vars |
| Page               | [`www/ai/leonsilicon/linear-slack/index.html`](../../www/ai/leonsilicon/linear-slack/index.html), for browsers; built into `dist/www` and uploaded as the Worker's assets (`ASSETS`)                                                                                                                                                                                                                                                                                                                                                                                                        |

## Deploy

The deploy task targets the existing Cloudflare script `linear-slack-sync` to keep `SyncObject`'s queue and mappings. Its custom domain serves the registered webhook URLs.

Pushes to `main` deploy it automatically when they change its code ([Deploy workflow](../../.github/workflows/deploy.yml), after CI's checks). By hand:

```sh
vpr -w deploy:slack22linear
```

It typechecks and builds `www/` first, then deploys with `varlock-wrangler`, which resolves the `#slack22linear` items (the filter is set in this app's `package.json`) and uploads them, replacing every var and secret the Worker had. Change values in Infisical, not with `wrangler secret put`. It needs Infisical access (see [DEVELOPMENT.md](../../DEVELOPMENT.md#secrets-and-config)).

Check `curl -s https://linear-slack.leonsilicon.ai/healthz`. It returns `{"ok":true,"bot":"ok","session":"ok","projects":"ok",…}`, or 503 when the bot token or the session fails, or when Linear has no Slack app for project channels (`projects: "off: …"`). Cloudflare 403s some default user agents on this zone, so send your own. Logs: `vpx wrangler tail linear-slack-sync`.

`/healthz` reports `issueMetadata: "matrix"` when the Beeper publisher's read-only endpoint has a credential configured, or `"unconfigured"` when `LINEAR_ISSUE_METADATA_TOKEN` is missing from Infisical's `/linear-slack-sync` folder. The sync keeps collecting issue records in either case. The [Beeper inbox](../beeper-inbox/README.md#linear-metadata) reports room publishing status.

## Operating it

With `T=$(vpx varlock load --filter LINEAR_SYNC_ADMIN_TOKEN --format json | jq -r .LINEAR_SYNC_ADMIN_TOKEN)` from the repository root:

- `curl -s -H "authorization: Bearer $T" https://linear-slack.leonsilicon.ai/admin/status` shows the queue with each job's attempts and last error, plus dead jobs.
- `curl -s -X POST -H "authorization: Bearer $T" …/admin/backfill` adopts or creates channels for every open issue and archives channels of closed ones, quietly (no posts), then gives every open project its channel. Safe to rerun.
- `curl -s -X POST -H "authorization: Bearer $T" …/admin/tick` runs the daily safety net now. `/admin/status` lists queued jobs, timers included (`timer:<issue id>@<ms>`).

Other tasks:

- **Session expired** (`/healthz` says `session: invalid_auth`): sections and unarchiving stop, everything else keeps working. Re-copy the session into Infisical's `/shared` folder the way the slack-as-leon README describes, then deploy both Workers: they hold the same login.
- **Autolinear's bot:** `/healthz` says `autolinear: missing` without `AUTOLINEAR_SLACK_BOT_TOKEN`, and `autolinear: AUTOLINEAR_BOT_USER_ID isn't its bot user` when the two don't match. Without the bot, nothing asks Hermes for commands, so issues stay where Hermes's 👀 put them until a command or a Linear move. Logs: `autolinear_command`, `autolinear_reminded`, `autolinear_gave_up`.
- **Change sections or mentions:** edit `SECTION_ORDER`, `PROJECT_SECTION`, `MENTION_LEON_STATES` or `PING_HERMES_STATES` in `.env.schema` and deploy. Sections are named exactly after Linear statuses. Rename a status in Linear and new placements use the new name; the old section empties and is deleted as its channels move.
- **Project channel missing:** `/healthz` says `projects: off…` when Linear's Slack app is gone or Project channels are off; otherwise `/admin/status` shows a failed `project` or `tick` job. If Linear's Slack app was disconnected or Project channels turned off, the sync logs `project_channels_off` and requests nothing. Reconnect it in Linear → Settings → Integrations → Slack.
- **Turn it off:** `vpx wrangler delete --config apps/slack22linear/wrangler.jsonc`, then delete the Linear webhook and API key (Linear → Settings → API) and the Slack app (api.slack.com/apps → slack22linear). Project channels stay connected to their projects through Linear's own Slack app.

## autolinear

[autolinear](../autolinear/README.md) creates an issue and opens its channel itself, as Leon, so both appear at once, then hands the channel over through a binding to this Worker's Durable Object (`/adopt`; the Worker's public routes never reach it). The Durable Object invites the bot and Hermes, records the channel, and queues the rest (intro, topic, section, project, thread quote) as an `adopted` job. An autolinear issue (ID starting `a7011ea7`) whose webhook comes first waits up to two minutes for the hand-over instead of getting a second channel. The details are in the [service README](../../packages/ai/leonsilicon/services/slack22linear/README.md#autolinears-issues). Deploy this Worker before autolinear when `/adopt` changes.

## Hermes

Since 2026-11-18, Hermes's `issue-execution-sweep` and `leon-messaging-voice` skills, its `USER.md`, and the 9/13/18 sweep cron say that slack22linear owns issue channels. Hermes no longer creates, archives or re-topics them, or moves sidebar sections through Task Bot. It posts progress and questions as Linear comments, which show up in the channel. Captain Claude keeps backups of the old versions, suffixed `.bak-20261118-linear-sync`.

Hermes's Slack setting `allow_bots: mentions` means it answers the bot's posts only when they mention it. That is what the Awaiting Hermes and Awaiting Start pings rely on, and why mirrored comments don't loop.

The hand-offs run on Slack itself. Hermes's 👀 on Leon's message or a slack22linear handoff ping moves the issue to Executing. A move to Awaiting Hermes in Linear pings Hermes to pick up the issue. Hermes delegates every task to another agent and uses `move executing` while that agent works. Since 2026-11-23 (Leon's rule), nothing moves on what Hermes answers: every turn Hermes finishes in an issue channel ends with a line for Autolinear, the autolinear Slack app's bot, such as `@Autolinear move done`, `@Autolinear move leon` or `@Autolinear stay`, and that command moves the issue ([Autolinear's commands](../../packages/ai/leonsilicon/services/slack22linear/README.md#autolinears-commands)). When a turn ends (Hermes's ✅ or ❌) without one, this Worker posts a reminder as Autolinear, mentioning Hermes, twice at most, then tells Leon. Mentioning Leon never moves an issue (Leon's rule, 2026-11-23: issues move only by explicit commands), in Hermes's Slack posts or in Linear comments; from 2026-11-19 until then, both did. Hermes's autolinear plugin puts the rule and Autolinear's exact mention in the channel prompt of every turn in an issue channel, and its `SOUL.md` says the same. The Worker queues Hermes's messages and edits when they carry a command, along with its 👀, ✅ and ❌ reactions on messages.

Hermes answers Autolinear's reminders because the bot's user ID is in Hermes's `SLACK_ALLOWED_USERS` and the reminders mention Hermes (`allow_bots: mentions`). Hermes's reaction triggers are off, so Autolinear's ✅ on a command starts no turn.

## Security

- Two credentials here are logins: Leon's Slack web session (full Slack access as him) and a Linear personal API key (full access as his account). They are kept in Infisical and stored as Worker secrets, so Infisical and Cloudflare can read them.
- Only the sidebar, invites and unarchiving use the session. Channels and posts use the bot.
- Webhooks are verified by signature and timestamp. `/admin/*` needs the bearer token.
- The first bot token was shown once in a tool output during setup. It was revoked (`auth.revoke`) and the app reinstalled before any token was stored.
