# @-/ai.leonsilicon.services.autolinear

Makes one of Leon's Slack messages a Linear issue with its own Slack channel, as fast as Slack and Linear allow. Leon's rule (2026-11-21): every message he sends in Slack gets an issue in Awaiting Init and a channel at once, his message is edited to link the channel, and Hermes answers him there. Hermes's [autolinear plugin](../../../../../apps/hermes-plugin-autolinear/README.md) calls it; it runs as a Cloudflare Worker, deployed from [`apps/autolinear`](../../../../../apps/autolinear/README.md).

## What it does

`Intake.run(message)` does only what Leon sees, on the shortest path:

1. **The issue**, one request: `issueCreate` in Awaiting Init with the team and status IDs from config (or looked up once per isolate). The title is the message's first line without Hermes's mention (`intakeTitle`, at most 80 characters; `File: <name>` for a file alone). The description is the message in Markdown under `**Leon in Slack** ([where](permalink)):`, with its files. The permalink is built from the workspace URL, not asked of Slack, and only mentions of people other than Leon and Hermes need a `users.info`. The issue's ID starts with `a7011ea7` (`autolinearIssueId`), derived from the message, so a retry finds it and slack22linear knows to wait for the hand-over rather than open a second channel.
2. **The channel**: `conversations.create` as Leon, private, named `leon-<n>-<first words>` like slack22linear's (a taken name gets `-2`…). Leon is in it from the start.
3. **The copy and hand-off** run in parallel. AutoLinear posts the message in the new channel as Leon, preserving formatting and sharing the original Slack files on the copy. The slack-as-leon `client_msg_id` marker keeps the copy from triggering an extra Hermes turn or Linear comment. The `adopt` call hands the channel to slack22linear, which invites its bot and Hermes and records the channel. Its queue sets the topic, sidebar section and project, posts the intro, and adds a reply's thread context to the issue description. [slack22linear](../slack22linear/README.md#autolinears-issues)
4. **The link** replaces the original message once Slack confirms the copy and AutoLinear saves its timestamp. AutoLinear then detaches the files from the source message so it shows just the channel link. The files keep their existing Slack URLs and other shares. AutoLinear logs any edit Slack refuses.

It answers `{ ok, issue, channel, ts, source, ms }`, where `ts` is the copy's and `ms` the milliseconds until each step was done, or `{ ok: false, skipped }` for someone else's message (`not_leon`) or one in an issue channel (`issue_channel`). Each step is recorded in `Progress` as it's done, so a retry carries on where the last try stopped.

## Slack's events

`messageFromEvent(event, config, lookups)` reads a `message` event from the autolinear Slack app's user events and returns the intake for it, or null. It starts only on messages Hermes is sure to answer, since nothing else would answer the copy: Leon's own (not a bot's, not one carrying the slack-as-leon marker, not an edit or a join), with no `/` or `!` command and no mention of anyone but Hermes, in his DM with Hermes (`SLACK_HERMES_DM_ID`, looked up with `conversations.open` when unset) or in a public channel that isn't an issue channel or in `AUTOLINEAR_SKIP_CHANNELS`. `fastPathKind` makes the checks that need no lookup; most events stop there. A private channel or a group DM waits for Hermes's call, since Hermes may not be in it.

## API

- `Intake` with `IntakeDeps`: the config, a Linear client (`issue`, `createIssue`, `team`), Leon's session, `adopt`, the progress store, and an `IntakeCache` shared by the isolate.
- `loadConfig(env)`: `SLACK_LEON_USER_ID` and `SLACK_HERMES_USER_ID` (required), `LINEAR_TEAM_KEY`, `INTAKE_STATE`, `CHANNEL_PREFIX`, `CHANNEL_NAME_MAX`, and the optional `LINEAR_TEAM_ID`, `LINEAR_INTAKE_STATE_ID` and `SLACK_WORKSPACE_URL`, which spare the lookups.
- `permalinkOf(workspaceUrl, message)`: a Slack permalink, threads included.
- `messageFromEvent` and `fastPathKind` for Slack's events, with `EventLookups` for the DM and channel-name lookups.

## Test

```sh
node --test packages/ai/leonsilicon/services/autolinear/__tests__/*.test.ts
```

The tests use fake Slack and Linear clients to verify that the hand-off and copy run in parallel and that the original message is edited only after the copy succeeds.
