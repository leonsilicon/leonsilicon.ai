# @-/ai.leonsilicon.services.grok-relay

The Grok Bot relay for Hermes (v1.4.0). It gives Captain Claude three MCP tools, `grok_bots`, `grok_bot_send` and `grok_bot_read`, that message Leon's Grok Bot bots in their own chats, as Leon and with no label. Leon's Grok bots answer only Leon and ignore Hermes in Slack, so this is how Hermes reaches them; Leon sees the whole exchange in Beeper.

It runs on Hermes Cloud, inside the [Beeper inbox](../beeper-inbox/README.md) daemon, and reaches the bots over Matrix through that inbox, with none of Leon's computers involved. Hermes's `grok` MCP server has pointed at it since 2026-11-21. From 2026-11-06 until then the relay ran on the Mac mini and went through Beeper Desktop ([`configs/grok-relay-hermes`](../../configs/grok-relay-hermes/README.md), v1.2.0); that copy is stopped.

## Tools

| Tool            | Does                                                                                                                                                                                                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grok_bots`     | Lists the bots: the one-to-one chats on Beeper's Grok Bot network, with when each was last active and how many messages are queued for it.                                                                                                                                                                        |
| `grok_bot_send` | Sends one task as Leon, with its Slack thread (`slack_channel`, `slack_thread_ts`, both required) and the handoff below, and waits up to `wait_seconds` (default 90, at most 150) for the reply, stopping 20 s after the bot goes quiet. A message to a bot that is still working is queued instead (see Policy). |
| `grok_bot_read` | The latest messages of one bot's chat, oldest first, with Hermes's own shown as "Hermes (as Leon)". `after` takes the cursor a send or an earlier read returned.                                                                                                                                                  |

A refused call comes back as `{ ok: false, error: { code: "grok_relay_error", message } }`, with a message written for Hermes: an unknown bot lists the ones there are, and a reached budget says what to ask Leon. The tool descriptions and the server instructions in `tools.ts` carry Leon's rules (how to write as him, what Hermes may approve for him, how to save Grok usage), so they change only when he changes a rule.

## Slack handoff (v1.4.0, 2026-11-21)

Leon's design: every task Hermes hands a Grok bot carries the Slack thread Hermes is working in, and the bot doesn't do the task in its own chat. It makes a task bot for it, named `Task slack:<channel>/<thread_ts>`, so the name says where to report, and that bot works with Hermes in that thread.

- **The relay adds it** (`handoff.ts`), so it is the same every time. After Hermes's text comes a block, in Leon's voice: the identifier, make the task bot under exactly that name (or pass the task on if one exists), give it the task and the block, then reply only with its name. It also tells the task bot to post in the thread with slack-puppet's Grok tools, that Hermes's answers there count as Leon's, and to delete itself with grokbot-admin when Hermes says the task is done. The result carries `slack_identifier` and `task_bot`.
- **One task bot per thread.** A task for a thread that already has a task bot (a bot named `Task slack:…/<thread_ts>`, whatever the channel was written as) goes to that bot, whichever bot Hermes named, with a short follow-up note instead of the block; the result says `redirected_from`. Deleted bots drop out of the list, so a thread whose task bot is gone gets a new one. The block also tells the parent to look for an existing bot by the thread's ts.
- **Queued tasks** keep their thread; when several go out merged, each thread's block follows once, naming its items when there are several threads.
- **Checks.** Both fields are required. The channel is an ID (`C…`, `G…`) or `#name`, never a DM, since Grok bots can post only in channel threads; the ts is a Slack ts.
- **The other pieces:** slack-puppet's Grok token and tools ([`slack-as-leon`](../slack-as-leon/README.md#grok-bots)), Hermes's [`slack-as-leon-guard`](../../../../com/leonsilicon/hermes/plugins/slack-as-leon-guard/README.md) (lets the task bot's posts through, labelled not-Leon) and [`slack-always-react`](../../../../com/leonsilicon/hermes/plugins/slack-always-react/README.md) (no 👀/✅ on them, so slack22linear doesn't close or hand over the issue), and [grokbot-admin](../grok-bot-roster/README.md) for the deletion.

## Policy

Grok Bot bills by agent steps and tokens, so every message starts a costly run (`policy.ts`, since v1.2.0 of 2026-11-07).

- **Busy bots.** A bot counts as busy when Leon's last message has no reply yet (for up to 10 minutes), when it posted in the last 60 s, or when it has only acknowledged so far. A message for a busy bot is queued. The flusher sends a bot's queue as one numbered message when the bot goes idle, or after 20 minutes. `urgent: true` skips the queue, for a stop or a correction.
- **Budget.** 25 relayed messages per rolling hour. At the limit the call is refused and tells Hermes to ask Leon. His words, passed as `leon_approved_more`, allow 25 more that hour. Up to 5 urgent sends an hour go out past the limit.
- **Linear Bot and Todoist Bot** are refused unless `needs_bot_because` says what Hermes's own Linear and Todoist tools can't do.

## How it works

```text
Hermes ─stdio MCP─▶ beeper-inbox.mjs mcp grok-relay ─unix socket─▶ beeper-inbox daemon ─▶ relay ─inbox tools─▶ matrix.beeper.com
```

- **An extension of the inbox daemon** (`extension.ts`). Hermes starts each MCP server in several processes (the gateway, cron runs, dashboard chats), and the queue, the budget and the flusher need exactly one owner. The daemon already is the one owner of the Beeper device, so the relay runs in it, and every MCP server process is a stateless client of its socket.
- **It reaches Beeper only through the inbox** (`inbox-backend.ts`): `list_conversations` for the bots (network `grok`, one-to-one chats), `send_message` to send, and the inbox's journal of new messages to follow a chat. So the inbox's send ledger and its plaintext guard apply to the relay too.
- **It follows chats through the journal, not through history.** A page of history costs the inbox about half a second per message. The journal has every message as sync delivered it, so the relay waits on it for a reply (it answers the moment something arrives), judges whether a bot is busy from the chat's last 25 minutes in it, and serves a follow-up `grok_bot_read` from it. It reads one capped page of history (20 events at most) only when the journal can't answer: in its first 25 minutes after a gap, for a cursor older than its coverage, or for more of the latest messages than it holds.
- **Sends can't double.** Each send carries its own key, which the inbox turns into one Matrix transaction ID. A queue flush derives its key from the queued items, so a flush retried after a lost answer reuses it and the homeserver drops the repeat.
- **Bridge failures are errors.** When the Grok Bot bridge reports that a message failed, the send is refused with the bridge's reason and doesn't count against the budget.
- **Cursors** are `<timestamp>:<event ID>`. A cursor from the Beeper Desktop days was a plain number; `grok_bot_read` ignores one, says so, and returns the latest messages.
- **Replies that are still being written.** A bot may edit one message as it writes. An edit counts as activity, and the replies returned are the texts as they last read.
- **Old messages aren't replies.** Reading history, or a bridge filling in the past, can make sync deliver an old message. The wait only counts messages sent after the relay's own (with a minute of slack for clocks).

Differences from the Beeper Desktop version: `grok_bots` no longer shows each bot's latest message (the inbox keeps no message text) or leaves archived chats out, and a bot renamed in Grok shows its new name only after the inbox's directory is rebuilt, which an unknown name triggers by itself.

## The switch (2026-11-21)

Hermes's log showed its Grok tools failing since the day before with "Beeper Desktop is not reachable on Leon's Mac mini": Beeper Desktop there froze about 20 seconds after every launch.

- **Tested on Hermes Cloud first**, from the command line: `grok_bots` listed the 14 bots in 0.16 s. One message to an idle bot ("quick test, just reply with ok" to Orca Bot) was answered 12 s later, and the relay returned the reply from the journal.
- **Config.** The old `grok` entry is saved in `/opt/data/backups/mcp-grok-relay-mini-20261121.json`. The new one is `command: node`, `args: [/opt/data/beeper-inbox/app/beeper-inbox.mjs, mcp, grok-relay]`.
- **Gateway.** A running gateway keeps the old server, so it was restarted while idle (no active agents). Slack, the relay platform and the API server reconnected within a minute.
- **From a Hermes session** (a one-off cron agent run): `grok_bots` returned 14 bots, and `grok_bot_read` showed the test exchange with Hermes's message as "Hermes (as Leon)".
- **The mini.** Its queue was empty and its log showed no use since 2026-11-19. `com.leonsilicon.grok-relay-hermes` was stopped and disabled there. `com.leonsilicon.beeper-watchdog` stays, since Beeper Watch moved here too only to keep Tailscale up.

To go back: restore the saved entry, restart the gateway when idle, and on the mini run `launchctl enable gui/$(id -u)/com.leonsilicon.grok-relay-hermes` and `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.leonsilicon.grok-relay-hermes.plist`. That path needs Beeper Desktop on the mini to work again. Its public address went with the gateway, the tunnel and the edge Worker, all removed on 2026-11-21, so that path would need a new route to the mini as well.

## State

Under the extension's directory, `/opt/data/beeper-inbox/grok-relay/state/` on Hermes Cloud (mode 600, written atomically):

| File               | What                                                                   |
| ------------------ | ---------------------------------------------------------------------- |
| `outbox.json`      | Messages queued for busy bots                                          |
| `budget.json`      | The last hour's sends and Leon's approvals                             |
| `hermes-sent.json` | The last 2,000 message IDs Hermes sent, so reads can tell it from Leon |

Events go to the inbox's `logs/daemon.log` tagged `grok-relay`: bot names, counts and reasons, never message text.

## Test

```sh
node --test packages/ai/leonsilicon/services/grok-relay/__tests__/*.test.ts
```

Offline, with a fake Beeper: the policy, the queue and its merged flush, a flush retried with the same key, the budget and its extension, waiting for a reply that is still being edited, cursors, the mapping from the inbox's tools and journal, and that a send with the journal reads no history.

Public API (`+server.ts`): `grokRelayExtension`, `createGrokRelay`, `inboxBackend`, `callTool`, `TOOLS`, `INSTRUCTIONS`.
