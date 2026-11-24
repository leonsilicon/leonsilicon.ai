# @-/ai.leonsilicon.services.feed-common

Shared by Gmail Feed and Beeper Feed. `slackBot` posts to Slack with link previews off and resolves or creates feed channels. `decisionsScreener` uses fixed injection rules and OpenAI Decisions to route messages to the safe, flagged or spam channel. A feed can supply an optional wake question alongside the safety classification.

[Autotrigger](../autotrigger/README.md) uses `decisionsClient` for issue matching and `ruleVerdict` to screen for prompt injection.
