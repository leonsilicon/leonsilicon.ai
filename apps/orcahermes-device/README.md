# OrcaHermes Device

Runs the [OrcaHermes Device service](../../packages/ai/leonsilicon/services/orcahermes-device/README.md) on Captain Claude so Hermes can reach the paired Orca installations on Leon's Macs over Tailscale. It has been live since 2026-11-19. [Public reference](https://orcahermes-device.leonsilicon.ai/)

## On Hermes Cloud (`/opt/data/orca-device`)

Existing installations use `/opt/data/orca-device` and `app/orca-device.mjs` for the persistent data and Hermes MCP configuration. Releases under the new name still install there.

| Path                                 | What                                                                                                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bundle/`                            | Orca's Linux runtime bundle (`orcad-template` common files + the `linux-x64-glibc` target) from Orca.app 1.4.263, every file checked against `orcad-template.json`, plus `ripgrep/linux-x64/rg` and the `.version` stamp |
| `runtimes/node-<sha>/bin/node`       | Node 24.22.1, Orca's pinned runtime, from nodejs.org, checked against the archive and executable hashes Orca pins                                                                                                        |
| `bin/orca`                           | The CLI wrapper: `ORCA_USER_DATA=data/`, default environment from `default-environment`                                                                                                                                  |
| `data/` (0700)                       | The Orca profile: pairing store and device keys                                                                                                                                                                          |
| `tailscale/`                         | Tailscale 1.104.7 (`bin/`, `state/`, socket), from pkgs.tailscale.com with its published sha256                                                                                                                          |
| `app/orca-device.mjs`                | This app, bundled (`mcp`, `link`, `start`, `status`, `stop`)                                                                                                                                                             |
| `device.json`, `default-environment` | Peers (tailnet addresses), roots and the default Mac; not in this repo                                                                                                                                                   |
| `state/`, `logs/`                    | The link's lock and status; `link.log`, `tailscaled.log`                                                                                                                                                                 |

How the bundle is put together: Orca's `orcad.js` refuses to start without `.version`, which must equal the digest its own preflight computes (`orcad-server.js --orcad-startup-preflight <uuid>` prints `artifactVersion`). Hermes only needs the CLI, but the stamp keeps the bundle startable as a server too.

## Status (2026-11-19)

Live. Hermes's `orca` MCP server is `command: node`, `args: [/opt/data/orca-device/app/orca-device.mjs, mcp]` (stdio); it was the mini bridge's URL with a bearer header. The mini bridge was stopped on 2026-11-21 ([how to bring it back](../orca-bridge/README.md)).

- **Tailnet.** Node `hermes-cloud` (`tag:hermes-cloud`), joined with a one-time pre-approved tagged key that was then removed from Hermes's `.env`. Policy changes:
  - `tagOwners`: `"tag:hermes-cloud": ["autogroup:admin"]`.
  - The catch-all grant's `src` went from `["*"]` to `["autogroup:member"]`, because `*` covers tagged nodes too.
  - `tag:hermes-cloud` may reach only `tcp:6768` on the mini and the MacBook.
  - `tests` assert that: accept on both Macs' 6768, deny on 22 and on other devices, and Leon still reaches 22 and 6768.
- **Pairings.** `Mac mini` (the default) and `MacBook`, both with desktop control.
- **Verified.**
  - `orca status` reached both Macs (1.4.263).
  - On the MacBook, a terminal was created, sent a command, read and closed.
  - Computer use listed the MacBook's apps.
  - A Hermes agent session used the `orca` tools on both Macs.
  - The installer's restart brought the link and pairings back.
  - Funnel routes were unchanged.

## Updating

Rebuild after Orca updates on the Macs, so Hermes's CLI keeps their version:

1. Run `node apps/orcahermes-device/_build-orcahermes-device.ts` on a Mac with the new Orca.
2. Upload `dist/orcahermes-device.tgz` to Hermes, unpack it under `releases/`, and run its `install.sh`. It keeps the previous `bundle` and `app` as `*.prev`.
3. A running gateway keeps the old MCP process until its next restart.

## Rollback

1. Start the bridge on the mini again ([orca-bridge](../orca-bridge/README.md)), then restore the `orca` server from `/opt/data/backups/mcp-orca-bridge-20261119.json` and restart the gateway when no agents are active.
2. Run `node /opt/data/orca-device/app/orca-device.mjs stop`.
3. Remove the `hermes-cloud` node in the tailnet admin console, and revert the policy:
   - Set the catch-all grant's `src` back to `["*"]`.
   - Drop the `tag:hermes-cloud` grant, its tag owner and its tests.
4. Remove "hermes-cloud" from each Mac's paired devices in Orca's settings.
