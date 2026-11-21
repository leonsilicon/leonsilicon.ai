# @-apps/beeper-watch

Runs [Beeper Watch](../../packages/com/leonsilicon/ai/services/beeper-watch/README.md). When someone answers in Beeper, Hermes Cloud (Captain Claude) is woken in the Slack thread of the task that was waiting for the answer. It also copies every Beeper message to Slack, one #feed- channel per Beeper connection, screened first so that unsafe messages and spam are held in the private #feed-flagged and #feed-spam.

**Since 2026-11-21 it runs on Hermes Cloud**, as an extension of the [Beeper inbox](../beeper-inbox/README.md) daemon, and reads Beeper through that inbox. From 2026-11-06 until then it ran on the Mac mini and polled Beeper Desktop.

## On Hermes Cloud

```text
Hermes ─stdio MCP─▶ beeper-inbox.mjs mcp beeper-watch ─unix socket─▶ beeper-inbox daemon ─▶ Beeper Watch ─▶ Slack
                                                                        ▲ journal: every new message, from sync
```

| Piece    | Where                                                                                                                                                                                                                                                                               |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code     | Part of the beeper-inbox release (`app/beeper-inbox.mjs`). It is deployed with it: `vpr -w build:beeper-inbox`, upload, `install.sh`                                                                                                                                                |
| Settings | `/opt/data/beeper-inbox/beeper-watch/env` (mode 600): the `#beeper-watch` items of the root [`.env.schema`](../../.env.schema) as `vpx _env-file beeper-watch` renders them, without `MCP_TOKEN`, `BEEPER_TOKEN_FILE` and `PUBLIC_ORIGIN`, which only the mini's HTTP server needed |
| State    | `/opt/data/beeper-inbox/beeper-watch/state/watches.json` and `feed.json` (mode 600)                                                                                                                                                                                                 |
| Logs     | The inbox's `logs/daemon.log`, tagged `beeper-watch`: networks and counts, never text                                                                                                                                                                                               |
| Health   | `node /opt/data/beeper-inbox/app/beeper-inbox.mjs status`, under `extensions.beeper-watch`: watches, the feed's last pass, and any error                                                                                                                                            |
| Hermes   | `mcp_servers.beeper-watch`: `command: node`, `args: [/opt/data/beeper-inbox/app/beeper-inbox.mjs, mcp, beeper-watch]`. The entry it replaced is in `/opt/data/backups/mcp-beeper-watch-mini-20261121.json`                                                                          |

- **Change a setting or rotate a token.** Change it in Infisical, render the file again, put it in place, and run `beeper-inbox.mjs restart`.
- **Turn it off.** Remove the `env` file and restart the daemon: the extension stays off and says so. Or `DRY_RUN=1` in it to stop only the posting.
- **The Slack token, the OpenAI key and held messages sit on the machine Hermes's own shell can read.** That was accepted for getting off the mini; the alternative is running the screening and posting half as a Worker.

### The move (2026-11-21)

Beeper Desktop on the mini had frozen about 20 seconds after every launch since 2026-11-19. The feed's position there was stuck at 2026-11-19 18:07 UTC: nothing received after that reached the #feed- channels, and three watches held replies they couldn't deliver.

1. **A dry run beside it.** `DRY_RUN=1` and `FEED_SCREEN=off` on Hermes Cloud for a few minutes. It skipped this Slack workspace's own bridged channels, as it must, and would have posted a Note to self test to #feed-beeper without waking Hermes.
2. **The mini's service stopped.** `com.leonsilicon.beeper-watch` booted out and disabled there.
3. **Watches moved.** The seven open watches were copied over with their undelivered replies. Each one's start moved up to the last moment the mini saw anything in it, and its list of seen message IDs was dropped, because Beeper Desktop's IDs mean nothing to the new source.
4. **The feed's position** was set to where the inbox's journal begins (2026-11-21 15:38 UTC). What arrived between 2026-11-19 18:07 and then was never copied to the feed channels.
5. **Live.** Within seconds the Task Bot, Grok Bot, Google Bot and SICIEEIL Bot watches delivered two days of replies to their threads, and the feed posted what had arrived since the journal began.

To go back, Beeper Desktop on the mini has to work again. Then: restore Hermes's saved server entry and restart its gateway when idle, remove the `env` file on Hermes Cloud and restart the inbox daemon, and on the mini run `launchctl enable gui/$(id -u)/com.leonsilicon.beeper-watch` and `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.leonsilicon.beeper-watch.plist`.

## On the Mac mini (until 2026-11-21)

The rest of this page describes the stand-alone service as it ran there.

```text
Hermes ──beeper_watch_add──▶ mini: beeper-watch (127.0.0.1:18789) ──polls──▶ Beeper Desktop (127.0.0.1:23373)
   ▲                                   │
   └──── @mention in the task thread ◀─┘  posted by the "Beeper Watch" Slack bot
```

## Pieces

| Piece         | Where                                                                                                                                                                                                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service       | Mini, as its usual user: LaunchAgent `com.leonsilicon.beeper-watch` (KeepAlive), app in `~/.local/share/beeper-watch/app`, logs in `~/.local/share/beeper-watch/logs/`, watches in `~/.local/share/beeper-watch/watches.json`                                                                |
| Config        | Mini `~/.config/beeper-watch/env` (mode 600), written by `--start` from the `#beeper-watch` items of the root [`.env.schema`](../../.env.schema). Values are in Infisical under `/beeper-watch`, including the channel IDs and the Slack user IDs                                            |
| Beeper token  | Shared with the Grok relay, `~/.local/share/grok-relay-hermes/beeper.json` ("Hermes → Grok Bot relay (Mac mini)"). It is read on every call, so rotating it there needs no restart                                                                                                           |
| Slack app     | "Beeper Watch", with its own bot user. Scopes: `chat:write`, `chat:write.public`, `channels:read`, `groups:read`, and since 2026-11-18 `channels:manage` to create the #feed- channels ([manifest](@assets/slack-app-manifest.json)). Private channels need `/invite @Beeper Watch`          |
| Public route  | `https://watch.leonsilicon.ai` through the [ai-gateway](../ai-gateway/README.md) (since 2026-11-18; `watch.ai.leonsilicon.com` from 2026-11-13; `ai.leonsilicon.com/watch` from 2026-11-12; the Tailscale Funnel route `/watch` was removed). Health: `https://watch.leonsilicon.ai/healthz` |
| Hermes Cloud  | `mcp_servers.beeper-watch` in `/opt/data/config.yaml` with `Authorization: Bearer ${BEEPER_WATCH_MCP_TOKEN}` (value in `/opt/data/.env`). The Beeper Watch bot user is in `SLACK_ALLOWED_USERS`, so its @mentions get through `allow_bots: mentions`                                         |
| Screener      | OpenAI Decisions API (`gpt-6-luna`), with `FEED_SCREEN=openai` and `OPENAI_API_KEY` from Infisical. Details in the [service README](../../packages/com/leonsilicon/ai/services/beeper-watch/README.md#screening-feed-flagged-and-feed-spam)                                                  |
| Standing rule | Last entry of Captain Claude's `/opt/data/memories/MEMORY.md`: register a watch after asking anyone for something through Beeper. Sessions load it when they start, so a thread that was already running needs `/new` or an explicit "watch for their reply"                                 |

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
