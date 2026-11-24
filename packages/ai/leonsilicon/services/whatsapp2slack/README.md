# @-/ai.leonsilicon.services.whatsapp2slack

Copies new WhatsApp messages from the Beeper inbox to Slack. You can select conversations by Matrix room ID. Safe copies go to `#feed-whatsapp`; flagged messages and spam go to the shared private channels. Each copy includes the sender, the conversation and the original room and event IDs.

See the [Beeper inbox runbook](../../../../../apps/beeper-inbox/README.md#slack-feeds) for enabling and monitoring this feed, and [beeper-to-slack](../beeper-to-slack/README.md) for how delivery works.
