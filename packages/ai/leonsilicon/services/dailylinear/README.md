# @-/ai.leonsilicon.services.dailylinear

Makes Leon's Linear project for each day and its Slack channel. At midnight in Toronto, the day gets a project in team LEON named after the date (`20261122`) and a channel `#project-2026-11-22` connected to it through Linear's own Slack app, and that channel goes in Leon's **Starred** section (Leon's rule, 2026-11-19: the day's channel is the one channel always in Starred). The day's follow-ups and debrief go in that project. Once the day is over, its project is marked Completed and its channel archived (Leon's rule, 2026-11-21: previous days' projects are always done). It runs as a Cloudflare Worker, deployed from [`apps/dailylinear`](../../../../../apps/dailylinear/README.md).

Until 2026-11-21 this was two things: a Grok Bot routine (`daily-linear-yyyymmdd-project`, set up in LEON-417) made the project at 00:00 and checked it at 00:45, and [Linear Sync](../linear-slack-sync/README.md) asked for the channel five minutes later, renamed it and starred it. Linear Sync now leaves day projects to this, apart from getting Leon and Hermes into the channel and archiving it when the project closes.

## What a run does

`Daily.run()` does whatever is still missing for the day, so running it again is always safe:

1. **Today's project.** It looks up the team's projects named after today (`20261122` or `2026-11-22`), closed, archived and deleted ones included. An open one is today's. When there's none, it makes one: name `YYYYMMDD`, status Backlog (`DAY_PROJECT_STATUS`), start and target date today, no lead, no description. Its ID comes from the team and day (`dayProjectId`), so a retry after a lost answer finds the project made the first time instead of making a second. A day whose project Leon closed or deleted gets no new one.
2. **The channel.** For today's project, and any made ahead for a later day, when it has no channel, it has Linear's Slack app create one with `projectCreateSlackChannel` (see [Linear Sync's project channels](../linear-slack-sync/README.md#project-channels)), named `project-YYYY-MM-DD` from the start (`-2`, `-3`… when the name is taken), and waits up to ten seconds for it. Linear's bot creates the public channel and connects it to the project, so Linear posts the project's updates there. It asks again after 30 minutes at the soonest. A project Leon makes in Linear's own app first gets five minutes for the channel Linear makes for new projects; dailylinear's own get no such wait.
3. **Settling the channel**, once per channel: renamed to `project-YYYY-MM-DD` when Linear named it after the project (`project-20261122`; Linear keeps the connection by channel ID), Leon joined, Hermes invited.
4. **The sidebar.** Today's channel is starred and taken out of custom sections, since Slack lets a starred channel also sit in one. A project made ahead for a later day has its channel under **Projects** (`PROJECT_SECTION`), below Linear Sync's status sections, until its day.
5. **Past days.** Every open day's project whose day is over is marked done: its channel is unstarred, taken out of the sidebar's sections and archived, then the project is set to Completed (`DAY_DONE_STATUS`). This comes after today's channel is starred, so at midnight the new day's channel takes Starred first. The channel goes before the project, so a run that fails partway does it all again; every step tolerates being repeated, and Linear Sync, which archives a closed project's channel too, finds it archived already. The first run, on 2026-11-21, did this for the 19th and 20th. A past day's project Leon reopens afterwards is left alone (`DailyState.completed` remembers what dailylinear closed, for 60 days).
6. **Closed days.** A day's project that closed or was deleted some other way is forgotten, its channel unstarred first if dailylinear starred it. Linear Sync archives the channel.

Only a channel dailylinear starred is unstarred, and only when its place changes: channels Leon stars himself stay starred, and if he unstars the day's channel it stays unstarred.

The run answers `DailyResult`: the day, today's project, whether this run made it, the past days it marked done (`done`), the status (`ready`; `waiting` while the channel is on its way; `closed` when Leon closed or deleted it; `off` when Linear's project channels are off) and when to run next: the next midnight, or a minute later while `waiting` (30 minutes while `off`).

## State

`DailyState` holds a `DayRecord` per open day's project: its channel once settled, when the channel was asked for, and where dailylinear put it (`starred` or `projects`); the projects it marked done (`completed`); and the last result. It lives in the Worker's Durable Object (`DailyStore`), or in memory in tests.

## API

- `Daily` with `DailyDeps`: the config, a Linear client (`DailyLinear`: Linear Sync's `LinearClient` has every method, including `projectsNamed`, `projectStatuses`, `createProject` and `updateProject`), Leon's Slack session, the store, and optional `now`, `sleep` and `log`.
- `dayProjectName(day)` (`20261122`) and `dayProjectId(teamKey, day)`.
- `CHANNEL_RETRY_MS`, `WAITING_RETRY_MS` and `COMPLETED_KEEP_DAYS`.
- `loadConfig(env)`: `SLACK_HERMES_USER_ID` (required), `LINEAR_TEAM_KEY`, `TIME_ZONE`, `DAY_PROJECT_STATUS`, `DAY_DONE_STATUS`, `CLOSED_PROJECT_TYPES`, `SECTION_ORDER`, `PROJECT_SECTION` and `CHANNEL_NAME_MAX`, the last four as Linear Sync reads them.

## Test

```sh
node --test packages/ai/leonsilicon/services/dailylinear/__tests__/*.test.ts
```

The tests use a fake Linear (whose Slack app makes the channels) and a fake Slack with Leon's sidebar.
