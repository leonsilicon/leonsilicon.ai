# @-/ai.leonsilicon.services.autotrigger

Autotrigger uses the OpenAI Decisions API to match new Slack messages in `#feed-*` channels with Linear issues in **Awaiting Trigger**. A new email copied to `#feed-gmail` or a reply in a Slack feed thread can satisfy an issue's wait. The decision uses the issue's title, description and AutoLinear workflow details, including `who` and `event`. It uses the earlier messages in a Slack thread as context for short replies.

When there is one clear match, the slack22linear bot mentions Hermes in the mapped issue channel and links the exact source message. It checks the issue again before posting. The notification leaves the issue's status for Hermes or Leon to update through the usual workflow. Ambiguous matches, expired waits, spam, and flagged messages stay quiet.

## Runtime

[AutoLinear](../../../../../apps/autolinear/README.md)'s Slack user event subscription covers public feeds Leon has joined. [slack22linear](../../../../../apps/slack22linear/README.md)'s bot event subscription also covers public and private feeds the bot has joined. Autotrigger keeps one delivery per Slack channel and timestamp, even if both subscriptions see it. Slack Connect channels and the configured spam and flagged channels are excluded.

The slack22linear Worker runs each decision and delivery in a separate Durable Object. The alarm retries transient failures and the object keeps a completion marker for three days. The Worker uses the existing `OPENAI_API_KEY`, `FEED_FLAGGED_CHANNEL` and `FEED_SPAM_CHANNEL` in Infisical under `/gmail-feed`. It uses the existing Slack session to read feed threads and the slack22linear bot to post. Both Workers deploy on push to `main`. Check `/healthz` on slack22linear for configuration and look for `autotrigger_failed` in its Worker logs for delivery failures.
