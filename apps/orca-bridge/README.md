# @-apps/orca-bridge

Ran the [Orca bridge](../../packages/com/leonsilicon/ai/services/orca-bridge/README.md) on the Mac mini from 2026-11-12, so Hermes Cloud kept Orca when the MacBook slept. Public URL: `https://orca.leonsilicon.ai`, through the [ai-gateway](../ai-gateway/README.md).

**Stopped on 2026-11-21.** Hermes Cloud has been its own [Orca device](../orca-device/README.md) since 2026-11-19 and no longer uses the bridge, so its LaunchAgent `com.leonsilicon.orca-bridge` was stopped and disabled (`launchctl bootout`, then `launchctl disable`). `orca.leonsilicon.ai` answers 502 until the route is removed with the rest of the gateway. The mini's own Orca (`dev.onorca.serve`) and its watchdog (`com.leonsilicon.orca-watchdog`) still run: Hermes's Orca device reaches the mini through them. To bring the bridge back: `launchctl enable gui/$(id -u)/com.leonsilicon.orca-bridge`, then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.leonsilicon.orca-bridge.plist` on the mini.

The rest of this page describes the bridge as it ran.

```text
Hermes Cloud ──▶ orca.leonsilicon.ai ──▶ mini: orca-bridge 127.0.0.1:18787 ──▶ orca CLI ──▶ mini's Orca (default)
                                                                                         └──▶ --environment MacBook ──▶ MacBook's Orca
```

## Pieces

| Piece       | Where                                                                                                                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Service     | Mini, as its usual user: LaunchAgent `com.leonsilicon.orca-bridge` (KeepAlive), app in `~/.local/share/orca-bridge/app`, logs in `~/.local/share/orca-bridge/logs/`                                                                                                      |
| Config      | Mini `~/.config/orca-bridge/env` (mode 600), written by `--start` from the `#orca-bridge` items of the root [`.env.schema`](../../.env.schema). `ORCA_BRIDGE_TOKEN` and `ORCA_MCP_ROOTS` (paths on the mini) are in Infisical under `/orca-bridge`                       |
| MacBook     | Saved Orca environment `MacBook` on the mini, paired 2026-11-12 from an offer made on the MacBook with `orca pair --address <the MacBook's tailnet IP> --grant-desktop-control` (no restart). Computer use on the MacBook works through it                               |
| Mini's Orca | Headless `orca serve` LaunchAgent `dev.onorca.serve`, attributed to `com.stablyai.orca` for Accessibility and Screen Recording. `/Applications/Orca.app` is owned by the mini's user so the serve can update itself and stay on the MacBook's version                    |
| Watchdog    | LaunchAgent `com.leonsilicon.orca-watchdog`, every 60 s: [`@assets/orca-watchdog.sh`](@assets/orca-watchdog.sh) restarts `dev.onorca.serve` after 5 checks in a row where `orca status` is not ready. Log and state in `~/.local/share/orca-bridge/logs/orca-watchdog.*` |
| Hermes      | Captain Claude's `orca` MCP server, `Authorization: Bearer <ORCA_BRIDGE_TOKEN>`, `timeout: 180`                                                                                                                                                                          |

## Deploy

```sh
apps/orca-bridge/_deploy-orca-bridge.sh          # copy the workspace to the mini and install
apps/orca-bridge/_deploy-orca-bridge.sh --start  # also write the env file from Infisical and restart the LaunchAgents (bridge and watchdog)
```

`--start` needs Infisical access (see [DEVELOPMENT.md](../../DEVELOPMENT.md#secrets-and-config)); it stops before touching the env file or the service if any value is missing. Check: `curl -s https://orca.leonsilicon.ai/healthz`, and `ssh mini 'tail ~/.local/share/orca-bridge/logs/*.log'`.

## Operating it

- **Rotate the token.** New `openssl rand -hex 32` as `ORCA_BRIDGE_TOKEN` in Infisical, deploy with `--start`, then update Captain Claude's `orca` header and restart its gateway when no agents are active (a changed URL or header is not reconnected otherwise).
- **Re-pair the MacBook.** On the MacBook: `orca pair --address <its tailnet IP> --grant-desktop-control --json`; on the mini: `orca environment rm MacBook`, then `orca environment add --name MacBook --pairing-code '<pairingUrl>'`. Keep the code out of logs and chats.
- **Outages.** launchd's KeepAlive and the serve's own `--supervise` restart an Orca that exits, but not one that stays up without serving. From 2026-11-14 to 2026-11-18 the 1.4.249 serve did that after a WindowServer restart: alive, no socket, nothing on port 6768, so the bridge listed its tools while every call failed with `runtime_unavailable`, and Hermes ended up with a session showing no Orca tools. Upgrading to 1.4.263 made it start again; the watchdog now catches the same state within about 5 minutes. Watch with `ssh mini 'tail ~/.local/share/orca-bridge/logs/orca-watchdog.log'`. Test the script with `WATCHDOG_DRY_RUN=1` plus `ORCA_BIN` (a fake `orca`), `WATCHDOG_STATE` and `WATCHDOG_LOG`.
- **Updating Orca by hand.** macOS App Management blocks writes into an installed app bundle from an SSH session, even as root, so replace the whole bundle: stop `dev.onorca.serve`, `sudo rm -rf /Applications/Orca.app`, `sudo ditto` a verified copy owned by the mini's user (from the release zip, `codesign --verify --deep --strict`) to `/Applications/Orca.app`, then bootstrap the serve again.
- **Turn it off.** `launchctl bootout gui/$(id -u)/com.leonsilicon.orca-bridge` (and `com.leonsilicon.orca-watchdog`) on the mini, or remove the `orca` route from the gateway.
