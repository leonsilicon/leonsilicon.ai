# @-apps/muse-gadget

Runs Hermes Cloud's (Captain Claude's) [Muse Gadget](https://github.com/facebookincubator/muse-gadget-sdk/tree/fbfe3b0f717f7f468d0a94aa370ea0ca1a94ebfe/linux) and the private [muse-mcp](https://github.com/niclydon/muse-mcp/tree/43299b2f4270e8994eff3978a72d1345abf93e4d) server that [hermes22muse](../hermes-plugin-hermes22muse/README.md) talks to. Muse lists the Gadget under **Settings → Devices → Gadgets** as **Hermes Cloud**. It has no host commands.

## Pieces

| Piece    | Where                                                                                                                                                                                         |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code     | `/opt/data/muse-gadget/sdk` and `muse-mcp` (pinned checkouts) with their `venv`, from [`install-cloud.sh`](@assets/install-cloud.sh)                                                          |
| Launcher | [`serve-cloud.py`](@assets/serve-cloud.py) runs the Gadget link and muse-mcp on `127.0.0.1:7899` in one process; [`ensure-cloud.sh`](@assets/ensure-cloud.sh) starts it once (`runtime.lock`) |
| Startup  | The Hermes hook `/opt/data/hooks/muse-gadget` runs `ensure-cloud.sh` on `gateway:startup`; [`activate-cloud.sh`](@assets/activate-cloud.sh) installed it                                      |
| State    | `/opt/data/muse-gadget/state`: `identity.json` (node `homelink-42967a`), `pairing.json` (device tokens), `sdk_token`, `origin-secret` (muse-mcp's `ORIGIN_SHARED_SECRET`). Never share them   |
| Logs     | `runtime.log` (Gadget and server), `mcp-audit.log` (every muse-mcp call)                                                                                                                      |

`serve-cloud.py` replaces muse-mcp's provenance stamp with nothing, so Muse receives hermes22muse's messages exactly as written, as the user's own. It also scopes `muse_chat_status`'s `approvals.snapshot` count to the requested chat (marking `pending_approvals_scoped: true`), since Muse emits an account-wide snapshot whose pending approvals from other side chats, the main chat or background tasks would otherwise block unrelated chats.

## Deploy a change

Upload the changed file to `/opt/data/muse-gadget/` with the dashboard's `POST /api/files/upload-stream`, then restart the process from a `no_agent` cron script: `pkill -f /opt/data/muse-gadget/serve-cloud.py`, then `bash /opt/data/muse-gadget/ensure-cloud.sh`. Check `curl -fsS http://127.0.0.1:7899/health` and `registered with the Muse` at the end of `runtime.log`.

## Pair again

Hermes Cloud has no Bluetooth, so a Mac pairs on its behalf with the same `identity.json` and SDK token, using [finik/pi-muse-bridge](https://github.com/finik/pi-muse-bridge)'s pairing code and [rjohnt/muse-gadget-macos](https://github.com/rjohnt/muse-gadget-macos)'s app-bundled CoreBluetooth helper in name-only mode. Upload `identity.json`, `sdk_token` and the new `pairing.json` to `state/incoming/`, then run `activate-cloud.sh` from a cron script.

On Leon's MacBook (2026-11-24), two things kept the iPhone from pairing. VRCode Desktop (`dev.improve.vrcode.mac.local`, `--bluetooth`) held the Mac's only advertising slot, so Muse found no device: stop that launch agent while pairing. And `rapportd` kept a Continuity link to the iPhone, so the iPhone's connection was dropped as a duplicate and Muse stayed on "Connecting…": restart `rapportd` (`pkill -x rapportd`; launchd starts it again) just before tapping Connect.
