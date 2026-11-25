# @-/ai.leonsilicon.services.slack22chatgpt

Hermes hands work to Silicon Dot through the Beeper inbox’s `send_message` on the `chatgpt` network. It passes the issue’s Slack channel ID and thread root timestamp. The inbox appends instructions to start or resume the Codex session named `Task slack:<channel>/<thread_ts>` and return its private session link. Both coordinates are used to find the session.

Codex exchanges messages with Hermes, Muse, and Grok Bot in that same Slack thread using [Slack Puppet](../slack-as-leon/README.md#grok-bots). It posts its start, milestones, blockers, and final result. On its first read it can use the thread root as `after` to pick up peer replies that arrived before its own post. To address a collaborator, start the reply with `To Muse:` or `To Grok Bot:`. Hermes tracks the reports and keeps a progress message in the issue channel.

Configure the Codex environment with Slack Puppet before dispatching. The [hermes-thread client](../../configs/silicon-dot/hermes-thread/README.md) supports the MacBook’s Keychain and the cloud environment’s secret store.
