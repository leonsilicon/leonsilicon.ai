# @-/ai.leonsilicon.services.autotrigger

Autotrigger uses the OpenAI Decisions API to match new Slack messages in `#feed-*` channels with Linear issues in **Awaiting Trigger**, and with Leon's [Watcher projects](#watchers). A new email copied to `#feed-gmail` or a reply in a Slack feed thread can satisfy an issue's wait. The decision uses the issue's title, description and AutoLinear workflow details, including `who` and `event`. It uses the earlier messages in a Slack thread as context for short replies.

When there is one clear match, the slack22linear bot mentions Hermes in the mapped issue channel and links the exact source message. It checks the issue again before posting. The notification leaves the issue's status for Hermes or Leon to update through the usual workflow. Ambiguous matches, expired waits, spam, and flagged messages stay quiet.

## Watchers

Since 2026-11-25 (Leon's rule) a standing watch is a project in the **Watcher** status, never an issue left open in Awaiting Trigger. The project's summary says what to watch for and its body what to do with each case. When no Awaiting Trigger issue matches a feed message, a second decision looks at the watchers and their open issues:

- **A new case** for one watcher: Autotrigger opens an issue in the watcher's project, in **Awaiting Hermes**. Its title is the message's subject (the bold line of an email copied to `#feed-gmail`) or first line, and its description links the source message, quotes it and copies the watcher's text. slack22linear gives the issue its channel, and the channel's intro mentions Hermes, who handles the case there and closes it with an Autolinear command. The watcher stays open for the next case.
- **A follow-up** in one of a watcher's open issues (the same sender or conversation, such as a reply in the same email thread): the slack22linear bot mentions Hermes in that issue's channel with a link, as for an Awaiting Trigger match.

An Awaiting Trigger issue that matches comes first, and an ambiguous answer posts nothing. The new issue's ID comes from the watcher and the message, so a retry can't open a second one. A watcher that left the Watcher status before the issue was opened gets none.

Muse reminders and routines use a direct route. A top-level schedule run posted by the configured Hermes Slack bot in `#feed-muse` opens a case in the Watcher whose body contains a `Muse schedule: <id>` line. A single Watcher with `Muse schedule: *` handles runs without a specific match. Each run opens a fresh Awaiting Hermes case, with the same issue ID across Slack retries. These Watchers take their input from Hermes's scheduled-run feed posts. See [Reminders and routines](../../../../../apps/hermes-plugin-leon/hermes22muse/README.md#reminders-and-routines).

## Runtime

[AutoLinear](../../../../../apps/autolinear/README.md)'s Slack user event subscription covers public feeds Leon has joined. [slack22linear](../../../../../apps/slack22linear/README.md)'s bot event subscription also covers public and private feeds the bot has joined. Autotrigger keeps one delivery per Slack channel and timestamp, even if both subscriptions see it. Slack Connect channels and the configured spam and flagged channels are excluded.

The slack22linear Worker runs each decision and delivery in a separate Durable Object, with its `WATCHER_PROJECT_STATUS` and `HERMES_STATE` (Watcher and Awaiting Hermes by default). The alarm retries transient failures and the object keeps a completion marker for three days. The Worker uses the existing `OPENAI_API_KEY`, `FEED_FLAGGED_CHANNEL` and `FEED_SPAM_CHANNEL` in Infisical under `/gmail-feed`. It uses the existing Slack session to read feed threads and the slack22linear bot to post. Both Workers deploy on push to `main`. Check `/healthz` on slack22linear for configuration and look for `autotrigger_failed` in its Worker logs for delivery failures.
