# @-apps/orca-bridge

Runs the [Orca bridge](../../packages/com/leonsilicon/ai/services/orca-bridge/README.md) on the always-on Mac mini (since 2026-11-12), so Hermes Cloud keeps Orca when the MacBook sleeps. Public URL: `https://orca.leonsilicon.ai`, through the [ai-gateway](../ai-gateway/README.md).

```text
Hermes Cloud ──▶ orca.leonsilicon.ai ──▶ mini: orca-bridge 127.0.0.1:18787 ──▶ orca CLI ──▶ mini's Orca (default)
                                                                                         └──▶ --environment MacBook ──▶ MacBook's Orca
```

## Pieces

| Piece       | Where                                                                                                                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service     | Mini, as its usual user: LaunchAgent `com.leonsilicon.orca-bridge` (KeepAlive), app in `~/.local/share/orca-bridge/app`, logs in `~/.local/share/orca-bridge/logs/`                                                                                |
| Config      | Mini `~/.config/orca-bridge/env` (mode 600), written by `--start` from the `#orca-bridge` items of the root [`.env.schema`](../../.env.schema). `ORCA_BRIDGE_TOKEN` and `ORCA_MCP_ROOTS` (paths on the mini) are in Infisical under `/orca-bridge` |
| MacBook     | Saved Orca environment `MacBook` on the mini, paired 2026-11-12 from an offer made on the MacBook with `orca pair --address <the MacBook's tailnet IP> --grant-desktop-control` (no restart). Computer use on the MacBook works through it         |
| Mini's Orca | Headless `orca serve` LaunchAgent `dev.onorca.serve`, attributed to `com.stablyai.orca` for Accessibility and Screen Recording                                                                                                                     |
| Hermes      | Captain Claude's `orca` MCP server, `Authorization: Bearer <ORCA_BRIDGE_TOKEN>`, `timeout: 180`                                                                                                                                                    |

## Deploy

```sh
apps/orca-bridge/_deploy-orca-bridge.sh          # copy the workspace to the mini and install
apps/orca-bridge/_deploy-orca-bridge.sh --start  # also write the env file from Infisical and restart the LaunchAgent
```

`--start` needs Infisical access (see [DEVELOPMENT.md](../../DEVELOPMENT.md#secrets-and-config)); it stops before touching the env file or the service if any value is missing. Check: `curl -s https://orca.leonsilicon.ai/healthz`, and `ssh mini 'tail ~/.local/share/orca-bridge/logs/*.log'`.

## Operating it

- **Rotate the token.** New `openssl rand -hex 32` as `ORCA_BRIDGE_TOKEN` in Infisical, deploy with `--start`, then update Captain Claude's `orca` header and restart its gateway when no agents are active (a changed URL or header is not reconnected otherwise).
- **Re-pair the MacBook.** On the MacBook: `orca pair --address <its tailnet IP> --grant-desktop-control --json`; on the mini: `orca environment rm MacBook`, then `orca environment add --name MacBook --pairing-code '<pairingUrl>'`. Keep the code out of logs and chats.
- **Turn it off.** `launchctl bootout gui/$(id -u)/com.leonsilicon.orca-bridge` on the mini, or remove the `orca` route from the gateway.
