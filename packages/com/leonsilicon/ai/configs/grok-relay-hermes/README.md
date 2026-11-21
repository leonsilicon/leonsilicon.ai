# @-/com.leonsilicon.ai.configs.grok-relay-hermes

The Grok Bot relay for Hermes Cloud (v1.2.0, since 2026-11-06). It gives Captain Claude three MCP tools, `grok_bots`, `grok_bot_send` and `grok_bot_read`, that message Leon's Grok Bot bots through Beeper Desktop on the Mac mini, as Leon and with no label. Public URL: `https://grok.leonsilicon.ai`, through the [ai-gateway](../../../../../../apps/ai-gateway/README.md).

Its successor, which needs neither the mini nor Beeper Desktop, is the [grok-relay service](../../services/grok-relay/README.md): installed on Hermes Cloud on 2026-11-21 but not in use yet, so this copy is still the one Hermes talks to.

The files here are a byte-identical copy of what runs on the mini (imported 2026-11-12), kept as plain `.mjs` and outside the formatter so a diff shows any drift. They are not a workspace package.

| Here                                                     | On the mini                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| `server.mjs`                                             | `~/.local/share/grok-relay-hermes/adapter/server.mjs` (entrypoint) |
| `grok-relay.mjs`, `relay-policy.mjs`                     | same folder                                                        |
| `grok-relay.test.mjs`, `relay-policy.test.mjs`           | same folder (offline tests)                                        |
| `verify.mjs`, `beeper-token.mjs`, `beeper-mcp-token.mjs` | same folder (checks and Beeper token issuers)                      |
| `package.deployed.json`                                  | `adapter/package.json` (`@modelcontextprotocol/sdk` 1.32.2)        |
| `watchdog.sh`                                            | `~/.local/share/grok-relay-hermes/watchdog.sh`                     |

Secrets stay on the mini: `config.json` (`port` 18788, `publicOrigin`, `token`: the bearer Hermes sends), `beeper.json` (the relay's Beeper token) and `beeper-mcp.json` (Hermes's Beeper MCP token). State is in `state/`, logs in `logs/grok-relay.log`. The full operating notes, including the v1.2.0 usage policy (busy-bot merge queue, 25 sends per rolling hour, the Linear/Todoist Bot guard) and approval rules, are in the mini's `~/.local/share/grok-relay-hermes/README.txt`.

## Services

- `com.leonsilicon.grok-relay-hermes`: the relay (KeepAlive), `node adapter/server.mjs`.
- `com.leonsilicon.beeper-watchdog`: every 60 s relaunches Beeper Desktop or Tailscale if they aren't running. It restarts Beeper if its API is silent for 3 minutes, or if the API answers but chats are unusable for 5 minutes: an empty chat list, or a chat that won't open. That half-broken state followed a failed 4.3.308 update on 2026-11-13 and lasted hours unnoticed. A restart escalates from quit to TERM to KILL, because a stuck update dialog blocked the first two. `WATCHDOG_DRY_RUN=1` with `BEEPER_API`, `WATCHDOG_STATE` and `WATCHDOG_LOG` runs it against a test server without touching Beeper.

## Test

```sh
cd packages/com/leonsilicon/ai/configs/grok-relay-hermes && node --test relay-policy.test.mjs grok-relay.test.mjs
```

## Deploy a change

1. Edit here and run the tests.
2. On the mini, check `logs/grok-relay.log` for a `grok_send` in the last 150 s: a restart during its wait fails Hermes's call even though the message already went out.
3. `rsync` the changed `.mjs` files to `mini:.local/share/grok-relay-hermes/adapter/`, then `launchctl kickstart -k gui/$(id -u)/com.leonsilicon.grok-relay-hermes` there.
4. For 30 minutes after a start, the relay answers Hermes's keepalive pings with `tools/list_changed`, so description edits reach Hermes in about 3 minutes without a gateway restart.
