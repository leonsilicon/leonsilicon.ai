import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ensureDaemon } from "#client";
import { Coalesced } from "#coalesce";
import { RoomDirectory, normalizeNetwork, roomsFromSync } from "#directory";
import { accountPage, refusedUploadReason, safeFilename } from "#format";
import { keysQueryKey, MatrixFetch, requestKind, slimSyncFilter } from "#fetch";
import { GAP_MS, MessageJournal, RETENTION_MS } from "#journal";
import { SendLedger, idempotencyKey, payloadHash, txnIdFor } from "#ledger";
import { OwnerLock } from "#lock";
import { ensureDirectories, inboxPaths } from "#paths";
import {
  loadPickleKey,
  looksLikeRecoveryKey,
  parseEnvFile,
  pickleKeyFile,
  readEnvSecrets,
  storeHasCrypto,
} from "#secrets";

const quiet = () => undefined;

test("owner lock: one holder across processes, released when the holder is killed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bi-lock-"));
  const path = join(dir, "owner.lock");
  const holder = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { DatabaseSync } from "node:sqlite";
       const db = new DatabaseSync(${JSON.stringify(path)}, { timeout: 0 });
       db.exec("PRAGMA journal_mode=DELETE"); db.exec("CREATE TABLE IF NOT EXISTS owner (pid INTEGER NOT NULL, since TEXT NOT NULL)");
       db.exec("PRAGMA locking_mode=EXCLUSIVE"); db.exec("BEGIN EXCLUSIVE");
       db.prepare("INSERT INTO owner (pid, since) VALUES (?, ?)").run(process.pid, "x");
       console.log("held"); setInterval(() => {}, 1000);`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await new Promise<void>((resolve) => holder.stdout.once("data", () => resolve()));
  assert.equal(OwnerLock.tryAcquire(path), null, "a second process must not get the lock");
  holder.kill("SIGKILL");
  await new Promise((resolve) => holder.once("exit", resolve));
  const lock = OwnerLock.tryAcquire(path);
  assert.ok(lock, "the lock is free once the holder is dead, with no stale state");
  assert.equal(OwnerLock.tryAcquire(path), null, "and exclusive within one process too");
  lock.release();
  const again = OwnerLock.tryAcquire(path);
  assert.ok(again);
  again.release();
});

test("ledger: keys, transaction IDs and state transitions", () => {
  const ledger = new SendLedger(new DatabaseSync(":memory:"));
  const hash = payloadHash(["text", "hello", ""]);
  assert.notEqual(hash, payloadHash(["text", "hell", "o"]), "parts are length-prefixed");
  const derived = idempotencyKey(undefined, "!r:x", "text", hash);
  assert.equal(derived.derived, true);
  const explicit = idempotencyKey("order-42", "!r:x", "text", hash);
  assert.equal(explicit.key, "k:!r:x:order-42");
  assert.throws(() => idempotencyKey("has space", "!r:x", "text", hash));
  assert.equal(txnIdFor(explicit.key), txnIdFor(explicit.key));
  assert.notEqual(txnIdFor(explicit.key), txnIdFor(derived.key));
  assert.match(txnIdFor(explicit.key), /^bi[A-Za-z0-9_-]{26}$/);
  const begun = ledger.begin(
    {
      key: explicit.key,
      derived: false,
      roomId: "!r:x",
      kind: "text",
      payloadHash: hash,
      txnId: txnIdFor(explicit.key),
    },
    1000,
  );
  assert.equal(begun.status, "pending");
  assert.equal(ledger.finish(explicit.key, "unknown", null, "timeout", 2000).status, "unknown");
  const retried = ledger.begin(
    {
      key: explicit.key,
      derived: false,
      roomId: "!r:x",
      kind: "text",
      payloadHash: hash,
      txnId: "ignored",
    },
    3000,
  );
  assert.equal(retried.attempts, 2);
  assert.equal(retried.txnId, txnIdFor(explicit.key), "a key keeps its first transaction ID");
  const sent = ledger.finish(explicit.key, "sent", "$e", null, 4000);
  assert.equal(sent.eventId, "$e");
  ledger.retire(explicit.key, 5000);
  assert.equal(ledger.get(explicit.key), null);
});

test("page accounting lists undecryptable events and explains every omission", () => {
  const raw = [
    { event_id: "$ok", type: "m.room.encrypted", content: { ciphertext: "x" } },
    {
      event_id: "$bad",
      type: "m.room.encrypted",
      sender: "@a:x",
      origin_server_ts: 1,
      content: { ciphertext: "y" },
    },
    {
      event_id: "$thread",
      type: "m.room.encrypted",
      content: { ciphertext: "z", "m.relates_to": { rel_type: "m.thread", event_id: "$root" } },
    },
    {
      event_id: "$edit",
      type: "m.room.encrypted",
      content: { ciphertext: "z", "m.relates_to": { rel_type: "m.replace", event_id: "$ok" } },
    },
    {
      event_id: "$react",
      type: "m.reaction",
      content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$ok", key: "👍" } },
    },
    { event_id: "$member", type: "m.room.member", state_key: "@a:x", content: {} },
    { event_id: "$gone", type: "m.room.message", content: {}, unsigned: { redacted_because: {} } },
    { event_id: "$status", type: "m.room.encrypted", content: { ciphertext: "q" } },
  ];
  const page = accountPage(raw, new Set(["$ok"]), new Map([["$bad", "no session"]]));
  assert.deepEqual(
    page.undecryptable.map((event) => [event.event_id, event.error]),
    [["$bad", "no session"]],
  );
  assert.equal(page.thread_replies.length, 1);
  assert.equal(page.edits_merged, 1);
  assert.equal(page.reactions, 1);
  assert.equal(page.state_events, 1);
  assert.equal(page.redacted, 1);
  assert.deepEqual(
    page.other.map((event) => [event.event_id, event.reason]),
    [["$status", "not_a_message"]],
  );
});

test("directory: bridge identity, names, direct chats and search", () => {
  const body = {
    account_data: {
      events: [{ type: "m.direct", content: { "@x:beeper.local": ["!dm:beeper.local"] } }],
    },
    rooms: {
      join: {
        "!dm:beeper.local": {
          state: {
            events: [
              {
                type: "m.room.encryption",
                state_key: "",
                content: { algorithm: "m.megolm.v1.aes-sha2" },
              },
              {
                type: "m.bridge",
                state_key: "fi.mau.whatsapp://whatsapp/123",
                content: {
                  bridgebot: "@whatsappbot:beeper.local",
                  protocol: { id: "whatsapp", displayname: "WhatsApp" },
                  channel: { id: "123", displayname: "Sam", receiver: "acct1" },
                  "com.beeper.room_type": "dm",
                },
              },
              {
                type: "m.room.member",
                state_key: "@whatsapp_123:beeper.local",
                content: { displayname: "Sam Lee", membership: "join" },
              },
            ],
          },
          summary: { "m.heroes": ["@whatsapp_123:beeper.local"], "m.joined_member_count": 2 },
          timeline: {
            events: [
              {
                type: "m.room.encrypted",
                sender: "@whatsapp_123:beeper.local",
                origin_server_ts: 5000,
                content: {},
              },
            ],
          },
        },
        "!group:beeper.local": {
          state: {
            events: [
              { type: "m.room.name", state_key: "", content: { name: "Study group" } },
              { type: "m.bridge", state_key: "k", content: { protocol: { id: "instagramgo" } } },
            ],
          },
          summary: { "m.joined_member_count": 6 },
          timeline: {
            events: [
              {
                type: "m.room.message",
                sender: "@me:beeper.com",
                origin_server_ts: 9000,
                content: {},
              },
            ],
          },
        },
        "!note:beeper.com": {
          state: {
            events: [{ type: "m.room.name", state_key: "", content: { name: "Note to self" } }],
          },
        },
      },
    },
  };
  const rooms = roomsFromSync(body, "@me:beeper.com", 1);
  const dm = rooms.find((room) => room.roomId === "!dm:beeper.local");
  assert.equal(dm?.name, "Sam Lee");
  assert.equal(dm?.network, "whatsapp");
  assert.equal(dm?.isDirect, true);
  assert.equal(dm?.encrypted, true);
  assert.equal(dm?.bridge?.receiver, "acct1");
  assert.equal(rooms.find((room) => room.roomId === "!group:beeper.local")?.network, "instagram");
  assert.equal(rooms.find((room) => room.roomId === "!note:beeper.com")?.network, "beeper");
  const directory = new RoomDirectory(new DatabaseSync(":memory:"));
  directory.replaceAll(rooms, 1);
  assert.deepEqual(
    directory.search({ limit: 10, offset: 0 }).rooms.map((room) => room.roomId),
    ["!group:beeper.local", "!dm:beeper.local", "!note:beeper.com"],
  );
  assert.equal(directory.search({ query: "sam", limit: 10, offset: 0 }).total, 1);
  assert.equal(directory.search({ network: "WhatsApp", limit: 10, offset: 0 }).total, 1);
  assert.equal(directory.search({ query: "!note:beeper.com", limit: 10, offset: 0 }).total, 1);
  directory.touch("!note:beeper.com", 10_000, "@me:beeper.com");
  assert.equal(directory.search({ limit: 1, offset: 0 }).rooms[0]?.roomId, "!note:beeper.com");
  assert.equal(normalizeNetwork("discordgo"), "discord");
  assert.equal(normalizeNetwork("twitter"), "x");
});

test("fetch wrapper: pins the transaction ID, refuses plaintext, captures pages, caches relations 403s", async () => {
  const seen: string[] = [];
  const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    seen.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname.includes("/relations/")) return new Response("{}", { status: 403 });
    if (url.pathname.endsWith("/messages"))
      return new Response(JSON.stringify({ chunk: [{ event_id: "$1" }] }), { status: 200 });
    return new Response(JSON.stringify({ event_id: "$sent" }), { status: 200 });
  }) as typeof fetch;
  const wrapper = new MatrixFetch(base, quiet);
  const room = "!r:beeper.local";
  const encoded = encodeURIComponent(room);
  const guard = wrapper.beginSend({ roomId: room, txnId: "biPINNED", expectEncrypted: true });
  await wrapper.fetch(
    `https://hs/_matrix/client/v3/rooms/${encoded}/send/m.room.encrypted/mautrix-go_1`,
    { method: "PUT" },
  );
  await wrapper.fetch(
    `https://hs/_matrix/client/v3/rooms/${encoded}/send/m.room.encrypted/mautrix-go_2`,
    { method: "PUT" },
  );
  const blocked = await wrapper.fetch(
    `https://hs/_matrix/client/v3/rooms/${encoded}/send/m.room.message/mautrix-go_3`,
    { method: "PUT" },
  );
  wrapper.endSend();
  assert.equal(blocked.status, 400);
  assert.deepEqual(
    seen.filter((line) => line.startsWith("PUT")),
    [
      `PUT /_matrix/client/v3/rooms/${encoded}/send/m.room.encrypted/biPINNED`,
      `PUT /_matrix/client/v3/rooms/${encoded}/send/m.room.encrypted/biPINNED`,
    ],
  );
  assert.equal(guard.attempts.length, 3);
  assert.equal(guard.attempts[2]?.blocked, true);
  await wrapper.fetch(`https://hs/_matrix/client/v3/rooms/${encoded}/send/m.room.encrypted/free`, {
    method: "PUT",
  });
  assert.ok(seen.at(-1)?.endsWith("/free"), "outside a send nothing is rewritten");

  const capture = wrapper.beginCapture("messages", room);
  await wrapper.fetch(`https://hs/_matrix/client/v3/rooms/${encoded}/messages?dir=b`);
  await wrapper.endCapture();
  assert.deepEqual(capture.bodies, [{ chunk: [{ event_id: "$1" }] }]);

  const before = seen.length;
  assert.equal(
    (await wrapper.fetch(`https://hs/_matrix/client/v1/rooms/${encoded}/relations/%24a/m.replace`))
      .status,
    403,
  );
  assert.equal(
    (await wrapper.fetch(`https://hs/_matrix/client/v1/rooms/${encoded}/relations/%24b/m.replace`))
      .status,
    403,
  );
  assert.equal(seen.length, before + 1, "the second relations call is answered locally");
});

test("upload guard and filenames", () => {
  const state = "/opt/data/beeper-inbox/state";
  assert.ok(refusedUploadReason("/opt/data/.env", state));
  assert.ok(refusedUploadReason("/opt/data/.ssh/id_ed25519", state));
  assert.ok(refusedUploadReason("/opt/data/beeper-inbox/state/pickle.db", state));
  assert.ok(refusedUploadReason("/opt/data/google_token.json", state));
  assert.ok(refusedUploadReason("/opt/data/config.yaml", state));
  assert.ok(refusedUploadReason("/opt/data/auth.json", state));
  assert.equal(refusedUploadReason("/opt/data/artifacts/report.pdf", state), null);
  assert.equal(refusedUploadReason("/tmp/photo.jpg", state), null);
  assert.equal(safeFilename("../../etc/passwd", "x"), "passwd");
  assert.equal(safeFilename("..hidden", "x"), "hidden");
  assert.equal(safeFilename("", "fallback"), "fallback");
});

test(".env parsing reads only the wanted keys", () => {
  const parsed = parseEnvFile(
    'A=1\nBEEPER_INBOX_ACCESS_TOKEN="tok"\n# c\nexport BEEPER_INBOX_PICKLE_KEY=pk\nOTHER=secret',
    ["BEEPER_INBOX_ACCESS_TOKEN", "BEEPER_INBOX_PICKLE_KEY"],
  );
  assert.deepEqual(parsed, { BEEPER_INBOX_ACCESS_TOKEN: "tok", BEEPER_INBOX_PICKLE_KEY: "pk" });
});

test("sync filter: Pickle's filter loses room state, keeps the rest", async () => {
  const slim = slimSyncFilter({ room: { timeline: { limit: 50 }, state: { limit: 0 } } });
  assert.deepEqual(slim, {
    room: {
      timeline: { limit: 50, lazy_load_members: true },
      state: { limit: 0, not_types: ["*"], lazy_load_members: true },
      account_data: { not_types: ["*"] },
      ephemeral: { not_types: ["*"] },
    },
    presence: { not_types: ["*"] },
  });
  let seen = "";
  const base = (async (input: RequestInfo | URL) => {
    seen =
      new URL(input instanceof Request ? input.url : input.toString()).searchParams.get("filter") ??
      "";
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const wrapper = new MatrixFetch(base, quiet);
  await wrapper.fetch(
    `https://hs/_matrix/client/v3/sync?filter=${encodeURIComponent('{"room":{"timeline":{"limit":0}}}')}&timeout=0`,
  );
  assert.deepEqual(
    (JSON.parse(seen) as { room: { state: { not_types: string[] } } }).room.state.not_types,
    ["*"],
  );
  await wrapper.fetch("https://hs/_matrix/client/v3/sync?filter=abc123");
  assert.equal(seen, "abc123", "a server-side filter ID is left alone");
});

test("pickle key: created once per device, migrated from .env only for an existing store, never guessed", () => {
  const dir = mkdtempSync(join(tmpdir(), "bi-key-"));
  assert.ok(looksLikeRecoveryKey("EsTc 1234 abcd EFGH 5678 ijkm NPQR 9abc defg hijk mnop qrst"));
  assert.ok(!looksLikeRecoveryKey("x2wQ0vJ7cS_8-random-base64url-pickle-key-0000"));
  const file = pickleKeyFile(dir, "DEVICE1");
  const created = loadPickleKey(file, false, undefined);
  assert.equal(created.source, "created");
  assert.equal(loadPickleKey(file, true, "ignored").pickleKey, created.pickleKey);
  const legacyFile = pickleKeyFile(dir, "DEVICE2");
  assert.equal(loadPickleKey(legacyFile, true, "old-base64url-key").source, "migrated");
  assert.throws(
    () =>
      loadPickleKey(
        pickleKeyFile(dir, "DEVICE3"),
        true,
        "EsTc 1234 abcd EFGH 5678 ijkm NPQR 9abc defg hijk mnop qrst",
      ),
    /can never be opened again/,
  );
  const db = new DatabaseSync(":memory:");
  assert.equal(storeHasCrypto(db, "DEVICE1"), false);
  db.exec("CREATE TABLE matrix_store (key TEXT PRIMARY KEY, value BLOB NOT NULL)");
  db.prepare("INSERT INTO matrix_store VALUES (?, ?)").run(
    `pickle/v1/h/u/${Buffer.from("DEVICE1").toString("base64url")}/crypto.json`,
    new Uint8Array([1]),
  );
  assert.equal(storeHasCrypto(db, "DEVICE1"), true);
  assert.equal(storeHasCrypto(db, "DEVICE2"), false);
  const envFile = join(dir, ".env");
  writeFileSync(
    envFile,
    "BEEPER_INBOX_ACCESS_TOKEN=EsTc 1234 abcd EFGH 5678 ijkm NPQR 9abc defg hijk mnop qrst\n",
  );
  assert.match(readEnvSecrets(envFile, {}).fatal.join(), /holds what looks like a recovery key/);
});

test("matrix fetch: a /keys/query answer is reused for a while, but never while sending", async () => {
  let calls = 0;
  const base = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ device_keys: {}, n: calls }), { status: 200 });
  }) as typeof fetch;
  const wrapper = new MatrixFetch(base, quiet, { keysQueryTtlMs: 40 });
  const query = (users: Record<string, string[]>) =>
    wrapper
      .fetch("https://hs/_matrix/client/v3/keys/query", {
        method: "POST",
        body: JSON.stringify({ device_keys: users, timeout: 10000 }),
      })
      .then((response) => response.json() as Promise<{ n: number }>);
  const trace = wrapper.beginTrace();
  assert.equal((await query({ "@ghost:beeper.local": [] })).n, 1);
  assert.equal(
    (await query({ "@ghost:beeper.local": [] })).n,
    1,
    "the same question is answered once",
  );
  assert.equal((await query({ "@other:beeper.local": [] })).n, 2, "another user is asked about");
  wrapper.endTrace(trace);
  assert.deepEqual(
    trace.requests.map((request) => request.kind),
    ["POST /keys/query", "POST /keys/query (reused)", "POST /keys/query"],
  );

  const guard = wrapper.beginSend({ roomId: "!r:beeper.local", txnId: "t", expectEncrypted: true });
  assert.equal((await query({ "@ghost:beeper.local": [] })).n, 3, "a send asks afresh");
  assert.equal((await query({ "@ghost:beeper.local": [] })).n, 4, "and keeps asking");
  wrapper.endSend();
  void guard;
  assert.equal(
    (await query({ "@ghost:beeper.local": [] })).n,
    5,
    "nothing from before the send is left",
  );
  assert.equal((await query({ "@ghost:beeper.local": [] })).n, 5);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal((await query({ "@ghost:beeper.local": [] })).n, 6, "it expires");

  assert.equal(
    keysQueryKey(JSON.stringify({ device_keys: { "@b:x": ["D2", "D1"], "@a:x": [] } })),
    keysQueryKey(
      new TextEncoder().encode(
        JSON.stringify({ device_keys: { "@a:x": [], "@b:x": ["D1", "D2"] } }),
      ),
    ),
  );
  assert.equal(keysQueryKey("not json"), null);
  assert.equal(
    requestKind(
      "GET",
      "/_matrix/client/v3/rooms/!abc%3Abeeper.local/relations/%24ev/m.replace/m.room.message",
    ),
    "GET /rooms/:id/relations/:id/m.replace/m.room.message",
  );
});

test("journal: positions only grow, edits keep their place, waits wake on the right room", async () => {
  const T0 = 1795000000000;
  const journal = new MessageJournal(new DatabaseSync(":memory:"), T0);
  const say = (eventId: string, text: string, extra: Record<string, unknown> = {}) =>
    journal.record(
      {
        roomId: "!a:x",
        eventId,
        sender: "@bot:x",
        isMe: false,
        type: "m.text",
        text,
        ts: T0,
        ...extra,
      },
      T0,
    );
  assert.equal(journal.head(), 0);
  assert.equal(journal.coveredSince(), T0);
  assert.deepEqual([say("$1", "one")?.seq, say("$2", "two", { ts: T0 + 5 })?.seq], [1, 2]);
  assert.equal(say("$1", "one again"), null, "a repeat is ignored");
  const edit = say("$e", "* uno", { replaces: "$1" });
  assert.deepEqual(
    [edit?.eventId, edit?.text, edit?.seq, edit?.rev, edit?.edited],
    ["$1", "* uno", 1, 3, true],
  );
  assert.deepEqual(
    journal.changes({ after: 2 }).entries.map((entry) => entry.eventId),
    ["$1"],
    "only what changed after the position",
  );
  assert.deepEqual(
    journal.since("!a:x", T0).map((entry) => entry.eventId),
    ["$1", "$2"],
    "by time sent, not by change",
  );
  // A message from before the journal began can be delivered late; it isn't one of "the latest".
  say("$ancient", "from last week", { ts: T0 - 7 * 24 * 3600_000 });
  assert.deepEqual(
    journal.latest("!a:x", 10).map((entry) => entry.eventId),
    ["$1", "$2"],
  );
  // An edit of a message from before the journal still shows up, under the message's ID.
  assert.equal(say("$e2", "rewritten", { replaces: "$old" })?.eventId, "$old");

  // Waiting: another room's message doesn't wake it; this room's does; a timeout returns nothing.
  const head = journal.head();
  const waiting = journal.changesWhenAny({ after: head, roomId: "!a:x", waitMs: 2000 });
  journal.record(
    {
      roomId: "!b:x",
      eventId: "$other",
      sender: "@c:x",
      isMe: false,
      type: "m.text",
      text: "x",
      ts: T0,
    },
    T0,
  );
  setTimeout(() => say("$3", "three"), 15);
  assert.deepEqual(
    (await waiting).entries.map((entry) => entry.eventId),
    ["$3"],
  );
  const quiet = await journal.changesWhenAny({ after: journal.head(), roomId: "!a:x", waitMs: 20 });
  assert.deepEqual([quiet.entries.length, quiet.cursor], [0, journal.head()]);

  // Late keys: held back, retried with a growing delay, five times at most.
  journal.pending("!a:x", "$late", "@bot:x", T0);
  assert.equal(journal.stats().pending, 1);
  assert.equal(journal.pendingDue(T0 + 10_000).length, 0, "not yet");
  assert.deepEqual(journal.pendingDue(T0 + 31_000), [{ roomId: "!a:x", eventId: "$late" }]);
  assert.equal(journal.pendingDue(T0 + 31_000).length, 0, "the next try is later");
  for (let i = 0; i < 6; i++) journal.pendingDue(T0 + 3_600_000);
  assert.equal(journal.pendingDue(T0 + 7_200_000).length, 0, "it gives up");
  assert.equal(say("$late", "arrived")?.text, "arrived");
  assert.equal(journal.stats().pending, 0);

  // Coverage restarts after an absence; old messages are dropped.
  journal.alive(T0 + GAP_MS - 1);
  assert.equal(journal.coveredSince(), T0);
  journal.alive(T0 + 3 * GAP_MS);
  assert.equal(journal.coveredSince(), T0 + 3 * GAP_MS);
  journal.prune(T0 + RETENTION_MS + 1);
  assert.equal(journal.stats().entries, 0);
  assert.ok(journal.head() >= 8, "positions are never reused");
});

test("coalesced refresh: one run at a time, shared; recent results reused only when allowed", async () => {
  let now = 1_000;
  let runs = 0;
  const pending: Array<(value: number) => void> = [];
  const gate = new Coalesced<number>(
    () =>
      new Promise<number>((resolve) => {
        runs += 1;
        pending.push(resolve);
      }),
    () => now,
  );
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  const first = gate.get();
  const joined = gate.get();
  assert.equal(runs, 1, "asked in the same moment: one run");
  now += 5;
  const later = [gate.get(), gate.get()];
  const recent = gate.get(60_000);
  assert.equal(runs, 1, "a request that needs a newer run waits for the current one");
  pending.shift()!(1);
  assert.equal(await first, 1);
  assert.equal(await joined, 1);
  assert.equal(await recent, 1, "a recent-enough request joins the running one");
  await settle();
  assert.equal(runs, 2, "the requests made during the first run share one next run");
  pending.shift()!(2);
  assert.deepEqual(await Promise.all(later), [2, 2]);

  now += 59_000;
  assert.equal(await gate.get(60_000), 2, "reused while under a minute old");
  assert.equal(runs, 2);
  now += 2_000;
  const stale = gate.get(60_000);
  assert.equal(runs, 3, "an older result is refreshed");
  pending.shift()!(3);
  assert.equal(await stale, 3);

  const failing = new Coalesced<number>(async () => {
    throw new Error("matrix down");
  });
  await assert.rejects(failing.get(), /matrix down/);
  await assert.rejects(failing.get(60_000), /matrix down/, "a failure is never reused");
  gate.reset();
  const afterReset = gate.get(60_000);
  assert.equal(runs, 4, "reset forgets the last result");
  pending.shift()!(4);
  await afterReset;
});

test("ensureDaemon: waits for a live owner instead of starting another; starts one when none runs", async () => {
  const home = mkdtempSync(join(tmpdir(), "bi-client-"));
  const paths = inboxPaths({ HOME: home, HERMES_HOME: home, BEEPER_INBOX_HOME: home });
  ensureDirectories(paths);
  const marker = join(home, "spawned");
  const launcher = {
    command: [
      process.execPath,
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`,
    ],
    env: { PATH: process.env.PATH },
  };

  // An owner that is alive but not answering, as on 2026-11-26 when Matrix was slow.
  const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "daemon"], {
    stdio: "ignore",
  });
  try {
    writeFileSync(paths.daemonInfo, JSON.stringify({ pid: owner.pid }));
    await assert.rejects(
      ensureDaemon(paths, launcher, 1_000),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "daemon_busy");
        assert.match(error.message, new RegExp(`pid ${owner.pid}`));
        return true;
      },
    );
    assert.equal(existsSync(marker), false, "no second daemon while the owner lives");
  } finally {
    owner.kill("SIGKILL");
    await new Promise((resolve) => owner.once("exit", resolve));
  }

  await assert.rejects(ensureDaemon(paths, launcher, 1_000), { code: "daemon_unreachable" });
  for (let i = 0; i < 50 && !existsSync(marker); i++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(existsSync(marker), true, "with the owner gone, a daemon is started");
});
