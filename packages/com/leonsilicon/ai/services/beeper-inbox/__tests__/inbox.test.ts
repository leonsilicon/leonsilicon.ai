import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { callIpc } from "#ipc";
import { startDaemon } from "#daemon";
import { inboxPaths } from "#paths";
import type { ExtensionJournal } from "#extension";
import type { PickleRuntime } from "#pickle";
import type {
  MatrixClientEvent,
  MatrixMessageEvent,
  MatrixStore,
  PickleClient,
  PickleClientOptions,
} from "#types";

const ME = "@leon:beeper.com";
const ROOM = "!chat:beeper.local";
const ENC = encodeURIComponent(ROOM);

/** A homeserver that dedupes sends by transaction ID, as the spec requires, and can lose responses. */
class FakeHomeserver {
  /** Delivers one event as sync would, once the client has subscribed. */
  emit: (event: MatrixClientEvent) => void = () => {
    throw new Error("nothing has subscribed yet");
  };
  events = new Map<string, Record<string, unknown>>();
  timeline: string[] = [];
  byTxn = new Map<string, string>();
  sendPuts: string[] = [];
  loseNextSendResponses = 0;
  media = new Map<string, Uint8Array>();

  constructor() {
    this.add({
      type: "m.room.encrypted",
      sender: "@whatsapp_1:beeper.local",
      content: { fake_plaintext: { msgtype: "m.text", body: "hi Leon" } },
    });
    this.add({
      type: "m.room.encrypted",
      sender: "@whatsapp_1:beeper.local",
      content: { ciphertext: "lost" },
    });
    this.media.set("mxc://beeper.com/photo", new TextEncoder().encode("JPEGBYTES"));
    this.add({
      type: "m.room.encrypted",
      sender: "@whatsapp_1:beeper.local",
      content: {
        fake_plaintext: {
          msgtype: "m.image",
          body: "photo.jpg",
          info: { mimetype: "image/jpeg", size: 9 },
          file: { url: "mxc://beeper.com/photo", v: "v2", iv: "", hashes: { sha256: "" }, key: {} },
        },
      },
    });
  }

  add(event: Record<string, unknown>): string {
    const id = `$${randomUUID()}`;
    this.events.set(id, {
      event_id: id,
      room_id: ROOM,
      origin_server_ts: 1_000 + this.timeline.length,
      ...event,
    });
    this.timeline.push(id);
    return id;
  }

  fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? "GET";
    const path = decodeURIComponent(url.pathname);
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (path.endsWith(`/state/m.room.member/${ME}`)) return ok({ membership: "join" });
    if (path.endsWith("/state/m.room.encryption/"))
      return ok({ algorithm: "m.megolm.v1.aes-sha2" });
    if (path.includes("/profile/")) return ok({ displayname: "Sam" });
    if (path.endsWith("/sync")) {
      return ok({
        rooms: {
          join: {
            [ROOM]: {
              state: {
                events: [
                  { type: "m.room.name", state_key: "", content: { name: "Sam" } },
                  { type: "m.room.encryption", state_key: "", content: {} },
                  { type: "m.bridge", state_key: "b", content: { protocol: { id: "whatsapp" } } },
                ],
              },
            },
          },
        },
      });
    }
    const send = /\/rooms\/[^/]+\/send\/([^/]+)\/([^/]+)$/.exec(path);
    if (method === "PUT" && send) {
      const [, type, txn] = send;
      this.sendPuts.push(`${type}/${txn}`);
      let eventId = this.byTxn.get(txn as string);
      if (!eventId) {
        const body = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as Record<
          string,
          unknown
        >;
        eventId = this.add({
          type,
          sender: ME,
          content: type === "m.room.encrypted" ? { fake_plaintext: body } : body,
        });
        this.byTxn.set(txn as string, eventId);
      }
      if (this.loseNextSendResponses > 0) {
        this.loseNextSendResponses -= 1;
        throw new TypeError("fetch failed (response lost)");
      }
      return ok({ event_id: eventId });
    }
    const event = /\/rooms\/[^/]+\/event\/([^/]+)$/.exec(path);
    if (event) {
      const found = this.events.get(event[1] as string);
      return found
        ? ok(found)
        : new Response(JSON.stringify({ errcode: "M_NOT_FOUND" }), { status: 404 });
    }
    if (path.endsWith("/messages"))
      return ok({
        chunk: [...this.timeline].reverse().map((id) => this.events.get(id)),
        end: "t_end",
      });
    return new Response(JSON.stringify({ errcode: "M_UNRECOGNIZED" }), { status: 404 });
  }) as typeof fetch;
}

/** Enough of Pickle: it goes through the `fetch` option, retries a lost send with a fresh transaction ID, and drops what it can't decrypt. */
function fakePickle(
  server: FakeHomeserver,
  calls: { logout: number; created: number },
): PickleRuntime {
  return {
    createStore: (db: DatabaseSync) =>
      ({
        get: async () => null,
        set: async () => undefined,
        delete: async () => undefined,
        list: async () => [],
        db,
      }) as unknown as MatrixStore,
    createMatrixClient: (options: PickleClientOptions): PickleClient => {
      calls.created += 1;
      const f = options.fetch as typeof fetch;
      const hs = options.account.homeserver;
      let handler: ((event: MatrixClientEvent) => void) | null = null;
      const toMessage = (raw: Record<string, unknown>): MatrixMessageEvent | null => {
        const content = raw.content as Record<string, unknown>;
        const plain = (
          raw.type === "m.room.encrypted"
            ? content.fake_plaintext
            : raw.type === "m.room.message"
              ? content
              : null
        ) as Record<string, unknown> | null;
        if (!plain) {
          handler?.({
            kind: "decryptionError",
            error: "no session for this message",
            event: { eventId: raw.event_id, roomId: ROOM },
          });
          return null;
        }
        const file = plain.file as Record<string, unknown> | undefined;
        const info = plain.info as Record<string, unknown> | undefined;
        const relates = plain["m.relates_to"] as
          | { "m.in_reply_to"?: { event_id: string } }
          | undefined;
        return {
          attachments: file
            ? [
                {
                  kind: "image",
                  filename: String(plain.body),
                  contentType: String(info?.mimetype),
                  size: Number(info?.size),
                  encryptedFile: file as never,
                },
              ]
            : [],
          content: plain,
          edited: false,
          encrypted: raw.type === "m.room.encrypted",
          eventId: String(raw.event_id),
          kind: "message",
          messageType: String(plain.msgtype),
          roomId: ROOM,
          sender: { isMe: raw.sender === ME, userId: String(raw.sender) },
          text: String(plain.body),
          timestamp: Number(raw.origin_server_ts),
          type: "m.room.message",
          ...(relates?.["m.in_reply_to"] ? { replyTo: relates["m.in_reply_to"].event_id } : {}),
        };
      };
      const put = async (type: string, body: unknown) => {
        for (let attempt = 0; ; attempt += 1) {
          try {
            const response = await f(
              `${hs}/_matrix/client/v3/rooms/${ENC}/send/${type}/mautrix-go_${randomUUID()}`,
              { method: "PUT", body: new TextEncoder().encode(JSON.stringify(body)) },
            );
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return {
              eventId: ((await response.json()) as { event_id: string }).event_id,
              roomId: ROOM,
            };
          } catch (error) {
            if (attempt >= 1 || !(error instanceof TypeError)) throw error;
          }
        }
      };
      return {
        boot: async () => ({ deviceId: options.account.deviceId, userId: options.account.userId }),
        whoami: async () => ({
          deviceId: options.account.deviceId,
          userId: options.account.userId,
        }),
        close: async () => undefined,
        logout: async () => {
          calls.logout += 1;
        },
        crypto: {
          status: async () => ({
            state: "recoveryRestored",
            hasRecoveryKey: true,
            pendingDecryptionCount: 0,
            storeBacked: true,
            keyBackupVersion: "7",
          }),
        },
        subscribe: async (_filter, h) => {
          handler = h as (event: MatrixClientEvent) => void;
          server.emit = handler;
          return {
            catchUp: async () => undefined,
            done: new Promise(() => undefined),
            stop: async () => undefined,
          };
        },
        rooms: {
          get: async () => ({ id: ROOM, encrypted: true, name: "Sam", memberCount: 2 }),
          listJoined: async () => ({ roomIds: [ROOM] }),
        },
        raw: { request: async () => ({ status: 200 }) },
        media: {
          download: async ({ contentUri }) => ({
            bytes: server.media.get(contentUri) as Uint8Array,
          }),
          downloadEncrypted: async ({ file }) => ({
            bytes: server.media.get(file.url) as Uint8Array,
          }),
        },
        reactions: {
          send: async ({ eventId, key }) =>
            put("m.reaction", {
              "m.relates_to": { rel_type: "m.annotation", event_id: eventId, key },
            }),
        },
        messages: {
          list: async () => {
            const body = (await (
              await f(`${hs}/_matrix/client/v3/rooms/${ENC}/messages?dir=b`)
            ).json()) as { chunk: Array<Record<string, unknown>>; end: string };
            return {
              messages: body.chunk
                .map(toMessage)
                .filter((m): m is MatrixMessageEvent => m !== null)
                .reverse(),
              nextCursor: body.end,
            };
          },
          get: async ({ eventId }) => {
            const response = await f(
              `${hs}/_matrix/client/v3/rooms/${ENC}/event/${encodeURIComponent(eventId)}`,
            );
            if (!response.ok) throw new Error("M_NOT_FOUND");
            return { message: toMessage((await response.json()) as Record<string, unknown>) };
          },
          send: async ({ text, replyTo }) =>
            put("m.room.encrypted", {
              msgtype: "m.text",
              body: text,
              ...(replyTo ? { "m.relates_to": { "m.in_reply_to": { event_id: replyTo } } } : {}),
            }),
          sendMedia: async ({ bytes, filename, contentType }) => {
            const uri = `mxc://beeper.com/${randomUUID()}`;
            server.media.set(uri, bytes);
            return put("m.room.encrypted", {
              msgtype: "m.file",
              body: filename,
              info: { mimetype: contentType, size: bytes.byteLength },
              file: { url: uri, v: "v2", iv: "", hashes: { sha256: "" }, key: {} },
            });
          },
        },
      } as PickleClient;
    },
  };
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), "bi-home-"));
  const env = { HOME: home, HERMES_HOME: home, PATH: process.env.PATH } as NodeJS.ProcessEnv;
  const paths = inboxPaths(env);
  mkdirSync(paths.state, { recursive: true });
  writeFileSync(
    paths.account,
    JSON.stringify({ homeserver: "https://matrix.example", userId: ME, deviceId: "HERMESDEV" }),
  );
  writeFileSync(
    paths.hermesEnv,
    "BEEPER_INBOX_ACCESS_TOKEN=tok\nBEEPER_INBOX_PICKLE_KEY=pk\nBEEPER_INBOX_RECOVERY_KEY=EsTc 1234 abcd EFGH 5678 ijkm NPQR 9abc defg hijk mnop qrst\n",
  );
  const server = new FakeHomeserver();
  const calls = { logout: 0, created: 0 };
  return { home, env, paths, server, calls, pickle: async () => fakePickle(server, calls) };
}

const tool = (socket: string, name: string, args: Record<string, unknown> = {}) =>
  callIpc(socket, "tool", { name, arguments: args }) as Promise<Record<string, unknown>>;

test("daemon: one owner, tools over the socket, explicit decryption gaps, safe sends, no logout on stop", async () => {
  const { env, paths, server, calls, pickle } = setup();
  const daemon = await startDaemon({
    env,
    pickle,
    baseFetch: server.fetch,
    embedded: true,
    bridgeStatusWaitMs: 20,
  });
  assert.ok(daemon);
  await daemon.ready;
  assert.equal(
    await startDaemon({
      env,
      pickle,
      baseFetch: server.fetch,
      embedded: true,
      bridgeStatusWaitMs: 20,
    }),
    null,
    "a second owner is refused",
  );
  assert.ok(existsSync(join(paths.state, "verified.json")), "first boot records the cross-signing");

  const conversations = await tool(paths.socket, "list_conversations", { query: "sam" });
  assert.equal(
    (conversations.conversations as Array<{ room_id: string; network: string }>)[0]?.network,
    "whatsapp",
  );

  const page = await tool(paths.socket, "list_messages", { room_id: ROOM });
  const messages = page.messages as Array<{
    text: string;
    event_id: string;
    attachments: unknown[];
  }>;
  assert.deepEqual(
    messages.map((m) => m.text),
    ["hi Leon", "photo.jpg"],
  );
  assert.equal(page.complete, false);
  assert.equal(
    (page.undecryptable as Array<{ error: string }>)[0]?.error,
    "no session for this message",
  );

  const photo = messages[1] as { event_id: string };
  const download = await tool(paths.socket, "download_attachment", {
    room_id: ROOM,
    event_id: photo.event_id,
  });
  assert.equal(readFileSync(String(download.path), "utf8"), "JPEGBYTES");
  assert.equal(download.sha256, createHash("sha256").update("JPEGBYTES").digest("hex"));
  assert.equal(download.bytes, 9);

  await assert.rejects(
    tool(paths.socket, "list_messages", { room_id: "1793918187.574419" }),
    /not a Matrix room ID/,
  );
  // Room version 12 IDs have no server part; they're as valid as any other (IDs are opaque).
  const v12 = await tool(paths.socket, "get_conversation", {
    room_id: "!Qx7vR2kLm9TfW4aZcY8nB3uE6hJ1sD5gP0oKiVtXy-_",
  });
  assert.equal(v12.room_id, "!Qx7vR2kLm9TfW4aZcY8nB3uE6hJ1sD5gP0oKiVtXy-_");
  await assert.rejects(
    tool(paths.socket, "send_message", { room_id: ROOM, text: "x", reply_to: "1793918187.574419" }),
    /not a Matrix event ID/,
  );

  // Overlapping identical sends: one event.
  const reply = (messages[0] as { event_id: string }).event_id;
  const [a, b] = await Promise.all([
    tool(paths.socket, "send_message", { room_id: ROOM, text: "on my way", reply_to: reply }),
    tool(paths.socket, "send_message", { room_id: ROOM, text: "on my way", reply_to: reply }),
  ]);
  assert.equal(a.event_id, b.event_id);
  assert.equal([a.deduplicated, b.deduplicated].filter(Boolean).length, 1);
  assert.equal((a.readback as { sent_encrypted: boolean }).sent_encrypted, true);
  assert.equal(a.reply_linked ?? b.reply_linked, true);
  assert.equal(server.sendPuts.length, 1);

  // Lost responses: Pickle retries with a fresh transaction ID, the pinned one reaches the server, and a
  // later call with the same key still lands on the same event.
  server.loseNextSendResponses = 2;
  await assert.rejects(
    tool(paths.socket, "send_message", { room_id: ROOM, text: "lost?", idempotency_key: "q1" }),
    /may or may not have been delivered/,
  );
  const putsAfterLoss = server.sendPuts.slice(1);
  assert.equal(putsAfterLoss.length, 2);
  assert.equal(new Set(putsAfterLoss).size, 1, "both attempts used one transaction ID");
  const retried = await tool(paths.socket, "send_message", {
    room_id: ROOM,
    text: "lost?",
    idempotency_key: "q1",
  });
  assert.equal(retried.resent_after_unknown, true);
  assert.equal(
    server.timeline.filter(
      (id) =>
        (server.events.get(id)?.content as { fake_plaintext?: { body?: string } })?.fake_plaintext
          ?.body === "lost?",
    ).length,
    1,
    "delivered once",
  );
  await assert.rejects(
    tool(paths.socket, "send_message", { room_id: ROOM, text: "different", idempotency_key: "q1" }),
    /already used for different content/,
  );

  // Files: refused secrets, and a real one with a round trip.
  await assert.rejects(
    tool(paths.socket, "send_file", { room_id: ROOM, path: paths.hermesEnv }),
    /hidden files|credential/,
  );
  const file = join(paths.downloads, "report.pdf");
  writeFileSync(file, "%PDF-1.7 test");
  const sentFile = await tool(paths.socket, "send_file", { room_id: ROOM, path: file });
  assert.equal((sentFile.round_trip as { sha256_matches: boolean }).sha256_matches, true);
  assert.equal((sentFile.file as { content_type: string }).content_type, "application/pdf");

  const reaction = await tool(paths.socket, "send_reaction", {
    room_id: ROOM,
    event_id: reply,
    key: "👍",
  });
  assert.equal(reaction.status, "sent");
  assert.ok(server.sendPuts.at(-1)?.startsWith("m.reaction/bi"));

  const status = (await callIpc(paths.socket, "status")) as Record<string, unknown>;
  assert.equal(status.state, "ready");
  assert.equal((status.account as { device_id: string }).device_id, "HERMESDEV");

  await daemon.shutdown();
  assert.equal(calls.logout, 0, "stopping never logs the device out");
  await assert.rejects(callIpc(paths.socket, "ping", undefined, 1000), {
    code: "daemon_unreachable",
  });
  const again = await startDaemon({
    env,
    pickle,
    baseFetch: server.fetch,
    embedded: true,
    bridgeStatusWaitMs: 20,
  });
  assert.ok(again, "the lock is free after a clean stop");
  await again.ready;
  const restarted = (await callIpc(paths.socket, "status")) as Record<string, unknown>;
  assert.equal(
    (restarted.account as { device_id: string }).device_id,
    "HERMESDEV",
    "same device after restart",
  );
  const dedupedAfterRestart = await tool(paths.socket, "send_message", {
    room_id: ROOM,
    text: "lost?",
    idempotency_key: "q1",
  });
  assert.equal(dedupedAfterRestart.deduplicated, true, "the ledger survives a restart");
  await again.shutdown();
});

test("daemon without a login reports needs_login instead of failing", async () => {
  const { env, paths, server, pickle } = setup();
  writeFileSync(paths.hermesEnv, "");
  const daemon = await startDaemon({
    env,
    pickle,
    baseFetch: server.fetch,
    embedded: true,
    bridgeStatusWaitMs: 20,
  });
  assert.ok(daemon);
  await daemon.ready;
  const status = (await callIpc(paths.socket, "status")) as Record<string, unknown>;
  assert.equal(status.state, "needs_login");
  await assert.rejects(tool(paths.socket, "list_messages", { room_id: ROOM }), /isn't signed in/);
  // Adding the secrets (Leon on the dashboard's Keys page) is noticed and picked up.
  assert.equal(await daemon.inbox.secretsChange(), "none");
  writeFileSync(paths.hermesEnv, "BEEPER_INBOX_ACCESS_TOKEN=tok\n");
  assert.equal(await daemon.inbox.secretsChange(), "reload");
  await daemon.inbox.reload();
  assert.equal(((await callIpc(paths.socket, "status")) as Record<string, unknown>).state, "ready");
  assert.equal(await daemon.inbox.secretsChange(), "none");

  // 2026-11-19: the recovery key went into BEEPER_INBOX_PICKLE_KEY. That slot no longer matters, and
  // the status explains the mix-up instead of the store becoming unreadable.
  writeFileSync(
    paths.hermesEnv,
    'BEEPER_INBOX_ACCESS_TOKEN=tok\nBEEPER_INBOX_PICKLE_KEY="EsTc 1234 abcd EFGH 5678 ijkm NPQR 9abc defg hijk mnop qrst"\n',
  );
  assert.equal(
    await daemon.inbox.secretsChange(),
    "none",
    "the old pickle-key slot isn't part of the session any more",
  );
  await daemon.inbox.reload();
  const mixed = (await callIpc(paths.socket, "status")) as {
    state: string;
    secrets: { problems: string[]; recovery_key: string };
  };
  assert.equal(mixed.state, "ready");
  assert.equal(mixed.secrets.recovery_key, "missing");
  assert.match(
    mixed.secrets.problems.join(" "),
    /looks like the recovery key; put it in BEEPER_INBOX_RECOVERY_KEY/,
  );

  // A malformed recovery key is reported and the working session stays up.
  writeFileSync(
    paths.hermesEnv,
    "BEEPER_INBOX_ACCESS_TOKEN=tok\nBEEPER_INBOX_RECOVERY_KEY=not-a-key\n",
  );
  assert.equal(await daemon.inbox.secretsChange(), "rejected");
  assert.equal(await daemon.inbox.secretsChange(), "none", "reported once");
  const rejected = (await callIpc(paths.socket, "status")) as {
    state: string;
    secrets: { problems: string[] };
  };
  assert.equal(rejected.state, "ready");
  assert.match(rejected.secrets.problems.join(" "), /isn't in the recovery-key format/);

  // The store key is generated beside the store, owner-only, and survives restarts unchanged.
  const keyFiles = readdirSync(paths.state).filter((name) => name.startsWith("pickle-key-"));
  assert.equal(keyFiles.length, 1);
  const keyFile = join(paths.state, keyFiles[0] as string);
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  const firstKey = readFileSync(keyFile, "utf8");
  await daemon.inbox.reload();
  assert.equal(readFileSync(keyFile, "utf8"), firstKey);
  await daemon.shutdown();
});

test("extensions: served by the same daemon, reach Beeper through the inbox's tools, stopped with it", async () => {
  const { env, paths, server, pickle } = setup();
  const stopped: string[] = [];
  const serverInfo = { name: "x", version: "0", instructions: "", tools: [] };
  const daemon = await startDaemon({
    env,
    pickle,
    baseFetch: server.fetch,
    embedded: true,
    bridgeStatusWaitMs: 20,
    extensions: [
      {
        name: "echo",
        server: serverInfo,
        start: (context) => ({
          callTool: async (name, args) => {
            const found = await context.tool("list_conversations", { query: "sam" });
            return { ok: true, name, args, home: context.home, rooms: found.total };
          },
          stop: () => {
            stopped.push("echo");
          },
        }),
      },
      {
        name: "broken",
        server: serverInfo,
        start: () => {
          throw new Error("boom");
        },
      },
    ],
  });
  assert.ok(daemon, "an extension that fails to start doesn't stop the inbox");
  await daemon.ready;
  const direct = await tool(paths.socket, "list_conversations", { query: "sam" });
  assert.deepEqual(
    await callIpc(paths.socket, "extension", {
      extension: "echo",
      name: "hello",
      arguments: { a: 1 },
    }),
    {
      ok: true,
      name: "hello",
      args: { a: 1 },
      home: join(paths.home, "echo"),
      rooms: direct.total,
    },
  );
  assert.ok(existsSync(join(paths.home, "echo")), "the extension gets its own directory");
  await assert.rejects(
    callIpc(paths.socket, "extension", { extension: "broken", name: "x" }),
    /no extension "broken"/,
  );
  await daemon.shutdown();
  assert.deepEqual(stopped, ["echo"]);
});

test("journal: sync messages are written down once; edits, late keys and deletions update them", async (t) => {
  const { env, paths, server, pickle } = setup();
  let tapped: ExtensionJournal | null = null;
  const daemon = await startDaemon({
    env,
    pickle,
    baseFetch: server.fetch,
    embedded: true,
    bridgeStatusWaitMs: 20,
    extensions: [
      {
        name: "tap",
        server: { name: "tap", version: "0", instructions: "", tools: [] },
        start: (context) => {
          tapped = context.journal;
          return { callTool: async () => ({}) };
        },
      },
    ],
  });
  assert.ok(daemon);
  await daemon.ready;
  const journal = tapped as ExtensionJournal | null;
  assert.ok(journal);
  t.after(() => daemon.shutdown());
  const message = (eventId: string, text: string, extra: Record<string, unknown> = {}) =>
    ({
      kind: "message",
      eventId,
      roomId: ROOM,
      sender: { isMe: false, userId: "@sam:beeper.local" },
      text,
      messageType: "m.text",
      timestamp: Date.now(),
      type: "m.room.message",
      attachments: [],
      content: {},
      edited: false,
      encrypted: true,
      ...extra,
    }) as MatrixClientEvent;

  const head = await journal.head();
  assert.ok(Date.now() - (await journal.coveredSince()) < 60_000, "a new journal vouches from now");
  const waiting = journal.changes({ after: head, roomId: ROOM, waitMs: 5000 });
  setTimeout(() => server.emit(message("$m1", "hi")), 20);
  const first = await waiting;
  assert.deepEqual(
    first.entries.map((entry) => [entry.eventId, entry.text, entry.isMe, entry.edited]),
    [["$m1", "hi", false, false]],
  );
  server.emit(message("$m1", "hi"));
  assert.equal((await journal.changes({ after: first.cursor })).entries.length, 0, "seen before");

  // An edit changes the message it replaces; its own body is only a fallback.
  server.emit(
    message("$m2", "* hello", {
      replaces: "$m1",
      edited: true,
      content: { "m.new_content": { body: "hello", msgtype: "m.text" } },
    }),
  );
  const edited = await journal.changes({ after: first.cursor, roomId: ROOM });
  assert.deepEqual(
    edited.entries.map((entry) => [entry.eventId, entry.text, entry.edited, entry.seq]),
    [["$m1", "hello", true, first.entries[0]?.seq]],
  );
  assert.ok((edited.entries[0]?.rev ?? 0) > (first.entries[0]?.rev ?? 0));

  // An event without its keys yet is held back until it can be read.
  server.emit({
    kind: "decryptionError",
    error: "no session",
    event: { eventId: "$m3", roomId: ROOM, senderId: "@sam:beeper.local" },
  });
  assert.equal((await journal.changes({ after: edited.cursor })).entries.length, 0);
  const status = (await callIpc(paths.socket, "status")) as { journal: Record<string, unknown> };
  assert.equal(status.journal.waiting_for_keys, 1);
  server.emit(message("$m3", "now readable"));
  const late = await journal.changes({ after: edited.cursor });
  assert.deepEqual(
    late.entries.map((entry) => [entry.eventId, entry.text]),
    [["$m3", "now readable"]],
  );

  server.emit({
    kind: "redaction",
    eventId: "$r1",
    roomId: ROOM,
    type: "m.room.redaction",
    content: { redacts: "$m3" },
  });
  const gone = await journal.changes({ after: late.cursor });
  assert.deepEqual(
    gone.entries.map((entry) => [entry.eventId, entry.text, entry.redacted]),
    [["$m3", "", true]],
  );
  assert.deepEqual(
    (await journal.latest(ROOM, 5)).map((entry) => entry.eventId),
    ["$m1", "$m3"],
  );

  // What an operator sees: no text unless it is asked for.
  const listed = (await callIpc(paths.socket, "journal", { after: head })) as {
    entries: Array<Record<string, unknown>>;
    entries_total?: number;
  };
  assert.deepEqual(
    listed.entries.map((entry) => [entry.eventId, entry.chars, "text" in entry]),
    [
      ["$m1", 5, false],
      ["$m3", 0, false],
    ],
  );
});
