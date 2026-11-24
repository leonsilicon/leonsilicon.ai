# @-/ai.leonsilicon.services.orcahermes-device

OrcaHermes Device connects Hermes Cloud to existing desktop Orca installations. Hermes runs the Linux Orca CLI on its own machine and pairs it with Leon's Macs, the same way the mini is paired with the MacBook, so it drives either Mac's Orca directly instead of going through the [Orca bridge](../orca-bridge/README.md) on the mini. The deployment is in [`apps/orcahermes-device`](../../../../../apps/orcahermes-device/README.md). Status: prototype, live on Hermes Cloud since 2026-11-19.

```text
Hermes ─stdio MCP─▶ orca-device.mjs mcp ─▶ orca CLI (Linux, its own pairing store)
                                              │ ws://127.0.0.3:6768 (Mac mini) / 127.0.0.2:6768 (MacBook)
                         link daemon ─────────┘ loopback forwarder ─▶ tailscale nc ─▶ <Mac's tailnet IP>:6768
                         (userspace tailscaled, no root)
```

## Pieces

- **Tools.** The bridge's own: `orca_cli`, `orca_guide`, `orca_projects` and orca-mcp's worker tools, built with the bridge's `createServer` (`host: "hermes-cloud"` changes only the wording). The default target is `defaultEnvironment` (the mini); `--environment "MacBook"` picks the other Mac. The wrapper `bin/orca` adds the default only when a command names no environment.
- **Transport.** Orca's runtime only accepts LAN and tailnet clients, and Hermes Cloud has no tailnet route of its own. The link daemon runs `tailscaled --tun=userspace-networking` (no root, state on the persistent volume). For each Mac it listens on a loopback address and carries each connection to the Mac with `tailscale nc`. Each Mac's pairing offer advertises that loopback address.
- **One owner.** The link holds an open `BEGIN EXCLUSIVE` SQLite transaction on `state/link.lock` (the kernel drops it on any exit). The MCP server starts the link detached if it isn't running and checks on it every minute, so gateway and machine restarts bring it back. A `tailscaled` left behind by a killed link is stopped before a new one starts.
- **Joining.** While the node is logged out, the link reads a one-time auth key from Hermes's `.env` (`ORCA_DEVICE_TS_AUTHKEY`) and runs `tailscale up` with it. After that the login lives in `tailscale/state` and the key can be deleted.
- **Config.** `device.json` (on Hermes only, since it holds tailnet addresses and Mac paths): `hostname`, `defaultEnvironment`, `mcpRoots` (orca-mcp's allowed roots, as paths on the default Mac), `mcpClient`, and `peers` (`name`, tailnet `address`, `port`, `loopback`). Loopback addresses must be `127.x.y.z`.
- **Screenshots.** Computer-use screenshots that the CLI saves locally are attached as images, resized with Pillow on Linux (`sips` on macOS).

## API

`runCli`, `runMcpServer`, `startLink`, `ensureLink`, `readLinkStatus`, `startForwarder`, `tryLock`, `devicePaths`, `readDeviceConfig`, `readEnvValue`, `AUTHKEY_ENV`, `EXIT_ALREADY_RUNNING`.

## Test

```sh
node --test packages/ai/leonsilicon/services/orcahermes-device/__tests__/*.test.ts
```

Covers the forwarder (with a stand-in for `tailscale nc`), the link's single owner, status file and clean stop, a fresh home, and the config checks.
