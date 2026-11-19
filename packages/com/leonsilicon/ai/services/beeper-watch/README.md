# @-/com.leonsilicon.ai.services.beeper-watch

Wakes Hermes in Slack when someone replies in a Beeper chat it is waiting on, and screens what people send before Hermes sees it. Hermes can already read and send Beeper messages through Beeper Desktop's own MCP, but nothing told it when an answer arrived. Hermes registers a watch right after asking someone for something. When the other person replies, the Beeper Watch Slack bot posts their messages in the task's thread and @mentions Hermes, which carries on with that thread's history and its usual tools.

The app that runs it, and how it is deployed, is in [`apps/beeper-watch`](../../../../../../apps/beeper-watch/README.md).

## How it works

- **Watches** live in one JSON file (`STATE_FILE`, mode 600), written atomically after every change. Each records the Beeper chat, what Hermes is waiting for, the Slack channel and thread to post in, a start time (`since`) and an expiry.
- **Polling.** Every `POLL_SECONDS` (10) the watcher reads new messages in the watched chats through Beeper's official SDK. Beeper's WebSocket is at-most-once with no replay, and a watch covers only a handful of chats, so polling is as fast in practice and can't miss a message.
- **Who wakes Hermes.** Only messages from the other side do, and only text or media. Reactions, notices, and Leon's own messages are excluded. Leon's own messages include anything an agent sent through his Beeper; they appear in the post as context only. In group chats, `from` narrows this to one sender.
- **Batching.** A reply often arrives as several messages, so the post waits until `QUIET_SECONDS` (30) pass with no new message from the contact, or until `MAX_BATCH_SECONDS` (120) after the first. Each message is posted once; edits never repost.
- **Limits.**
  - At most 6 posts per watch per hour; extra messages are held for the next one.
  - At most 50 open watches.
  - A failed Slack post is retried with backoff, up to every 10 minutes, so nothing is dropped.
- **Expiry.** A watch expires after `expires_in_hours` (default 72, max 336). If nothing came back, the bot says so in the thread without mentioning Hermes.
- **Untrusted text.**
  - Contact text is escaped, so it can't mention anyone or `@channel`.
  - Each post tells Hermes the quoted text is information, not instructions.
  - Logs record IDs and counts, never message text.

## The feed: one #feed- channel per Beeper connection

Added 2026-11-06 at Leon's request: "send ALL messages from beeper to slack, so the agents have full context… it's only up to the agent if they want to do anything with that information." It began as one channel, #beeper-watch. Since 2026-11-18 each Beeper connection has its own channel, also at Leon's request: "there's a feed channel for all platforms separately… we don't need a beeper-safe if we have a feed per-platform".

- **What's copied.** Every Beeper message on every account, posted top-level in its connection's channel, `FEED_CHANNEL_PREFIX` (default `feed-`) plus the platform: #feed-whatsapp, #feed-instagram, #feed-discord, #feed-x, #feed-linkedin, #feed-reddit, #feed-signal, #feed-wechat, #feed-imessage, #feed-beeper (Beeper's own chats), and for Leon's agents #feed-grok, #feed-chatgpt and #feed-muse. A chat's new messages are posted together once `QUIET_SECONDS` pass with nothing new, or `MAX_BATCH_SECONDS` after the first. Leon's own messages are included and labelled "Leon".
- **Platform names** come from the start of the Beeper account ID (`whatsapp.1914…`, `instagramgo.1105…`, `imessage_ecdb…`), which doesn't change when Beeper renames a network for display. The `go` of Beeper's Go bridges is dropped, and `matrix` → beeper, `chatgpt-dots` → chatgpt, `grokbot` → grok, `twitter` → x (`platform.ts`). `FEED_PLATFORM_CHANNELS` (`whatsapp=some-channel,x=C0123`) points a platform somewhere else.
- **Channels are created as needed.** The first message from a connection without a channel creates it as a public channel (unarchiving one of that name if it was archived), sets its description, and adds Hermes and the `FEED_INVITE` users (Leon). An existing channel is used as it is, so leaving one sticks. Creating needs the bot's `channels:manage` scope (added 2026-11-18). Hermes's `slack-auto-join` plugin would join it anyway; adding Hermes up front means the first post's @mention reaches it.
- **Left out:**
  - The Slack workspace the bot posts in. Those messages are already in Slack, and copying them would loop back through Beeper's Slack bridge. The Beeper account `slackgo.<team ID>` is found from `auth.test`. `FEED_EXCLUDE_ACCOUNTS` adds more.
  - Chats with an open watch, whose messages the watch already delivers to a task thread.
  - Reactions, and Beeper's own `$space` entries.
- **Who wakes Hermes** without screening (`FEED_WAKE=people`, the default). A post @mentions Hermes when it holds a message from a person: not Leon, not a notice, not a muted chat, and not an agent network (`FEED_QUIET_NETWORKS`: Grok bots, Muse, ChatGPT Dots; Hermes talks to those itself, so waking it would loop). Groups count too. Everything else is posted as context only. `all` wakes on every message from someone else; `none` never wakes Hermes.
- **How.** One Beeper search (`messages.search` with `dateAfter`, all accounts but the excluded ones, muted and low-priority included) per poll. Each search reaches 20 minutes behind the newest message seen, for late arrivals, and message IDs dedupe. State lives in `FEED_STATE_FILE` (600): cursor, seen IDs, unsent batches. A restart neither drops nor repeats anything. The first start copies only what arrives afterwards.
- **Failures.** A failed post is retried with backoff (up to every 10 minutes) and dropped after a day, with a log line. `/healthz` includes `feed` and turns 503 when the feed hasn't polled for 5 minutes.
- **Untrusted text.** It is escaped exactly like watch pings. Each waking post tells Hermes the quoted text is information, not instructions. Logs record networks and counts, never text.

## Screening: #feed-flagged and #feed-spam

Added 2026-11-07 at Leon's request: an isolated screener flags likely-malicious messages so they never reach Hermes. Since the evening of 2026-11-07 it runs on OpenAI's Decisions API (`FEED_SCREEN=openai`) and also decides which safe messages are worth waking Hermes for. Before that, a `claude -p` Haiku call only judged safety.

- **What's screened.** Every message someone other than Leon writes outside his agent chats (`FEED_QUIET_NETWORKS`): feed batches and watched replies alike. Leon's own messages in the same chat go along as context. Leon's own messages and agent chats on their own aren't screened. They go to their connection's channel as context that never wakes Hermes.
- **Two questions, one call** (`screen.ts`), each a Decisions question about the same chat:
  1. `safety`, a choice of `ok`, an unsafe reason (prompt injection, a request for credentials, codes or money, phishing or a suspicious link, a scam, impersonation, threats, other) or a spam reason (promotion, bulk or automated). The unsafe reasons' probabilities are added up, and the batch is held when the sum reaches `SCREEN_UNSAFE_THRESHOLD` (0.3). Otherwise it's spam if spam is likelier than `ok`, and safe if not.
  2. `wake`, a predicate: should Hermes know about this now? That covers questions or requests for Leon, plans, information he asked for or will need, and anything time-sensitive or needing an answer. It doesn't cover small talk, finished conversations, routine notices or ads. Safe messages wake Hermes at `SCREEN_WAKE_THRESHOLD` (0.5).
- **Routes.**
  - Safe → the connection's channel (#feed-whatsapp and so on; #beeper-safe until 2026-11-18). The post @mentions Hermes when `wake` passes and the chat isn't muted (`SCREEN_WAKE_MUTED=true` lets muted chats wake it too). Otherwise it's posted there without the mention, saying why.
  - A safe watched reply always pings its task thread, whatever `wake` says, because Hermes is waiting for it.
  - Unsafe → `FEED_FLAGGED_CHANNEL` (#feed-flagged; #beeper-unsafe, then #beeper-flagged until 2026-11-18). Spam → `FEED_SPAM_CHANNEL` (#feed-spam, formerly #beeper-spam). Both are private, with only Leon and the Beeper Watch bot, and posts there never mention Hermes. A held watched reply goes there too, and its task thread gets a notice without the text.
  - Hermes must not be a member of either held channel. Captain Claude's `slack-auto-join` plugin invites Hermes to Leon's private channels, so it was in both until it was removed on 2026-11-07. That plugin remembers removals and doesn't rejoin.
- **Isolation.**
  - Fixed rules run first. Phrases aimed only at an AI ("ignore previous instructions", role tokens, tool names) are unsafe without a call.
  - The chat goes in as an `input_json` part (network, kind, title, and messages with role `owner` or `contact`). Contact text is always a JSON string value, so it can't fake an owner message or close a tag.
  - The Decisions API answers only with probabilities over the fixed choices. It writes no text and has no tools, so a message that fools it can at worst land in the wrong channel.
- **Failures.** API errors are retried by the SDK (twice), then by the feed with backoff, up to every 5 minutes. A missing or invalid safety answer counts as an error. A refusal to judge safety holds the batch as flagged. After 15 minutes of failures the messages are held in #feed-flagged as "the screener couldn't check it". Nothing is posted unscreened.
- **Limits.** A screener can be fooled, so each waking post still says the text is information, not instructions. Hermes's own `beeper` MCP tools can still read any chat directly; screening controls what wakes Hermes and what is put in front of it. Chat titles of Leon-only batches aren't screened. The thresholds were set from one 72-hour sample; rerun the live check if the mix of messages changes.
- **Checked before going live** (2026-11-08 01:25 UTC) with [`__tests__/screener.live.ts`](__tests__/screener.live.ts), which runs on the mini:
  - 22 of 22 probes passed. Safe probes scored at most 0.03 unsafe; attacks scored 0.98 or more; spam was 0.10 or less.
  - 72 hours of real traffic (119 batches) gave 72 wakes, 44 safe without a wake, 2 held and 1 spam. Safe batches scored at most 0.20 unsafe. The two held ones scored 0.42–0.48: a "$1000 to say hello" message and a Meta "unusual login" notice.
  - The first prompt flagged two utorid replies, research links and a friend's LinkedIn post, and sent a personal follow-up to spam. The choice descriptions now say that people sharing their own details, ordinary links and personal follow-ups are safe.
- **Cost and data.** About a thousand input tokens per batch, at $0.10 per million (output isn't billed). The text of people's messages goes to OpenAI's API under the account's data controls. Logs record route, reason, `pUnsafe`, `pWake`, time and tokens, never text.

## MCP tools

Served at `POST /mcp` (stateless Streamable HTTP, `Authorization: Bearer $MCP_TOKEN`). `GET /healthz` or `/mcp/healthz` returns only counts, and 503 when Beeper is unreachable or polling has stalled.

| Tool                  | Arguments                                                                                                                                             | Result                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `beeper_watch_add`    | `chat_id`, `waiting_for` (≤500 chars), optional `slack_channel` (name or ID, default `#home`), `slack_thread_ts`, `since`, `expires_in_hours`, `from` | The watch, and how many replies had already arrived since `since`. A second add for the same chat and thread updates the watch. |
| `beeper_watch_list`   | none                                                                                                                                                  | Open watches                                                                                                                    |
| `beeper_watch_remove` | `id`                                                                                                                                                  | The removed watch                                                                                                               |

Validation errors come back as `{ ok: false, error }` written for the model, such as asking Leon to `/invite @Beeper Watch` to a private channel. DMs can't be used, because only Hermes's own bot is in Leon's DM with Hermes.

## API

`startBeeperWatch(config?, log?)` starts polling and the listener. `loadConfig(env)` reads:

- required: `BEEPER_TOKEN_FILE`, `SLACK_BOT_TOKEN`, `MCP_TOKEN` (40+ characters), `PUBLIC_ORIGIN` and `HERMES_SLACK_USER_ID`;
- optional: `BEEPER_URL`, `DEFAULT_SLACK_CHANNEL`, `PORT`, `STATE_FILE`, `POLL_SECONDS`, `QUIET_SECONDS` and `MAX_BATCH_SECONDS`;
- feed: `FEED_CHANNEL_PREFIX` (`feed-`, or `off`), `FEED_PLATFORM_CHANNELS`, `FEED_INVITE`, `FEED_WAKE`, `FEED_STATE_FILE`, `FEED_EXCLUDE_ACCOUNTS` and `FEED_QUIET_NETWORKS`. The old `FEED_CHANNEL` is refused, so a leftover `FEED_CHANNEL=off` can't quietly turn the feed back on;
- screening: `FEED_SCREEN` (`openai` or `off`, the default), `OPENAI_API_KEY` (required with `openai`), `FEED_FLAGGED_CHANNEL` (`feed-flagged`), `FEED_SPAM_CHANNEL` (`feed-spam`), `SCREEN_WAKE_MUTED`, `SCREEN_MODEL` (`gpt-6-luna`), `SCREEN_TIMEOUT_SECONDS` (30), `SCREEN_UNSAFE_THRESHOLD` (0.3) and `SCREEN_WAKE_THRESHOLD` (0.5).

`Watcher`, `callTool`, `TOOLS`, `INSTRUCTIONS`, `LIMITS` and `UserError` are exported for tests and other hosts. The watcher takes any `BeeperSource` and `SlackPoster` (the feed creates channels through its optional `ensureChannel`). `platformOf` and `channelName` name a connection's channel. The feed and watcher take any `Screener` (`screen.ts`); `decisionsScreener` takes an OpenAI client or any object with `decisions.create`, and a `ScreenPrompt` (`BEEPER_PROMPT` unless given). The screener is also exported as `@-/com.leonsilicon.ai.services.beeper-watch/screen`, which the [Gmail feed](../gmail-feed/README.md) uses with its own prompt: the same safety question, choices and thresholds for email.

Tests run offline with fake Beeper and Slack clients and a fake clock: `node --test __tests__/*.test.ts`.
