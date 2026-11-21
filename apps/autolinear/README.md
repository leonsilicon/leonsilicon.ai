# @-apps/autolinear

Runs [autolinear](../../packages/com/leonsilicon/ai/services/autolinear/README.md) as a Cloudflare Worker (since 2026-11-21): each of Leon's Slack messages that Hermes answers outside an issue channel gets a Linear issue in Awaiting Init and its own channel the moment it arrives, his message is edited to link the channel, and Hermes answers him there. Hermes's [autolinear plugin](../../packages/com/leonsilicon/hermes/plugins/autolinear/README.md) calls it; [Linear Sync](../linear-slack-sync/README.md) takes the channel over.

```text
Hermes (autolinear plugin) ── POST /intake ─▶ Worker ─▶ IntakeObject (one per message, eastern North America)
                                                          ├─▶ Linear API: issueCreate
                                                          ├─▶ Slack as Leon: conversations.create
                                                          └─▶ at once: chat.update (his message) · chat.postMessage (the copy)
                                                                       · Linear Sync's SyncObject /adopt (bot and Hermes invited)
```

## Speed

Everything Leon sees is on one short path, and everything else is off it:

- The plugin starts the request the moment Hermes receives the message, before Hermes reads the thread or downloads files, and waits for it only when it builds the turn.
- Three requests in a row: the issue, the channel, then the edit, the copy and the hand-over together. The team and status IDs and the workspace URL come from config (or are looked up once per isolate); the title, description and permalink come from the message itself.
- Each message gets its own Durable Object, created in eastern North America (`locationHint: "enam"`), next to Slack's and Linear's APIs, so each of those requests is a short hop. There's no queue or global lock: messages run in parallel.
- The topic, sidebar section, intro, project and thread quote are left to Linear Sync's queue, which does them a second or two later.

Every intake logs `intake` with `ms`, the milliseconds until each step was done (`issue`, `channel`, `linked`, `copy`, `adopted`), and Hermes's gateway log repeats them.

## Pieces

| Piece  | Where                                                                                                                                                                                                                                                                                                                                                     |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker | `autolinear` in the Cloudflare account that holds the leonsilicon.ai zone; Custom Domain `autolinear.leonsilicon.ai`, no workers.dev address. Config in [`wrangler.jsonc`](wrangler.jsonc)                                                                                                                                                                |
| State  | Durable Object `IntakeObject`, one per message (named `<channel>:<ts>`): the intake's progress and answer, so concurrent or repeated requests share one run. It clears itself a day later. Linear Sync's `SyncObject` is bound as `SYNC` (`script_name: "linear-slack-sync"`) for the hand-over                                                           |
| Config | The `#autolinear` items of the root [`.env.schema`](../../.env.schema): `AUTOLINEAR_TOKEN` and the optional `LINEAR_TEAM_ID`, `LINEAR_INTAKE_STATE_ID` and `SLACK_WORKSPACE_URL` in Infisical under `/autolinear`; Linear Sync's `LINEAR_API_KEY` (issues are created as its Linear account); Leon's Slack session and both Slack user IDs from `/shared` |
| Page   | [`www/ai/leonsilicon/autolinear/index.html`](../../www/ai/leonsilicon/autolinear/index.html), for browsers                                                                                                                                                                                                                                                |

## Deploy

Pushes to `main` deploy it automatically when they change its code ([Deploy workflow](../../.github/workflows/deploy.yml)). By hand:

```sh
vpr -w deploy:autolinear
```

Linear Sync must already have `/adopt` (deployed with it on 2026-11-21): autolinear calls it on every intake. Check `curl -s https://autolinear.leonsilicon.ai/healthz`, which returns `{"ok":true,"token":"ok","session":"ok","linear":"ok"}`, or 503. Logs: `vpx wrangler tail autolinear`.

## Operating it

- **Turn it off:** remove `AUTOLINEAR_TOKEN` from Hermes's env (or disable the plugin): Hermes answers messages where they are again.
- **A message that should have moved didn't:** the gateway log says why (`autolinear: left … alone (<reason>)`, or a warning with the error); `vpx wrangler tail autolinear` shows `intake` or `intake_failed`.
- **Session expired:** intakes fail and Hermes answers in place. Re-copy the session into Infisical's `/shared` folder the way the slack-as-leon README describes, then deploy slack-as-leon, Linear Sync and autolinear: they hold the same login.

## Security

- It acts as Leon through his Slack web session and creates issues with Linear Sync's personal Linear key, both stored as Worker secrets.
- `/intake` needs the bearer token. It only edits the message it was told about, and Slack lets the session edit only Leon's own messages.
