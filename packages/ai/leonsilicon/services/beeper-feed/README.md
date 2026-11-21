# @-/ai.leonsilicon.services.beeper-feed

Beeper Feed copies new Beeper messages to Slack. Each platform uses its own channel, such as `#feed-whatsapp`, `#feed-instagram` or `#feed-beeper`. A copy names the conversation and sender, with room and event IDs for the original. The feed runs in the background without Slack mentions or any MCP tools.

The [Beeper inbox](../beeper-inbox/README.md) supplies the live journal. The feed skips Slack-bridged rooms to prevent loops. It starts with new messages on its first run, and resumes at its saved journal position on restart. Each pending message is updated with edits and dropped if redacted. Slack copies are snapshots of the message at delivery. The inbox can open the originals, including attachments.

The [feed screener](../feed-common/decisions.ts) runs before Slack delivery. Spam and flagged messages go to the configured private channels. When screening fails, the feed retries and holds the message in the flagged channel after 15 minutes. Slack delivery retries with backoff for up to seven days. The status reports expired deliveries.

Beeper Feed ships with the [Beeper inbox release](../../../../../apps/beeper-inbox/README.md#beeper-feed) on Hermes Cloud. It uses the existing feed bot and flagged/spam channels. Store the `#beeper-feed` env in the extension's directory beside its owner-only cursor and delivery queue. Only the settings file is required to enable it.
