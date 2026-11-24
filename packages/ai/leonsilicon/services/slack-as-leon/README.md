# @-/ai.leonsilicon.services.slack-as-leon

An MCP server that lets Hermes post in Slack as Leon, with no bot marker, using Leon's own Slack web session: a double puppet of his Slack account, in chat-bridge terms. It is served as `slack-puppet.leonsilicon.ai` and named `slack-puppet` in Hermes. It is a plain fetch handler with no Node or npm dependencies, and runs as a Cloudflare Worker. Deployment is in [`apps/slack-as-leon`](../../../../../apps/slack-as-leon/README.md).

## Why

Leon's Grok Bot bots in Slack answer only Leon. Anything a bot posts is ignored, including Hermes's own posts and Composio posts in Leon's name. A Slack app can only post as a user with that user's `xoxp-` token, and Slack stamps those posts with the app's `bot_id` and `app_id`. The only way to post without that stamp is the session Leon's browser uses: the `xoxc-` token plus its `d` cookie. A post made that way has the same shape as one Leon typed (`user`, `client_msg_id`, no `bot_id`, `app_id` or `bot_profile`; checked 2026-11-13).

## Tools

| Tool                 | Does                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slack_send_as_leon` | Posts `text` to `channel` (a `C…`/`G…`/`D…` ID, a `U…` user ID to DM, `#name` or `@Name`), optionally in `thread_ts`. Written-out bot names (`@Task Bot`) become real mentions. When a bot is mentioned or DMed it waits for the answer (default 90 s, max 150 s) until the answer has stopped changing for 8 s. Returns `channel`, `ts`, `thread_ts`, `permalink`, `replies` and a `cursor`. |
| `slack_read_as_leon` | Reads the answers to a message sent with `slack_send_as_leon`: its thread, plus top-level messages in a DM with a bot. `after` takes the cursor; `wait_seconds` waits for an answer. Refuses anything not sent through this server.                                                                                                                                                           |
| `slack_bots`         | Lists the workspace's bots with their `<@ID>` mention and Leon's DM channel with each.                                                                                                                                                                                                                                                                                                        |

The server's instructions tell Hermes to write as Leon (first person, never mentioning Hermes). They also tell it not to post where people will read it unless Leon asked, and never to raise money, login or security matters.

## Grok bots

Since 2026-11-21 (v2.2.0, Codex since v2.3.0) Leon's Grok Bot bots, and the Codex sessions Silicon Dot starts, use it too, to talk to Hermes in the Slack thread of a task Hermes handed them (see [the slack22grokbot handoff](../slack22grokbot/README.md#slack-handoff)). Grok bots connect with `SLACK_AS_LEON_GROK_TOKEN`, set as the `slack-puppet` server in Grok Bot's account-wide MCP config; Codex sessions with `SLACK_AS_LEON_CODEX_TOKEN`, through the [hermes-thread](../../configs/silicon-dot/hermes-thread/README.md) proxy on Leon's MacBook. Each gets its own instructions and two tools only:

| Tool                 | Does                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hermes_thread_send` | Posts a reply in a channel thread as Leon, starting `🤖 *<from_bot>*:`, and waits (default 90 s) for Hermes, or Leon, to answer. Needs `thread_ts` and `from_bot`. |
| `hermes_thread_read` | Reads what came after one of the bot's own posts in its thread.                                                                                                    |

- **Marked as a bot's.** Their `client_msg_id` is `de1e6a7e-b075-…` (Grok) or `de1e6a7e-c0de-…` (Codex): the usual first group, so autolinear, slack22linear and Hermes's autolinear plugin still skip it as "not Leon's words", and a second group Hermes's own posts never use. Hermes's `slack-as-leon-guard` lets those through with a note that a Grok bot wrote it, and `slack-always-react` puts no 👀/✅ on them, so slack22linear never reads one as Leon's message being answered.
- **Contained.** Only replies in channel threads: no DMs, no top-level posts, no mentions of people, bots or channels, and no broadcasts. A bot reads only the threads of its own posts.
- **Counted apart.** `SLACK_AS_LEON_GROK_MAX_PER_HOUR` and `SLACK_AS_LEON_CODEX_MAX_PER_HOUR` (120 each) an hour, in KV keys `grok:`/`codex:<ms>:<ts>`, so a busy task can't use up Hermes's 30.
- **Read back by Hermes**, an agent's post shows `from: "grok_bot"` or `"codex"`; read by the agent, Hermes's posts as Leon show `from: "hermes"`.

## Limits

- **Marker.** Every post's `client_msg_id` starts with `de1e6a7e` (`CLIENT_MSG_ID_PREFIX`), and the rest is random. Hermes's [`slack-as-leon-guard`](../../../../com/leonsilicon/hermes/plugins/slack-as-leon-guard/README.md) plugin drops events carrying it, so Hermes doesn't answer its own posts. Other bots don't see any difference.
- **Refused.** The users in `SLACK_AS_LEON_BLOCKED_USERS`, which is required (Silicon Dot, in practice): no DM and no mention. Silicon Dot acts on Leon's own messages, and Hermes hands it tasks through its Beeper chat (Leon's rule, 2026-11-12), not in Leon's name in Slack. Change this with `SLACK_AS_LEON_BLOCKED_USERS`. `@channel`, `@here` and `@everyone` are refused too.
- **Rate.** 30 messages per rolling hour (`SLACK_AS_LEON_MAX_PER_HOUR`), counted in a `RateStore` (Workers KV in production).
- **Reading.** It reads only the answers to its own posts, never other conversations. Hermes's read-only `slack` MCP covers channels its bot is in.
- **Records.** None are kept. Slack is the record: `slack_read_as_leon` fetches the message and checks its marker, so any instance can read the answers and nothing but the rate counter is stored. The log has one `sent` line per post with its length, never the text.

## API

- `loadConfig(env)`: settings from a string map (the Worker's secrets and vars).
- `sessionClient(session, fetch?)`: a `SlackCall` that sends the session the way the web client does, with one retry after a short 429.
- `new SlackAsLeon(settings, slack, rateStore, options?)`: `send`, `read`, `bots`, `sessionState()` (`ok`, `invalid` or `unknown`) and `leonId()`. `memoryRateStore()` is the in-memory `RateStore`.
- `createHandler(config, service, base?)`: stateless MCP over Streamable HTTP as a `(Request) => Promise<Response>`. `POST <base>` needs the bearer token; `GET <base>/healthz` answers 503 when the session is signed out or revoked. Tool calls are answered as an SSE stream with a keepalive comment every 15 s, because proxies cut responses that stay silent for about two minutes.
- `TOOLS`, `CLIENT_MSG_ID_PREFIX`, `newClientMsgId()`, `isMarked(id)`, `linkBotMentions(text, bots)`, `tsKey(ts)`.

## Test

```sh
node --test packages/ai/leonsilicon/services/slack-as-leon/__tests__/*.test.ts
```

The tests use a fake Slack and a fake clock, so they need no session.
