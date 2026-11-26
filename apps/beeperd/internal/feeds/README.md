# feeds

Seven one-way copies of Leon's Beeper chats into Slack, one feed for each network. They are services inside [beeperd](../../README.md) and read its journal.

| Feed              | Beeper network | Slack channel     |
| ----------------- | -------------- | ----------------- |
| `discord2slack`   | `discord`      | `#feed-discord`   |
| `instagram2slack` | `instagram`    | `#feed-instagram` |
| `linkedin2slack`  | `linkedin`     | `#feed-linkedin`  |
| `reddit2slack`    | `reddit`       | `#feed-reddit`    |
| `wechat2slack`    | `wechat`       | `#feed-wechat`    |
| `whatsapp2slack`  | `whatsapp`     | `#feed-whatsapp`  |
| `x2slack`         | `x`            | `#feed-x`         |

Each feed has its own settings, journal cursor and pending deliveries. A feed starts at the journal head on first use and resumes at its saved cursor on restart. A journal change wakes the feed as soon as it is written; between changes and scheduled retries it is idle. The room's network and any configured room IDs are checked before screening or delivery. Pending edits update the queued copy and redactions drop it. Slack receives a text snapshot with the sender, the conversation and the original room and event IDs. Attachments and the original message stay in Beeper.

A model screens every message before it is posted (`screener.go`, `gpt-6-luna`): spam and flagged messages go to the configured private channels instead of the network's channel. Everything in a message is treated as untrusted data. Screening failures are retried for 15 minutes, then the message is held in the flagged channel. Slack delivery retries with backoff for up to seven days. Each feed reports pending, posted and expired counts in the daemon's status.

## Enable a feed

1. Run `vpx _env-file <name>` and install the result as `/opt/data/beeperd/<name>/env` (mode 600). The keys are `SLACK_BOT_TOKEN`, `OPENAI_API_KEY`, `FEED_FLAGGED_CHANNEL`, `FEED_SPAM_CHANNEL` and, optionally, `FEED_INVITE`.
2. To limit a feed to particular chats, add `BEEPER_ROOM_IDS` as a comma-separated list of exact Matrix room IDs (`beeperd tool list_conversations '{"network":"whatsapp"}'` lists them). Without it the feed copies every conversation of its network.
3. Restart the daemon (`beeperd restart`) and check `status.extensions` under the feed's name. A feed can be healthy with an old `last_tick_at` while its journal is idle.

Move a feed's settings file out of its directory and restart the daemon to pause it. Restoring the file resumes from its saved cursor. Keep room IDs and settings on Hermes Cloud.

## Test

```sh
go -C apps/beeperd test ./internal/feeds/
```

The tests replay what the TypeScript feeds did (`testdata/`): settings files, Slack copies, screening answers and 300 random scenarios, compared at every pass.
