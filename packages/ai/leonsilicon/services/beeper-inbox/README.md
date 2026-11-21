# @-/ai.leonsilicon.services.beeper-inbox

Hermes's direct Beeper Cloud inbox: it lists, reads, downloads from and sends in Leon's existing Beeper conversations over Matrix, as its own end-to-end-encrypted device of Leon's Beeper account. It needs neither Beeper Desktop nor any of Leon's computers. The app that runs it on Hermes Cloud, and how to deploy it, is in [`apps/beeper-inbox`](../../../../../apps/beeper-inbox/README.md).

Leon's Beeper messages are still copied to the Slack #feed- channels by [Beeper Watch](../beeper-watch/README.md), and Slack is still where Hermes searches. This adds actions on the original conversations: open the chat behind a feed post, read the original message, fetch its attachment, reply.

## Tools

| Tool                  | Does                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_conversations`  | Searches the joined rooms by name, participant, network or exact room ID, newest activity first. Each has its room ID, name, short network name (`whatsapp`, `instagram`…) and bridge identity.        |
| `get_conversation`    | One room: name, network, bridge, member count, encryption.                                                                                                                                             |
| `list_messages`       | One bounded page of history (up to 100 raw events), decrypted, oldest first, with `next_cursor`. Events that couldn't be decrypted are listed under `undecryptable` and the page is `complete: false`. |
| `get_message`         | One original event, with full text, reply link and attachments, or an explicit "could not decrypt" with the error.                                                                                     |
| `download_attachment` | Decrypts an attachment and saves the real bytes under `downloads/<day>/`, returning the path, filename, media type, byte count and SHA-256. Up to 64 MB.                                               |
| `send_message`        | Text, optionally a reply (`reply_to` = an event ID in the same room). Returns the event ID, a readback and the bridge's delivery status when it reports one.                                           |
| `send_file`           | A file from the machine, with filename and media type; media as media unless `send_as: "file"`. Up to 50 MB. Downloads the upload back and compares SHA-256.                                           |
| `send_reaction`       | An emoji reaction.                                                                                                                                                                                     |
| `inbox_status`        | Device, encryption and key backup state, sync health, directory size, recent sends, limits and what isn't supported.                                                                                   |

Room IDs are opaque and used exactly as the homeserver gives them (`:beeper.local` is normal for bridged rooms; room version 12 IDs have no server part). The chat ID in a #feed- post is the room ID. A Slack ts is not an event ID; the tools refuse one with a pointer to `list_messages`.

Not implemented: starting conversations with new contacts, edits and deletions, Beeper's merged chats (each bridged room is its own conversation), network-specific actions, and thread replies in bridged rooms (Beeper answers `/relations` with 403 there).

## How it works

```text
Hermes ─stdio MCP─▶ beeper-inbox.mjs mcp ─unix socket─▶ beeper-inbox.mjs daemon ─Pickle (WASM)─▶ matrix.beeper.com
(any number of processes)  (no state)                      (one owner per device)
```

- **Library.** [Pickle](https://github.com/beeper/pickle) (`@beeper/pickle`, mautrix-go and goolm compiled to WebAssembly) with its SQLite state adapter, built from the pinned revision in [`apps/beeper-inbox/@assets/pickle.json`](../../../../../apps/beeper-inbox/@assets/pickle.json). It isn't on npm, so it is vendored, and loaded at run time by `pickle.ts`; `types.ts` describes the slice used.
- **One writer.** Pickle requires exactly one writer per device store. The daemon is the only process that opens `pickle.db` and `inbox.db`, and only while it holds `state/owner.lock`: an open SQLite `BEGIN EXCLUSIVE` transaction, which the kernel releases when the process dies by any cause, so there is no stale lock to clear. A second daemon exits with code 75. Both databases are also opened with `locking_mode=EXCLUSIVE`.
- **Thin adapters.** Hermes may start the MCP server in several processes (the gateway, cron runs, dashboard chats). Each is a stateless client of the daemon's socket. The first call, or the adapter's start, launches the daemon detached (`setsid`), outside the process group Hermes kills when an MCP server exits; every adapter checks on it once a minute.
- **Extensions** (`extension.ts`). The daemon can serve a second set of tools from the same process, each with its own MCP server (`beeper-inbox.mjs mcp <name>`) and its own directory under the home. An extension reaches Beeper only through the tools above and what the daemon hands it: the journal, room details (name, network, connection, whether Leon muted the room) and sender names. The [Grok relay](../grok-relay/README.md) and [Beeper Watch](../beeper-watch/README.md) are extensions: each needs a single owner for its state, which this daemon already is. `status` shows each one's own health under `extensions`.
- **Background sync** keeps to-device room keys, device lists and the directory current. It never creates Hermes tasks or contacts anyone.
- **Pickle's `fetch`** goes through `matrix-fetch.ts`, which adds what Pickle doesn't expose:
  - Send retries in Pickle get fresh transaction IDs, so a lost response could post twice. The wrapper pins each send to one transaction ID derived from its idempotency key, and the homeserver deduplicates by it.
  - A message that isn't `m.room.encrypted` in an encrypted room is refused locally.
  - Pickle silently drops events it can't decrypt from history. The raw `/messages` and `/event` responses are captured so the tools account for every event.
  - Pickle's state store re-serializes its whole cache on every state event, and Beeper ignores `types: []` and `limit: 0` in sync filters (measured: 23,049 state events across 1,415 rooms). The sync filter gets `not_types: ["*"]` for room state, which Beeper honours (54 events). Pickle fetches encryption state and members itself before a send.
  - `/relations` 403s in a room are cached for ten minutes, timeouts are set on every request, and sync health is recorded.
  - Pickle asks the homeserver for the sender's devices again for every event it decrypts when the sender has none, as every bridged contact does: 5 `POST /keys/query` for 5 messages, about a second of waiting (measured 2026-11-21). An answer is reused for a minute. A send clears the reused answers and never sees one, because encrypting needs the recipients' current devices.
- **Sends** are serialized and recorded in a ledger (`inbox.db`). The same idempotency key, or without one the same content to the same room within 15 minutes, never sends twice: overlapping calls wait and get the first result. When delivery is uncertain (a timeout after the request went out), the result says so. Calling again within 30 minutes reuses the transaction ID, which is safe; after that the tool asks for a new key.
- **Muted chats.** Beeper keeps a mute as a Matrix push rule for the room with no "notify" action. The daemon reads Leon's push rules at start and every ten minutes, takes changes from sync as they happen, and reports `is_muted` on each conversation.
- **Directory.** `list_conversations` searches a metadata table (no message text) built from one filtered, stateless `/sync`. A bridged room also carries the network's own ID where the bridge gives one (`bridge.network_id`, a Slack team ID for instance). It is rebuilt when older than 6 hours, or with `refresh: true`, and updated from live sync.
- **Files** travel as paths on the shared volume, never through tool output. `send_file` refuses hidden files (`.env`, `.ssh`), anything under the service's state, and names that look like credentials.

## What a read costs

Measured on Hermes Cloud, 2026-11-21, in a Grok bot's chat: a page of 10 messages took 5.9 s, of which 0.7 s was the homeserver and 0.6 s SQLite. During it Pickle wrote its saved state 196 times, 119 MB in all: it rewrites the whole blob (about 600 KB for this account) roughly 20 times per decrypted event, and building that blob is where the rest of the time goes. So a page costs about half a second per message, every time, and that can't be changed from outside Pickle. 20 messages took 11.9 s and 50 took 19.6 s.

- A page slower than 3 s is logged as `slow read`, with its requests by kind and its store writes by key (`store-trace.ts`).
- Reads run one at a time. Pages of 30 and 100 events asked for at once kept the Matrix core busy for over 20 s, and the daemon's health check restarted it (twice on 2026-11-21, back in 5 s on the same device).
- So anything that needs new messages often, such as the Grok relay waiting for a reply or a feed of every chat, takes them from the journal below, not by reading history again and again.

## The journal

Sync already hands the daemon every new message, decrypted. Since 2026-11-21 it writes each one down once, in `inbox.db` (`journal.ts`), so that following a chat costs one indexed query instead of a page of history.

- **Positions.** A message gets a position when it first arrives (`seq`) and a new one whenever it changes (`rev`): an edit, a deletion, a decryption that succeeded late. Positions only grow, so "what is new or changed after N?" never misses or repeats anything, and a caller can wait on it.
- **Edits** update the message they replace, with the text from `m.new_content`. **Deletions** keep the message's place and drop its text.
- **Late keys.** An event that arrives before its keys is held back, and shown once it decrypts: when sync delivers it again, or on one of five retries (after 30 s, then a minute apart).
- **Coverage.** The journal vouches for everything since `covered_since`. That moves to now when the daemon was away for 30 minutes or more, because sync may then have skipped events.
- **Old messages** can land in it too: reading history, or a bridge filling in the past, makes sync deliver them. They keep their own time, so "the latest messages" only counts what was sent since `covered_since`.
- **It holds message text**, unlike the rest of `inbox.db`, for 7 days at most (100,000 messages at most), in the owner-only state directory beside the keys that decrypt everything anyway.
- **Who reads it.** Extensions, through `ExtensionContext.journal`. It isn't one of Hermes's tools: what is put in front of Hermes stays the feed's decision. `beeper-inbox.mjs journal` shows an operator the latest entries without their text.

Measured on Hermes Cloud, 2026-11-21: a message was in the journal 0.2 to 0.9 s after it was sent, and the Grok relay's read of a chat took 0.15 s from the journal against 1.1 s for four messages of history.

## State and secrets

Everything is under `$BEEPER_INBOX_HOME` (default `$HERMES_HOME/beeper-inbox`, `/opt/data/beeper-inbox` on Hermes Cloud):

| Path                    | What                                                                                                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state/` (0700)         | `account.json` (homeserver, user, device ID; no secrets), `pickle.db` (Olm/Megolm, sync cursor, room cache), `inbox.db` (ledger, directory), `owner.lock`, `daemon.sock`, `daemon.json`, `verified.json` |
| `downloads/<day>/`      | Decrypted attachments                                                                                                                                                                                    |
| `logs/daemon.log`       | JSON lines, rotated at 5 MB. IDs and counts only, never message text                                                                                                                                     |
| `app/`, `node_modules/` | The release; `*.prev` is the one before                                                                                                                                                                  |

Secrets Leon may set are in Hermes's own `.env` (dashboard Keys page, `PUT /api/env`), which Hermes redacts from tool output: `BEEPER_INBOX_ACCESS_TOKEN` and `BEEPER_INBOX_RECOVERY_KEY` (Leon's Beeper recovery key). The daemon reads them from the file itself. It reloads within a minute when they (or `account.json`) change, after checking the new values: a malformed recovery key, or a token for another device, is reported in `status.secrets.problems` and the running session is kept. With the recovery key, the first start cross-signs the device from secret storage and loads the key backup; `verified.json` records it. Bridges only share message keys with cross-signed devices, so without the recovery key nothing bridged decrypts.

The key that encrypts Pickle's store (`pickleKey`) is not in `.env`. It is generated per device into `state/pickle-key-<device>` (0600) on the device's first start, and must never change. Until 2026-11-19 it was `BEEPER_INBOX_PICKLE_KEY` in `.env`, where a recovery key pasted into that entry made the first device's store unreadable. An old store without a key file is migrated from that entry once; one whose key is gone stops with an explanation rather than retrying.

## Test

```sh
node --test packages/ai/leonsilicon/services/beeper-inbox/__tests__/*.test.ts
```

Offline, with a fake homeserver and a fake Pickle that retries sends with fresh transaction IDs as the real one does, and that delivers sync events on demand. Covers the journal (positions, edits, late keys, deletions, waiting, coverage), the lock across processes (including SIGKILL), the ledger, overlapping and ambiguous sends, decryption accounting, the plaintext guard, the sync filter, the directory, the upload guard, and a daemon restart that keeps the device. Live checks are in the app README.

Public API (`+server.ts`): `runCli`, `startDaemon`, `runMcpServer`, `Inbox`, `TOOLS`, `runTool`, `OwnerLock`, `SendLedger`, `RoomDirectory`, `MatrixFetch`, the `DaemonExtension` types and helpers.
