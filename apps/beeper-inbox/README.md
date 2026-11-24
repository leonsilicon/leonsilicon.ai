# @-apps/beeper-inbox

Runs the [Beeper inbox](../../packages/ai/leonsilicon/services/beeper-inbox/README.md) on Hermes Cloud (Captain Claude), as the MCP server `beeper-inbox`. Hermes reads, downloads from and sends in Leon's existing Beeper conversations directly over Matrix, as its own device of his Beeper account, with no Beeper Desktop and no Mac involved. Set up 2026-11-18/19.

`_beeper-inbox.ts` is the one entrypoint (`mcp`, `daemon`, `status`, `restart`…; `--help` lists them). `_build-beeper-inbox.ts` builds the release.

## Pieces

| Piece      | Where                                                                                                                                                                                                                                                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release    | `/opt/data/beeper-inbox/app/beeper-inbox.mjs` (bundled) and `node_modules/@beeper/*` (vendored Pickle), on the persistent volume. `*.prev` is the previous release; uploads in `releases/`                                                                                                                                   |
| MCP config | `mcp_servers.beeper-inbox` in `/opt/data/config.yaml`: `command: node`, `args: [/opt/data/beeper-inbox/app/beeper-inbox.mjs, mcp]`. Hermes's default timeouts (300 s calls, 60 s connect)                                                                                                                                    |
| Device     | A device of Leon's Beeper account named "Hermes Cloud inbox (Pickle)" (the second one, since 2026-11-19 14:12 UTC; see Status); its IDs are in `state/account.json`                                                                                                                                                          |
| Secrets    | Hermes's `/opt/data/.env`: `BEEPER_INBOX_ACCESS_TOKEN` and `BEEPER_INBOX_RECOVERY_KEY` (Leon's Beeper recovery key, from his password manager). The store's own key is generated per device into `state/pickle-key-<device>` (0600) and never needs touching. Not in Infisical: they belong to this one device and its store |
| Logs       | `/opt/data/beeper-inbox/logs/daemon.log`                                                                                                                                                                                                                                                                                     |
| Runtime    | Hermes's own Node (`/opt/hermes/tools/node-*`, 26.12.1 on 2026-11-18; 22.5+ needed for `node:sqlite`). No root, no service manager                                                                                                                                                                                           |

**Lifecycle.** Hermes starts `beeper-inbox.mjs mcp` when the gateway (or a cron run, or a dashboard chat) connects its MCP servers. The adapter starts the daemon if none answers, detached into its own session so Hermes reaping the adapter's process group leaves it running, and checks on it every minute. A gateway restart leaves the daemon running; a machine restart (Hermes Cloud scales to zero) brings it back when the gateway reconnects. Stopping (`SIGTERM`, `stop`, `restart`) closes the store cleanly and never logs the device out.

## Build

Needs git, Go (it fetches the pinned `go1.25.0` toolchain), pnpm and bun.

```sh
node apps/beeper-inbox/_build-beeper-inbox.ts   # dist/beeper-inbox.tgz, prints its sha256
```

It fetches Pickle at the revision in [`@assets/pickle.json`](@assets/pickle.json) into `~/.cache/leonsilicon-ai/beeper-inbox/`, builds it with upstream's own commands, checks `pickle.wasm` against the pinned hash, bundles the app with bun, and writes `SHA256SUMS` and `BUILD.json`.

- **The missing Go module.** Pickle's go.mod pins `github.com/beeper/ai-bridge` at a commit that's no longer on any branch, so `go` and proxy.golang.org answer "unknown revision". GitHub still serves the commit by its full SHA. The build zips it into a local `GOPROXY` with [`@assets/modzip`](@assets/modzip/main.go) (Go's own module-zip code), and Go checks the zip against the `h1:` hash in Pickle's go.sum, so different code can't get in.
- **Reproducible.** `-trimpath` (through `GOFLAGS`; upstream's scripts are unchanged) keeps the build directory out of `pickle.wasm`: two builds in different directories were byte-identical.

## Deploy

1. Upload `dist/beeper-inbox.tgz` to `/opt/data/beeper-inbox/releases/` with the dashboard's `POST /api/files/upload-stream` (multipart `file` and `path`), and compare the sha256.
2. Run as the `hermes` user on Captain Claude, from a `no_agent` cron script (`/opt/data/scripts/<name>.sh`, then `POST /api/cron/jobs/<id>/trigger` once; a 409 can still mean it started, so never re-trigger) or Hermes's terminal:

   ```sh
   cd /opt/data/beeper-inbox/releases && mkdir new && tar -xzf beeper-inbox-<date>.tgz -C new
   sh new/beeper-inbox/install.sh   # checks SHA256SUMS, swaps app/ and node_modules/, keeps *.prev, restarts the daemon
   ```

3. First install only: register the server with `POST /api/mcp/servers {"name":"beeper-inbox","command":"node","args":["/opt/data/beeper-inbox/app/beeper-inbox.mjs","mcp"]}`. Hermes picks it up on its next turn.

## Linear metadata

Install the dedicated read-only publisher credential with `vpx _env-file linear-issue-metadata` as `/opt/data/beeper-inbox/linear-issue-metadata/env` (mode 600). Restart the daemon to load it. slack22linear fills the endpoint from issue webhooks and its daily tick. Run the authorized slack22linear `/admin/tick` to seed existing rooms during rollout.

The publisher checks for changes every 10 seconds and refreshes its Slack-to-Matrix room map every minute. It publishes issue records and project colors and icons as room account data, and closed Slack project channels as account-wide `ai.leonsilicon.linear.project_visibility`. It uses the inbox's existing Matrix session and reads back each changed record. `status.extensions["linear-issue-metadata"]` shows the last successful pass, verified issue and project rooms, unmapped channels, and whether project visibility was published.

## Beeper Feed

[Beeper Feed](../../packages/ai/leonsilicon/services/beeper-feed/README.md) runs in the inbox daemon. Render its settings with `vpx _env-file beeper-feed` and install them as `/opt/data/beeper-inbox/beeper-feed/env` (mode 600), then install the release or restart the daemon. Check `status.extensions["beeper-feed"]` for the latest pass, pending work and Slack deliveries. Removing the settings file and restarting pauses copying.

## Sign-in (once per device)

1. Create the device with Pickle's Beeper login: `startBeeperLogin`, then the email request, then `sendBeeperLoginCode`, then `loginWithMatrixToken({ type: "org.matrix.login.jwt", initialDeviceDisplayName: "Hermes Cloud inbox (Pickle)" })`. Pickle's own `sendBeeperLoginEmail` throws on Beeper's empty 204 answer at the pinned revision, so send that request yourself. The code goes to Leon's email; Captain Claude can read it with its read-only Gmail (`google_api.py gmail search 'from:beeper.com newer_than:1h'`). Beeper also accepts `m.login.password`.
2. Put `BEEPER_INBOX_ACCESS_TOKEN` and `BEEPER_INBOX_RECOVERY_KEY` in Hermes's `.env` (`PUT /api/env`, or Keys → Custom keys). The daemon creates the store key itself on the device's first start.
3. `node app/beeper-inbox.mjs install-account account.json` (homeserver, userId, deviceId only; it refuses secrets), then `node app/beeper-inbox.mjs reload`.

With the recovery key, the first start fetches the cross-signing keys from secret storage, signs the device, and loads the key backup (`verified.json` records it). Without it the device isn't cross-signed, so Beeper's bridges don't share message keys with it, and it can't read history from before it existed either. The daemon checks `account.json` and the `BEEPER_INBOX_*` values once a minute and reloads when they change, so adding the key on the dashboard (Keys → Custom keys) is enough; `status` then shows `crypto.cross_signed_at`. A change is checked before the running session is dropped: a malformed recovery key or a token for another device is reported under `status.secrets.problems` and ignored.

## Status (2026-11-19)

**Working.** The current device was cross-signed from the recovery key at 14:12 UTC, with key backup version 3 loaded.

**Device replaced.** The first device (04:27 UTC) kept its store key in `.env` as `BEEPER_INBOX_PICKLE_KEY`. When the recovery key was added on the Keys page it went into that entry, and the store couldn't be opened again ("decrypt pickle … bad mac"). The original key existed nowhere else. Nothing of value was lost: the device had never been cross-signed and held no decrypted history. What was done:

- The first device was signed out with its own token, and its store archived in `state/retired-<device>-*`.
- The recovery key was moved to `BEEPER_INBOX_RECOVERY_KEY` inside the dashboard page, and the old entries were deleted.
- A new device was signed in. Since then, the store key is a generated file beside the store, and the status names a misplaced recovery key.

## Verified live (2026-11-19, Captain Claude)

- **From Hermes's own sessions** (cron agent runs in the gateway): the tools appear as `mcp__beeper_inbox__*` in Hermes's deferred-tool catalog. `inbox_status` and `list_conversations` answered: 1,415 rooms, Note to self.
- **Sends**, in Leon's own Note to self only (encrypted, no other members), all with readback, sent encrypted:
  - Text.
  - A reply (`reply_to` read back).
  - A file: encrypted, 40 bytes, SHA-256 `cd7db378ba0484422aadf9d944586ab404e088cd943f8b36d90854625453becd`, matched on round trip.
  - `download_attachment` decrypted it to `downloads/2026-11-19/`, and Hermes opened it with its own file tool.
  - Repeating send 1 returned `deduplicated` with the same event.
- **Overlap:** two simultaneous identical sends, with a key and without one, each made one event; the second call reported `deduplicated`. A second `daemon` exited 75 at once. `/proc/locks` showed only the owner holding `owner.lock`, `pickle.db` and `inbox.db`.
- **Restarts** (on the first device, before the replacement), all on the same device:
  - `restart`: clean stop, then start.
  - Two gateway restarts: the daemon kept running, and the new gateway's adapter attached to it.
  - SIGKILL: the adapter heartbeat restarted the daemon in about 26 s.
  - Adapter killed and daemon stopped (the boot path): the next tool call started both.
  - A machine restart wasn't triggered: the portal has no restart control, and stopping Leon's machine wasn't worth the risk. The boot path above is the same sequence.
- **Bridged reads** (after cross-signing, on the current device): one Instagram group and two WhatsApp chats returned 21, 22 and 28 decrypted messages with none undecryptable (`complete: true`). Before the recovery key, every bridged message was undecryptable, even ones sent after the device existed: bridges don't share keys with a device that isn't cross-signed.
- **Bridged attachment:** Hermes downloaded an encrypted WhatsApp photo: `image.jpg`, `image/jpeg`, 69,932 bytes, SHA-256 `570d508e7243c7f777fb4078bb7454fa02403ff97dfb838a485918469b575a3a`, starting with JPEG's `ff d8 ff`. Its own tools opened it as an 858 × 1280 JPEG.
- **Bridged sends** (in a WhatsApp chat with a family member that Leon chose; one run, fixed idempotency keys), both read back as sent encrypted by this device, with the WhatsApp bridge reporting `SUCCESS`:
  - A reply to their last message: `reply_to` read back, text matched.
  - A file, `test-from-leons-assistant.txt`: 60 bytes, SHA-256 `ada5cbdb…`, matched on round trip.
- **Load:** about 150-200 MB RSS and about 2% CPU when idle. The first sync takes about 1 s now; it was over 20 minutes before the `not_types` fix.

## Operating it

Since 2026-11-21 this is Hermes's only way into Beeper. Its older `beeper` MCP server, Beeper Desktop's own on the Mac mini, was removed that day (the entry is saved in `/opt/data/backups/mcp-beeper-desktop-mini-20261121.json`), and the four places Hermes's skills named its tools now name this inbox's (`get_conversation`, `list_conversations`, `list_messages`, `send_message`; backups beside each file end in `.bak-20261121-beeper-inbox`). In the three days before, Hermes had still called the old tools 87 times, and since 2026-11-19 every call had failed.

```sh
B="node /opt/data/beeper-inbox/app/beeper-inbox.mjs"
$B status                    # JSON health: device, crypto, sync, directory, recent sends
$B restart                   # same device and store
$B tool list_conversations '{"query":"note to self"}'
$B journal                   # what sync delivered lately, without text; '{"after":N,"room_id":"!…"}' narrows it
$B extension slack22grokbot grok_bots   # one of the Grok relay's tools, as Hermes would call it
tail /opt/data/beeper-inbox/logs/daemon.log
```

## Rollback

Everything below leaves Leon's Beeper account, his other devices and the rest of Hermes alone.

- **Turn the tools off:** `DELETE /api/mcp/servers/beeper-inbox` (or `PUT /api/mcp/servers/beeper-inbox/enabled`), then `$B stop`. Nothing restarts the daemon without the MCP server.
- **Previous release:** in `/opt/data/beeper-inbox`, swap `app` with `app.prev` and `node_modules` with `node_modules.prev`, then `$B restart`.
- **Remove the device:** sign it out under Beeper → Settings → Devices ("Hermes Cloud inbox (Pickle)"), delete the `BEEPER_INBOX_*` keys from `.env`, and delete `/opt/data/beeper-inbox`. Signing out from another device is the safest way to end the session; the store is useless without it.
