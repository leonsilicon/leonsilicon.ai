# @-/com.leonsilicon.ai.services.linear-slack-sync

Keeps one Slack channel per Linear issue, and one per Linear project. Leon works in Slack while his agents collaborate in Linear, so he follows their work through these channels. Each issue channel sits in the sidebar section named exactly after its issue's status, so the sidebar shows at a glance what is blocked on him and what is waiting on someone else. Issue comments are mirrored both ways. Project channels belong to Linear's own Slack app, which posts project updates and project comments there and syncs their threads; this sync only makes sure every open project has one. It runs as a Cloudflare Worker; deployment is in [`apps/linear-slack-sync`](../../../../../../apps/linear-slack-sync/README.md).

## What it does

| When                                                      | It does                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An issue is created                                       | Creates a private channel `leon-<number>-<title words>` and invites Leon and Hermes. Posts the title, link and description, sets the topic to the status, title metadata and link, and files the channel in the status's section. If a `leon-<number>-…` channel already exists, it adopts that one.                                                 |
| An issue's status changes                                 | Posts `*From* → *To*` and moves the channel to the new section. It mentions Leon on Awaiting Leon and Awaiting Clarification, and mentions Hermes on Awaiting Hermes and Awaiting Start, so Hermes picks the issue up. A section left empty is deleted.                                                                                              |
| An issue closes (Done, Canceled, Duplicate) or is deleted | Takes the channel out of its section and archives it. Reopening the issue unarchives the same channel.                                                                                                                                                                                                                                               |
| An issue's title changes                                  | Renames the channel when the title words change; title metadata alone doesn't rename it. Updates the topic.                                                                                                                                                                                                                                          |
| A Linear comment is added, edited or deleted              | Posts, edits or deletes the Slack message under the comment author's name and avatar. Replies go into the Slack thread of their parent.                                                                                                                                                                                                              |
| A person writes in an issue channel                       | Adds a Linear comment `**Leon in Slack:** …` with mentions and links converted to Markdown and files linked. Thread replies become replies to the matching Linear comment, and edits follow.                                                                                                                                                         |
| A project in team LEON is open and has no channel         | Has Linear's Slack app create a public channel `p-<project name>` and connect it to the project (see [Project channels](#project-channels)). A project created less than five minutes ago is left to Linear's own "create channel for new projects" first.                                                                                           |
| A project has a channel                                   | Files it in the **Projects** sidebar section, below the status sections, and makes sure Leon and Hermes are in it. Linear names, renames and sets the topic itself.                                                                                                                                                                                  |
| A project closes (Completed, Canceled) or is deleted      | Takes its channel out of the section and archives it. Reopening the project unarchives the same channel.                                                                                                                                                                                                                                             |
| Every 15 minutes                                          | Moves Awaiting Date issues whose `start` has arrived to Awaiting Start. Moves Awaiting Listener issues whose `stop` has passed to Awaiting Leon and comments why. Both strip the old status's keys from the title. It also re-syncs any issue whose status or title drifted while a webhook was missed, and any project whose channel isn't settled. |

**Ignored:** bot posts (including Hermes and Composio), system messages, and Hermes's posts as Leon through slack-as-leon (`client_msg_id` starting `de1e6a7e`).

**No echoes:**

- A comment made from Slack is created with an ID derived from the Slack message (`stableUuid`), and that ID is recorded first. Linear's webhook for it is then recognized and skipped.
- A retried Slack event reuses the same ID.

## Title metadata

Leon's rule (2026-11-18) is that status data ends the title as a YAML 1.2 flow mapping in backticks:

```
switch to rogers `{event: Rogers unlimited BYOD deal, stop: 2026-12-01}`
```

- Values containing `, : { } [ ] #` are double-quoted.
- A bare date `YYYY-MM-DD` means midnight in Toronto. Times are RFC 3339 with an offset.
- `parseTitle` and `formatTitle` read and write the mapping, and `metaInstant` turns a value into an instant.

## Sidebar sections

Slack has no public API for a person's sidebar. `Sidebar` uses the web client's own methods with Leon's web session (`xoxc-` token plus `d` cookie), the same kind slack-as-leon holds:

- `users.channelSections.list` returns sections as a linked list through `next_channel_section_id`.
- `users.channelSections.create` needs `name` and `emoji` (`""` is fine). `next_channel_section_id` places the new section before that one.
- `users.channelSections.channels.bulkUpdate` takes `insert` and/or `remove`, each a JSON array of `{channel_section_id, channel_ids}`.
- `users.channelSections.delete`.

Sections are created only when a channel needs them, in `SECTION_ORDER`, as one block at the top. A status missing from the order gets its section after the block. Without the session, everything else still works and sections are skipped.

## Project channels

Linear connects a project to a Slack channel natively ("Project channels" in Linear → Settings → Integrations → Slack, turned on 2026-11-19 with prefix `p-`). The connected channel gets the project's updates, with each update's Slack thread synced both ways, and top-level project comments. Its ID is the project's `slackChannelId`.

Linear's public schema has no way to give an existing project such a channel without an OAuth consent per project. Linear's own app uses `projectCreateSlackChannel(id, slackChannelName, integrationId)`, which is left out of the published schema but accepts a personal API key. `LinearClient.createProjectChannel` calls it. Linear's bot then creates the public channel, invites the project's members, sets the topic to the project summary, and fills in `slackChannelId` within seconds. Linear switches the project's updates and comments on (`integrationsSettings`) by default.

- The integration and prefix come from Linear (`organization.slackProjectChannelIntegration`, `slackProjectChannelPrefix`). Without them, no channel is requested.
- A taken name gets `-2`, `-3`… A channel that still hasn't appeared is requested again after 30 minutes, not before.
- The sync's own bot doesn't join project channels. Leon's session joins him and invites Hermes, and archives and unarchives.
- Messages in a project channel aren't mirrored by this sync: Linear syncs its own threads.

## API

- `Sync`: `run(kind, payload)` for the jobs `linear` (a webhook body: Issue, Comment or Project), `slack` (a message event), `project` (a delayed look at a new project), `tick` and `backfill`, plus `syncIssue(issue, "live" | "quiet")` and `syncProject(project)`.
- `Store`: issue ↔ channel, project ↔ channel and comment ↔ message mappings, a Slack user name cache, and the durable job queue (dedupe for 3 days, backoff, `dead` after six attempts, optional delay). It runs over any `Sql`: a Durable Object's `storage.sql`, or `node:sqlite` in tests.
- `LinearClient`: Linear's GraphQL API with a personal API key, including `createProjectChannel` above.
- `botClient`: the Slack Web API with a bot token. `Sidebar` covers the sections above, and `tolerate` treats the listed Slack errors as success.
- `verifySlack` and `verifyLinear`: request signatures with a five-minute window.
- Format helpers: `linearToSlack`, `slackToLinear`, `channelName`, `projectChannelName`, `channelNumber` and `channelTopic`.
- `loadConfig(env)`: settings from the Worker's vars (the `#linear-slack-sync` items of the root `.env.schema`). `SLACK_LEON_USER_ID` and `SLACK_HERMES_USER_ID` are required: they have no built-in default.

## Test

```sh
node --test packages/com/leonsilicon/ai/services/linear-slack-sync/__tests__/*.test.ts
```

The tests use a fake Linear (whose Slack app makes project channels), a fake Slack (bot and session views of one workspace, sidebar included) and an in-memory SQLite.
