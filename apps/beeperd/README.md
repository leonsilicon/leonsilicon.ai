# beeperd

Hermes's Beeper inbox: one small Go daemon on Hermes Cloud that signs in to Leon's Beeper account as its own encrypted device, copies new messages into Slack the moment they arrive, and sends for Hermes. It replaced the Node daemon built on Pickle on 2026-11-26.

It is built on [mautrix-go](https://github.com/mautrix/go), the Matrix library Beeper's own bridges run, with its SQL stores: a change writes one row. Measured on Hermes Cloud: about 20 MB resident and no measurable CPU while idle. The Node daemon held about 480 MB with its two adapters and used 8.5% of a core on average, because Pickle rewrote its whole 3.9 MB key store about 20 times for every message from Leon's own account.

## What it does

| Part                                     | What                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inbox (`internal/inbox`)                 | Sync, decryption, the journal of what arrived, the room directory, the send ledger, and the nine MCP tools (`list_conversations`, `get_conversation`, `list_messages`, `get_message`, `download_attachment`, `send_message`, `send_file`, `send_reaction`, `inbox_status`) |
| Slack feeds (`internal/feeds`)           | Seven one-way copies into `#feed-<network>`: WhatsApp, Instagram, Discord, LinkedIn, Reddit, WeChat and X. Each message is screened by a model before it is posted                                                                                                         |
| Grok relay (`internal/grokrelay`)        | `slack22grokbot`: Hermes's handoffs to Grok Bot, mirrored both ways to a Slack thread, with the queue, the budget and the Grok box upkeep. Tools `grok_bots`, `grok_bot_send`, `grok_bot_read`, `grok_task_complete`                                                       |
| Linear publisher (`internal/linearmeta`) | Linear issue records and project colors and icons, written into the Matrix rooms of their Slack channels as account data                                                                                                                                                   |

## How it works

```text
Hermes ─stdio MCP─▶ beeperd mcp [slack22grokbot] ─unix socket─▶ beeperd daemon ─▶ matrix.beeper.com
                                                                  ├─ feeds ─▶ Slack
                                                                  ├─ Grok relay ─▶ Beeper, Slack
                                                                  └─ Linear publisher ─▶ Matrix account data
```

- **One process owns the device.** The daemon holds `state/owner.lock` (a `flock`, which the kernel drops when the process dies) and is the only process that opens the stores. A second daemon exits with code 75.
- **Thin adapters.** `beeperd mcp` is a stateless stdio MCP server. A tool call goes straight to the daemon and waits for it (up to 175 s). When nothing listens on the socket, the adapter starts the daemon in its own session and sends the call again. It checks on the daemon once a minute, so sync survives gateway and machine restarts. While `daemon.json` names a live daemon, no other is started.
- **Sync is a long poll.** A message reaches the journal a fraction of a second after Beeper has it, and the feeds and the relay wake on the journal. A response is processed before its position is saved, so a crash repeats a response and never loses one.
- **Keys.** A key that arrives after its message is used at once. A key that never arrives is fetched from the account's key backup. An event that still can't be read waits in the journal and is tried again once a minute.
- **The room directory stays current from sync.** New rooms and name or bridge changes arrive there. A full rebuild (a `/sync` of every room, read one room at a time) runs on first start, once a day, and when Hermes asks with `refresh: true`.
- **Sends** are encrypted here and sent as ciphertext, so nothing readable can go into an encrypted room by mistake. Each send has one transaction ID from the ledger: the same idempotency key, or the same content to the same room within 15 minutes, never sends twice.
- **The tool contract** is `internal/inbox/tools.json` and `internal/grokrelay/tools.json`. The descriptions are what Hermes reads and carry Leon's rules, so they change only when he changes a rule.

## Files on Hermes Cloud

Everything is under `/opt/data/beeperd` (`$BEEPERD_HOME`, else `$HERMES_HOME/beeperd`).

| Path                        | What                                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bin/beeperd`               | The binary (`beeperd.prev` is the one before)                                                                                                                                                           |
| `state/` (0700)             | `session.json` (the device and its access token), `pickle-key`, `crypto.db` (keys, sync position, room state), `inbox.db` (journal, send ledger, directory), `owner.lock`, `daemon.sock`, `daemon.json` |
| `logs/daemon.log`           | JSON lines: IDs, counts and reasons, never message text                                                                                                                                                 |
| `downloads/`                | Attachments Hermes downloaded                                                                                                                                                                           |
| `<network>2slack/`          | A feed's `env` (settings) and `state.json` (cursor and retries)                                                                                                                                         |
| `slack22grokbot/`           | `slack22grokbot.env`, `slack22grokbot.json`, `state/`                                                                                                                                                   |
| `linear-issue-metadata/env` | The publisher's token                                                                                                                                                                                   |

A service without its settings file stays idle and says so in the status.

Each service has its own notes: [feeds](internal/feeds/README.md), [the Grok relay](internal/grokrelay/README.md), [handoffs to Silicon Dot](internal/handoff/README.md). The Linear publisher needs `vpx _env-file linear-issue-metadata` installed as `linear-issue-metadata/env`; slack22linear fills the endpoint it reads every 10 seconds, and its status shows the last successful pass, the rooms written and the channels with no room.

## Operating it

```sh
B=/opt/data/beeperd/bin/beeperd
$B status                     # device, encryption, sync, directory, services
$B restart                    # same device and stores
$B tool list_conversations '{"query":"note to self"}'
$B extension slack22grokbot grok_bots
$B journal                    # what sync delivered lately, without text
tail /opt/data/beeperd/logs/daemon.log
```

`BEEPERD_SERVICES=none` runs only the inbox, for a second daemon beside a live one; a comma-separated list runs just those services.

## Build and deploy

```sh
vpr -w test:beeperd           # go test, with the goolm tag
vpr -w build:beeperd          # dist/beeperd.tgz: one static linux/amd64 binary, prints its sha256
```

The build needs Go and a C compiler that links against musl (SQLite is C): `x86_64-linux-musl-gcc` on a Mac (`brew install FiloSottile/musl-cross/musl-cross`), `musl-gcc` on Linux.

1. Upload `dist/beeperd.tgz` to `/opt/data/beeperd/releases/` with the dashboard's `POST /api/files/upload-stream`, and compare the sha256.
2. From a `no_agent` cron script or Hermes's terminal, while Hermes is idle:

   ```sh
   cd /opt/data/beeperd/releases && mkdir new && tar -xzf beeperd.tgz -C new
   sh new/beeperd/install.sh --restart
   ```

3. The MCP adapters keep running the old binary until the gateway restarts. Restart it when the adapter code changed.

Hermes's MCP registration (`/opt/data/config.yaml`): `beeper-inbox` is `command: /opt/data/beeperd/bin/beeperd`, `args: [mcp]`; `grok` is the same command with `args: [mcp, slack22grokbot]`.

## Sign-in (once per device)

```sh
echo "<the Beeper account's email>" | $B login-start   # Beeper emails a code
$B login-finish <code>                                  # creates the device and state/session.json
$B stop; echo "<recovery key>" | $B verify              # cross-signs it; the key is not stored
$B start
```

Without the cross-signature Beeper's bridges don't share message keys with the device. `verify` also keeps the key that reads the account's key backup (in `crypto.db`, encrypted with `pickle-key`), which is how the device reads messages from before it existed. A device's store must only ever run in one place.

## Rollback

`bin/beeperd.prev` is the previous binary: copy it over `bin/beeperd` and run `$B restart`. To remove the device, sign out "Hermes Cloud inbox (beeperd)" under Beeper → Settings → Devices and delete `/opt/data/beeperd`.
