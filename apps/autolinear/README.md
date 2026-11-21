# @-apps/autolinear

Runs [autolinear](../../packages/ai/leonsilicon/services/autolinear/README.md) as a Cloudflare Worker (since 2026-11-21): each of Leon's Slack messages that Hermes answers outside an issue channel gets a Linear issue in Awaiting Init and its own channel the moment it arrives, his message is edited to link the channel, and Hermes answers him there. Slack's own events, through the autolinear Slack app, start it as soon as Leon sends a message; Hermes's [autolinear plugin](../../packages/com/leonsilicon/hermes/plugins/autolinear/README.md) calls it too, and gets the same issue. [Linear Sync](../linear-slack-sync/README.md) takes the channel over.

```text
Slack Events (autolinear app, Leon's messages) ── POST /slack/events ─┐
Hermes (autolinear plugin) ───────────────────── POST /intake ───────┴─▶ Worker ─▶ IntakeObject (one per message, eastern North America)
                                                          ├─▶ Linear API: issueCreate
                                                          ├─▶ Slack as Leon: conversations.create
                                                          └─▶ at once: chat.update (his message) · chat.postMessage (the copy)
                                                                       · Linear Sync's SyncObject /adopt (bot and Hermes invited)
```

## Speed

Everything Leon sees is on one short path, and everything else is off it:

- Slack sends Leon's message to autolinear as soon as he sends it (the autolinear app's user events), so the intake starts before Hermes has even received the message. Only messages Hermes is sure to answer start this way: his own, in his DM with Hermes or a public channel that isn't an issue channel, with no command and no mention of anyone but Hermes. Hermes's plugin asks for the same message moments later and gets the running or finished intake: one Durable Object per message runs it once.
- For any other message, the plugin starts the request the moment Hermes receives it, before Hermes reads the thread or downloads files, and waits for it only when it builds the turn.
- Three requests in a row: the issue, the channel, then the edit, the copy and the hand-over together. The team and status IDs and the workspace URL come from config (or are looked up once per isolate); the title, description and permalink come from the message itself.
- Each message gets its own Durable Object, created in eastern North America (`locationHint: "enam"`), next to Slack's and Linear's APIs, so each of those requests is a short hop. There's no queue or global lock: messages run in parallel.
- The topic, sidebar section, intro, project and thread quote are left to Linear Sync's queue, which does them a second or two later.

Every intake logs `intake` with `ms`, the milliseconds until each step was done (`issue`, `channel`, `linked`, `copy`, `adopted`), and Hermes's gateway log repeats them. One started by Slack's event also logs `event_intake`.

## Pieces

| Piece     | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker    | `autolinear` in the Cloudflare account that holds the leonsilicon.ai zone; Custom Domain `autolinear.leonsilicon.ai`, no workers.dev address. Config in [`wrangler.jsonc`](wrangler.jsonc)                                                                                                                                                                                                                                                                                                               |
| State     | Durable Object `IntakeObject`, one per message (named `<channel>:<ts>`): the intake's progress and answer, so concurrent or repeated requests share one run. It clears itself a day later. Linear Sync's `SyncObject` is bound as `SYNC` (`script_name: "linear-slack-sync"`) for the hand-over                                                                                                                                                                                                          |
| Slack app | **autolinear**, created 2026-11-21 through `apps.manifest.create` with Leon's session and installed by him for himself. No bot user: only the user scopes `channels:history` and `im:history`, for the user events `message.channels` and `message.im` (every message in his public channels and DMs) sent to `/slack/events`. The Worker drops all but his own, and all DMs but the one with Hermes. Its client ID and secret are in Infisical under `/autolinear`, for reinstalling; it keeps no token |
| Config    | The `#autolinear` items of the root [`.env.schema`](../../.env.schema): `AUTOLINEAR_TOKEN`, `AUTOLINEAR_SLACK_SIGNING_SECRET` and the optional `LINEAR_TEAM_ID`, `LINEAR_INTAKE_STATE_ID`, `SLACK_WORKSPACE_URL` and `SLACK_HERMES_DM_ID` in Infisical under `/autolinear`; `AUTOLINEAR_SKIP_CHANNELS`, shared with Hermes; Linear Sync's `LINEAR_API_KEY` (issues are created as its Linear account); Leon's Slack session and both Slack user IDs from `/shared`                                       |
| Page      | [`www/ai/leonsilicon/autolinear/index.html`](../../www/ai/leonsilicon/autolinear/index.html), for browsers                                                                                                                                                                                                                                                                                                                                                                                               |

## Deploy

Pushes to `main` deploy it automatically when they change its code ([Deploy workflow](../../.github/workflows/deploy.yml)). By hand:

```sh
vpr -w deploy:autolinear
```

Linear Sync must already have `/adopt` (deployed with it on 2026-11-21): autolinear calls it on every intake. Check `curl -s https://autolinear.leonsilicon.ai/healthz`, which returns `{"ok":true,"token":"ok","events":"ok","session":"ok","linear":"ok"}`, or 503. Logs: `vpx wrangler tail autolinear`.

## Operating it

- **Turn it off:** remove `AUTOLINEAR_TOKEN` from Hermes's env (or disable the plugin), and uninstall the autolinear Slack app (or remove `AUTOLINEAR_SLACK_SIGNING_SECRET` from Infisical and deploy): Hermes answers messages where they are again. With only the app gone, it still works, a little later, through Hermes's call.
- **Skip a channel:** add its ID to `AUTOLINEAR_SKIP_CHANNELS` in `.env.schema`, deploy, and set the same value in Hermes's env, so neither path starts on it.
- **A message that should have moved didn't:** the gateway log says why (`autolinear: left … alone (<reason>)`, or a warning with the error); `vpx wrangler tail autolinear` shows `intake` or `intake_failed`.
- **Session expired:** intakes fail and Hermes answers in place. Re-copy the session into Infisical's `/shared` folder the way the slack-as-leon README describes, then deploy slack-as-leon, Linear Sync and autolinear: they hold the same login.

## Security

- It acts as Leon through his Slack web session and creates issues with Linear Sync's personal Linear key, both stored as Worker secrets.
- `/intake` needs the bearer token. It only edits the message it was told about, and Slack lets the session edit only Leon's own messages.
