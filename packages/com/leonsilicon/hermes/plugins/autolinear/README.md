# @-/com.leonsilicon.hermes.plugins.autolinear

Hermes plugin that gives each of Leon's Slack messages its own Linear issue and channel the moment it arrives, through [autolinear](../../../../../../apps/autolinear/README.md), and has Hermes answer it there.

## Why

Every message Leon sends to Hermes outside an issue channel gets a new Linear issue in Awaiting Init and its own Slack channel. AutoLinear edits his message to link the channel where Hermes answers and keeps the conversation.

## What happens

1. Leon writes to Hermes outside an issue channel: a DM, `#general`, a project channel, a reply under a `#feed-` post.
2. AutoLinear's Slack app usually starts intake before Hermes receives the message. Once the message reaches Hermes and passes dedup and the bot check, the plugin calls `POST /intake` in the background to get the running or finished intake. AutoLinear creates the issue, opens its `leon-<n>-<first words>` channel, and posts a copy of the message there as Leon. Once Slack confirms the copy, AutoLinear replaces the original message with the channel link.
3. Meanwhile Hermes reads the thread and downloads files as usual. When it builds the turn, the plugin waits for autolinear's answer and builds the turn as if Leon had written that copy: same text, files and thread history, in the new channel, with a one-line note naming the issue. Hermes's reply, its session and its 👀 → ✅ reactions all land in the issue channel. With [slack-flat-replies](../slack-flat-replies/README.md), the reply is at the top of the channel, not in a thread.
4. Hermes's 👀 moves the issue to Awaiting Hermes. Hermes answers, and ends its turn with one line that starts with Autolinear's mention and says what to do with the channel: `move done`, `move leon`, `move others who="…"`, `move listener event="…" stop=…`, `move date start=…`, `move hermes` or `stay` (Leon's rule, 2026-11-23). Only that line moves the issue; slack22linear reads it ([Autolinear's commands](../../../../../ai/leonsilicon/services/slack22linear/README.md#autolinears-commands)). When a turn ends without one, Autolinear reminds Hermes there.

The plugin puts that rule, with Autolinear's exact mention, in the channel prompt of every turn in an issue channel, whoever started it: Leon's message, a bot's ping, or Autolinear's reminder. Hermes's Slack adapter shows Hermes every mention it reads as a plain `@Name`, so the prompt is where Hermes gets the raw `<@U…>` token.

## Which messages

A message moves when Hermes answers it, Leon (`AUTOLINEAR_USER_ID`) wrote it, it isn't a command (`/new`, `!stop`) or a reaction-triggered turn, and it isn't in an issue channel (`leon-<number>` or `leon-<number>-…`) or in `AUTOLINEAR_SKIP_CHANNELS`. Otherwise Hermes answers where it is, as before.

The early start, before Hermes's own gates have run (`_prefilter_inbound`), is only for messages Hermes always answers: also no `/` or `!` at the start and no mention of anyone but Hermes. Anything else that Hermes ends up answering starts when its turn is built (`_build_message_event`, which runs only after the gates), a little later. An early start whose message Hermes then doesn't answer is logged (`made LEON-… but Hermes didn't answer that message`).

A thread reply's thread goes along: Hermes keeps the thread history it read, and slack22linear quotes the thread's first message in the issue. A message in a project's channel files the issue in that project.

## Failure

It fails open. When autolinear can't be reached, errors, declines, or takes longer than 25 seconds, Hermes answers in place. A network error or a 5xx gets one retry; autolinear runs each message's intake once, so a retry gets the same issue. When the adapter internals it relies on disappear, it logs a warning and does nothing.

The copy carries slack-as-leon's `client_msg_id` marker, so [slack-as-leon-guard](../slack-as-leon-guard/README.md) drops its live event, and Hermes doesn't answer the message twice. Keep that plugin enabled; this one logs a warning when it isn't. The copy's ts is also claimed, so its unfurl edits start no turn. autolinear's edit of Leon's message starts none either: Hermes claimed that message's ts before its turn was built.

## Settings

In `$HERMES_HOME/.env` (the dashboard's Keys page), from the `#hermes` items of the root [`.env.schema`](../../../../../../.env.schema). Without the first two, the plugin is off.

| Key                         | Value                                                                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AUTOLINEAR_TOKEN`          | autolinear's `AUTOLINEAR_TOKEN`                                                                                                                                                                                    |
| `AUTOLINEAR_USER_ID`        | Leon's Slack user ID                                                                                                                                                                                               |
| `AUTOLINEAR_URL`            | Optional; default `https://autolinear.leonsilicon.ai/intake`                                                                                                                                                       |
| `AUTOLINEAR_CHANNEL_PREFIX` | Optional; default `leon`, slack22linear's channel prefix                                                                                                                                                           |
| `AUTOLINEAR_SKIP_CHANNELS`  | Optional; comma-separated channel IDs whose messages Hermes answers there                                                                                                                                          |
| `AUTOLINEAR_BOT_USER_ID`    | Optional; Autolinear's bot user, whose mention starts Hermes's command line. Without it, the prompt asks for a plain `@Autolinear`. Also add it to `SLACK_ALLOWED_USERS`, or Hermes ignores Autolinear's reminders |

They're read on every message, so removing the token turns the plugin off once Hermes's env reloads.

## Install

Copy `plugin.yaml` and `__init__.py` to `$HERMES_HOME/plugins/autolinear/` (`/opt/data` on Hermes Cloud), add `autolinear` to `plugins.enabled` in `config.yaml`, and restart the gateway. The gateway log then shows `autolinear: each of Leon's Slack messages gets a Linear issue and channel at once`, followed by `(off until …)` when a setting is missing. Each moved message logs `autolinear: <channel>:<ts> is LEON-<n> ({…step timings…}); Hermes answers in #leon-<n>-…`.

Hermes Cloud's `SOUL.md`, `issue-execution-sweep`, and `leon-messaging-voice` should use the same order for Slack replies. A sweep originating in Linear can use a Linear comment with Leon's mention to trigger the handoff.

## Test

The tests drive the real Slack adapter, so they need a Hermes checkout's environment. Hermes Cloud ran v0.23.2 when this was written:

```sh
git -C ~/.hermes/hermes-agent worktree add --detach /tmp/hermes-v0.23.2 v0.23.2
cd /tmp/hermes-v0.23.2 && UV_PROJECT_ENVIRONMENT=/tmp/hermes-venv uv sync --frozen --extra slack
VIRTUAL_ENV=/tmp/hermes-venv uv pip install pytest pytest-asyncio
cd - && HERMES_HOME=$(mktemp -d) PYTHONPATH=/tmp/hermes-v0.23.2 /tmp/hermes-venv/bin/python -m pytest -q -p no:cacheprovider __tests__
```

They load `slack-as-leon-guard` and `slack-always-react` from their sibling directories, to check the copy isn't answered twice and gets its reactions whichever plugin wires first.
