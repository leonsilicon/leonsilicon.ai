# @-apps/beeper-watch

Runs [Beeper Watch](../../packages/com/leonsilicon/ai/services/beeper-watch/README.md) on the always-on Mac mini (set up 2026-11-06). When someone answers in Beeper, Hermes Cloud (Captain Claude) is woken in the Slack thread of the task that was waiting for the answer. It also copies every Beeper message to Slack, so Hermes has his full context and can act on things like a new Instagram DM. Since 2026-11-07 messages from people are screened first by OpenAI's Decisions API, which answers two questions: is it safe, and should Hermes know about it? Since 2026-11-18 each Beeper connection has its own channel, #feed-whatsapp, #feed-instagram, #feed-grok and so on, which the bot creates when a connection's first message arrives. Safe messages go there and wake Hermes only when it should know. Leon's own messages and his agent chats go there too, as context. Unsafe ones and spam are held in the private #feed-flagged (formerly #beeper-unsafe, then #beeper-flagged) and #feed-spam (formerly #beeper-spam), which Hermes must not be in. #beeper-safe was archived that day. #beeper-watch gets no feed posts any more, but Hermes still uses its threads for some watches.

```text
Hermes ──beeper_watch_add──▶ mini: beeper-watch (127.0.0.1:18789) ──polls──▶ Beeper Desktop (127.0.0.1:23373)
   ▲                                   │
   └──── @mention in the task thread ◀─┘  posted by the "Beeper Watch" Slack bot
```

## Pieces

| Piece         | Where                                                                                                                                                                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service       | Mini, as its usual user: LaunchAgent `com.leonsilicon.beeper-watch` (KeepAlive), app in `~/.local/share/beeper-watch/app`, logs in `~/.local/share/beeper-watch/logs/`, watches in `~/.local/share/beeper-watch/watches.json`                                                                                 |
| Config        | Mini `~/.config/beeper-watch/env` (mode 600), written by `--start` from the `#beeper-watch` items of the root [`.env.schema`](../../.env.schema). Values are in Infisical under `/beeper-watch`, including the channel IDs and the Slack user IDs                                                             |
| Beeper token  | Shared with the Grok relay, `~/.local/share/grok-relay-hermes/beeper.json` ("Hermes → Grok Bot relay (Mac mini)"). It is read on every call, so rotating it there needs no restart                                                                                                                            |
| Slack app     | "Beeper Watch", with its own bot user. Scopes: `chat:write`, `chat:write.public`, `channels:read`, `groups:read`, and since 2026-11-18 `channels:manage` to create the #feed- channels ([manifest](@assets/slack-app-manifest.json)). Private channels need `/invite @Beeper Watch`                           |
| Public route  | `https://watch.leonsilicon.ai` through the [ai-gateway](../ai-gateway/README.md) (since 2026-11-18; `watch.ai.leonsilicon.com`, still an alias, from 2026-11-13; `ai.leonsilicon.com/watch` from 2026-11-12; the Tailscale Funnel route `/watch` was removed). Health: `https://watch.leonsilicon.ai/healthz` |
| Hermes Cloud  | `mcp_servers.beeper-watch` in `/opt/data/config.yaml` with `Authorization: Bearer ${BEEPER_WATCH_MCP_TOKEN}` (value in `/opt/data/.env`). The Beeper Watch bot user is in `SLACK_ALLOWED_USERS`, so its @mentions get through `allow_bots: mentions`                                                          |
| Screener      | OpenAI Decisions API (`gpt-6-luna`), with `FEED_SCREEN=openai` and `OPENAI_API_KEY` from Infisical. Details in the [service README](../../packages/com/leonsilicon/ai/services/beeper-watch/README.md#screening-feed-flagged-and-feed-spam)                                                                   |
| Standing rule | Last entry of Captain Claude's `/opt/data/memories/MEMORY.md`: register a watch after asking anyone for something through Beeper. Sessions load it when they start, so a thread that was already running needs `/new` or an explicit "watch for their reply"                                                  |

Hermes 0.23 picked up the new MCP server and the `.env` change on its next turn without a gateway restart (`MCP servers reconciled with config … added=['beeper-watch']`).

## Deploy

```sh
apps/beeper-watch/_deploy-beeper-watch.sh          # copy the workspace to the mini and install
apps/beeper-watch/_deploy-beeper-watch.sh --start  # also write the env file from Infisical and restart the LaunchAgent
```

`--start` needs Infisical access (see [DEVELOPMENT.md](../../DEVELOPMENT.md#secrets-and-config)); it stops before touching the env file or the service if any value is missing. `DEPLOY_HOST` overrides the SSH host (default `mini`). Check with:

```sh
ssh mini 'tail ~/.local/share/beeper-watch/logs/beeper-watch.log; curl -s 127.0.0.1:18789/healthz'
```

## Operating it

- **Rotate the MCP token.** Put a new `openssl rand -hex 32` in Infisical as `MCP_TOKEN`, deploy with `--start`, then set `BEEPER_WATCH_MCP_TOKEN` to the same value on Captain Claude (dashboard `PUT /api/env`).
- **Rotate the Slack token.** Reinstall the app from its page at api.slack.com/apps, then update `SLACK_BOT_TOKEN` in Infisical and deploy with `--start`.
- **Turn it off.** `launchctl bootout gui/$(id -u)/com.leonsilicon.beeper-watch` on the mini, and remove the `watch` route from the ai-gateway. Then remove the `beeper-watch` server from Captain Claude's config and its bot user from `SLACK_ALLOWED_USERS`.
- **Outages.** It depends on Beeper Desktop being up on the mini, like Hermes's `beeper` server. `/healthz` returns 503 when Beeper is unreachable or polling has stalled. Replies that arrive during an outage are picked up on the next poll, as long as the watch hasn't expired.

## Verified 2026-11-06

A watch on the Sentry Bot chat posted "ok" into an `#agents` test thread (`1793993539.427599`) about 40s after the bot answered. Hermes replied 12s later, reacted ✅, and removed the watch itself.
