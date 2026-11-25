# @-/ai.leonsilicon.services.slack22grokbot

The `slack22grokbot` MCP extension delivers Hermes’s browser work, including work in signed-in sessions, in the bot's Beeper chat as Leon and connects the resulting task bot to its Slack thread.

It runs inside the [Beeper inbox](../beeper-inbox/README.md) daemon on Hermes Cloud and uses that inbox to reach Grok Bot over Matrix.

## Tools

| Tool                 | Does                                                                                                                                                                                                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grok_bots`          | Lists the bots: the one-to-one chats on Beeper's Grok Bot network, with when each was last active and how many messages are queued for it.                                                                                                                                                                        |
| `grok_bot_send`      | Sends one task as Leon, with its Slack thread (`slack_channel`, `slack_thread_ts`, both required) and the handoff below, and waits up to `wait_seconds` (default 90, at most 150) for the reply, stopping 20 s after the bot goes quiet. A message to a bot that is still working is queued instead (see Policy). |
| `grok_bot_read`      | The latest messages of one bot's chat, oldest first, with Hermes's own shown as "Hermes (as Leon)". `after` takes the cursor a send or an earlier read returned.                                                                                                                                                  |
| `grok_task_complete` | After Hermes verifies the result, drains pending Grok replies and retires the bot named for that exact Slack thread.                                                                                                                                                                                              |

A refused call comes back as `{ ok: false, error: { code: "slack22grokbot_error", message } }`, with a message written for Hermes: an unknown bot lists the ones there are, and a reached budget says what to ask Leon. The tool descriptions and the server instructions in `tools.ts` carry Leon's rules (how to write as him, what Hermes may approve for him, how to save Grok usage), so they change only when he changes a rule.

## Slack handoff

Every delegation carries the channel and root timestamp. The extension validates the thread with Slack before sending the handoff. The parent bot creates a worker named exactly `Task slack:<channel>/<thread_ts>`. The name gives the bridge its route.

Use the same thread as Muse and Codex. Grok Bot receives their Slack replies in its own chat and can prefix a question with `To Muse:` or `To Codex:`. Hermes records Grok Bot’s reports and edits in the issue channel’s [progress message](../../../../../apps/hermes-plugin-hermes22muse/README.md#shared-task-thread-and-progress).

- Beeper's [official Grok Bot connector](https://help.beeper.com/en_US/quick-references/ai-assistants-in-beeper) delivers the task bot's messages to the inbox journal. `slack22grokbot` copies them to Slack as marked Grok replies and applies Beeper edits to the same Slack message. Slack replies go back to the bot's Beeper conversation with the author's name. The bridge skips its own messages in both directions. Attachment messages carry their text or a file reference. Binary files and interactive cards stay in their source app.
- Hermes starts work with `grok_bot_send`, then answers the task bot in Slack. Once Hermes has verified the final result, it calls `grok_task_complete` with the same thread. The service drains pending Grok replies and asks [grokbot-admin](../grok-bot-roster/README.md) to delete the task bot by its pinned roster ID. A failed deletion stays pending for retry.
- Task bot names use the channel ID. Ambiguous routes and missing Slack roots show up in status. The service picks up new activity after installation and uses persisted cursors on restart.
- Hermes's [Slack guard](../../../../../apps/hermes-plugin-slack-as-leon-guard/README.md) recognizes the same Grok marker for mirrored posts.

### Enable on Hermes Cloud

Render `vpx _env-file slack22grokbot` into `/opt/data/beeper-inbox/slack22grokbot/slack22grokbot.env` with mode 600. The settings use the Slack Puppet and Grok Bot admin tokens.

Register `mcp_servers.slack22grokbot` in Hermes with `command: node` and `args: [/opt/data/beeper-inbox/app/beeper-inbox.mjs, mcp, slack22grokbot]`. Install the [Beeper inbox release](../../../../../apps/beeper-inbox/README.md#deploy), restart the Hermes gateway to load the MCP config, and check `status.extensions.slack22grokbot.running`.

When upgrading an existing installation, stop the Hermes gateway and Beeper inbox daemon before moving the complete extension directory to `/opt/data/beeper-inbox/slack22grokbot/`. Move the settings and persisted state together to preserve the queue, budget, and Slack sync progress. Align the MCP registration before starting the gateway.

## Policy

Grok Bot bills by agent steps and tokens, so every message starts a costly run (`policy.ts`).

- **Busy bots.** A bot counts as busy when Leon's last message has no reply yet (for up to 10 minutes), when it posted in the last 60 s, or when it has only acknowledged so far. A message for a busy bot is queued. The flusher sends a bot's queue as one numbered message when the bot goes idle, or after 20 minutes. `urgent: true` skips the queue, for a stop or a correction.
- **Budget.** 25 relayed messages per rolling hour. At the limit the call is refused and tells Hermes to ask Leon. His words, passed as `leon_approved_more`, allow 25 more that hour. Up to 5 urgent sends an hour go out past the limit.
- **Linear Bot and Todoist Bot** are refused unless `needs_bot_because` says what Hermes's own Linear and Todoist tools can't do.

## How it works

```text
Hermes ─stdio MCP─▶ beeper-inbox.mjs mcp slack22grokbot ─unix socket─▶ beeper-inbox daemon ─▶ relay ─inbox tools─▶ matrix.beeper.com
```

- **An extension of the inbox daemon** (`extension.ts`). Hermes starts each MCP server in several processes (the gateway, cron runs, dashboard chats), and the queue, the budget and the flusher need exactly one owner. The daemon already is the one owner of the Beeper device, so the relay runs in it, and every MCP server process is a stateless client of its socket.
- **It reaches Beeper only through the inbox** (`inbox-backend.ts`): `list_conversations` for the bots (network `grok`, one-to-one chats), `send_message` to send, and the inbox's journal of new messages to follow a chat. So the inbox's send ledger and its plaintext guard apply to the relay too.
- **It follows chats through the journal, not through history.** A page of history costs the inbox about half a second per message. The journal has every message as sync delivered it, so the relay waits on it for a reply (it answers the moment something arrives), judges whether a bot is busy from the chat's last 25 minutes in it, and serves a follow-up `grok_bot_read` from it. It reads one capped page of history (20 events at most) only when the journal can't answer: in its first 25 minutes after a gap, for a cursor older than its coverage, or for more of the latest messages than it holds.
- **Sends can't double.** Each send carries its own key, which the inbox turns into one Matrix transaction ID. A queue flush derives its key from the queued items, so a flush retried after a lost answer reuses it and the homeserver drops the repeat.
- **Bridge failures are errors.** When the Grok Bot bridge reports that a message failed, the send is refused with the bridge's reason and doesn't count against the budget.
- **Cursors** use `<timestamp>:<event ID>`.
- **Replies that are still being written.** A bot may edit one message as it writes. An edit counts as activity, and the replies returned are the texts as they last read.
- **Old messages aren't replies.** Reading history, or a bridge filling in the past, can make sync deliver an old message. The wait only counts messages sent after the relay's own (with a minute of slack for clocks).

## State

Under the extension's directory, `/opt/data/beeper-inbox/slack22grokbot/state/` on Hermes Cloud (mode 600, written atomically):

| File               | What                                                                   |
| ------------------ | ---------------------------------------------------------------------- |
| `outbox.json`      | Messages queued for busy bots                                          |
| `budget.json`      | The last hour's sends and Leon's approvals                             |
| `hermes-sent.json` | The last 2,000 message IDs Hermes sent, so reads can tell it from Leon |

`slack22grokbot.json` in the extension directory holds the Slack routes, delivery cursors, and pending retirements. Events go to the inbox's `logs/daemon.log` tagged `slack22grokbot`: bot names, counts and reasons, never message text.

## Test

```sh
node --test packages/ai/leonsilicon/services/slack22grokbot/__tests__/*.test.ts
```

Offline, with a fake Beeper: the policy, the queue and its merged flush, a flush retried with the same key, the budget and its extension, waiting for a reply that is still being edited, cursors, the mapping from the inbox's tools and journal, and that a send with the journal reads no history.

Public API (`+server.ts`): `slack22GrokBotExtension`, `createGrokDelegation`, `inboxBackend`, `callTool`, `TOOLS`, `INSTRUCTIONS`.
