# @-/ai.leonsilicon.services.beeper-to-slack

Shared delivery for the [Beeper inbox Slack feeds](../../../../../apps/beeper-inbox/README.md#slack-feeds). Each extension chooses one Beeper network and has its own settings, journal cursor and pending deliveries. The [Beeper inbox](../beeper-inbox/README.md) provides the room directory and live journal through its existing Matrix session.

A feed starts at the journal head on first use and resumes at its saved cursor on restart. Journal changes wake the feed after they are written. The feed stays idle between changes and scheduled retries. The room's network and any configured room IDs are checked before screening or delivery. Pending edits update the queued copy and redactions drop it. Slack receives a text snapshot. Attachments and the original message stay accessible through Beeper.

The [feed screener](../feed-common/decisions.ts) sends spam and flagged messages to the configured private channels. Screening failures are retried for 15 minutes, then the message is held in the flagged channel. Slack delivery retries with backoff for up to seven days. The extension reports pending, posted and expired counts in the inbox status.

See the [Beeper inbox runbook](../../../../../apps/beeper-inbox/README.md#slack-feeds) for deployment and settings.
