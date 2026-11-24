import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { authorizePubSub, parseGmailNotification } from "#pubsub";
import { GmailPush } from "#push";
import { Store, type Row } from "#store";

const NOW = Date.parse("2026-11-24T17:00:00Z");
const TOPIC = "projects/example/topics/gmail";
const DAY = 24 * 60 * 60_000;
const quiet = () => {};

function setup(t: TestContext) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const store = new Store({
    exec: (sql, ...bindings) => db.prepare(sql).all(...bindings) as Row[],
  });
  store.set("history_id", "90071992547409930");
  return { store, push: new GmailPush(store, TOPIC) };
}

test("keeps the cursor until history is read and goes idle once Gmail has caught up", async (t) => {
  const { store, push } = setup(t);
  let watches = 0;
  const gmail = {
    async watch(topic: string) {
      assert.equal(topic, TOPIC);
      watches++;
      return { historyId: "90071992547409931", expiration: NOW + 7 * DAY };
    },
  };
  assert.equal(push.watchAt(), 0);
  await push.renew(gmail, quiet, NOW);
  assert.equal(push.active, false, "the initial push must reach the webhook");
  assert.equal(push.watchAt(), NOW + DAY);
  await push.renew(gmail, quiet, NOW + 60_000);
  assert.equal(watches, 1);
  push.notify("90071992547409931", NOW + 1);
  assert.equal(push.active, true);
  push.notify("90071992547409925", NOW + 2);
  assert.equal(store.get("push_history_id"), "90071992547409931");
  assert.equal(store.get("history_id"), "90071992547409930");
  assert.equal(push.syncAt(), 0);

  await push.sync(
    {
      async poll() {
        store.set("history_id", "90071992547409931");
        return { queued: 1 };
      },
    },
    NOW + 3,
  );
  push.notify("90071992547409931", NOW + 4);
  assert.equal(push.syncAt(), null, "duplicate or covered pushes require no Gmail read");
});

test("schedules catch-up for a dropped notification and retains work on failure or overlapping pushes", async (t) => {
  const { store, push } = setup(t);
  const renewal = {
    async watch() {
      return { historyId: "90071992547409932", expiration: NOW + 7 * DAY };
    },
  };
  await push.renew(renewal, quiet, NOW);
  assert.equal(push.syncAt(), 0, "renewal sees an advance without an incoming push");
  await push.sync(
    {
      async poll() {
        throw new Error("temporary Gmail error");
      },
    },
    NOW,
  );
  assert.equal(new GmailPush(store, TOPIC).syncAt(), NOW + 60_000);

  await push.sync(
    {
      async poll() {
        push.notify("90071992547409933", NOW + 60_001);
        store.set("history_id", "90071992547409932");
        return { queued: 1 };
      },
    },
    NOW + 60_000,
  );
  assert.equal(push.syncAt(), 0);

  await push.sync(
    {
      async poll() {
        store.set("history_id", "90071992547409933");
        return { queued: 1 };
      },
    },
    NOW + 60_002,
  );
  assert.equal(push.syncAt(), null);
});

test("parses wrapped Pub/Sub pushes and keeps Gmail history IDs as exact strings", () => {
  const info = { emailAddress: "person@example.test", historyId: "90071992547409931" };
  const event = (data: unknown) => ({
    message: { data: Buffer.from(JSON.stringify(data)).toString("base64url") },
  });
  assert.deepEqual(parseGmailNotification(event(info)), info);
  assert.equal(parseGmailNotification(event({ ...info, historyId: 123 })), null);
  assert.equal(parseGmailNotification(event(null)), null);
  assert.equal(parseGmailNotification({ message: { data: "&" } }), null);
});

test("requires a Google signature, this endpoint's audience, and the verified push identity", async () => {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    false,
    ["sign", "verify"],
  );
  const audience = "https://example.test/webhooks/gmail";
  const account = "pubsub@example.test";
  const now = Math.floor(Date.now() / 1000);
  const make = async (claims: Record<string, unknown> = {}) => {
    const encode = (data: unknown) => Buffer.from(JSON.stringify(data)).toString("base64url");
    const header = encode({ alg: "RS256" });
    const payload = encode({
      iss: "https://accounts.google.com",
      aud: audience,
      iat: now,
      exp: now + 60,
      email: account,
      email_verified: true,
      ...claims,
    });
    const value = `${header}.${payload}`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      privateKey,
      new TextEncoder().encode(value),
    );
    return `Bearer ${value}.${Buffer.from(signature).toString("base64url")}`;
  };
  const verify = (authorization: string | null) =>
    authorizePubSub(authorization, account, audience, async () => publicKey);
  assert.equal(await verify(await make()), true);
  assert.equal(await verify(await make({ email: "other@example.test" })), false);
  assert.equal(await verify(await make({ email_verified: false })), false);
  assert.equal(
    await verify(await make({ aud: "https://other.example.test/webhooks/gmail" })),
    false,
  );
  assert.equal(await verify(await make({ iss: "https://other.example.test" })), false);
  assert.equal(await verify(await make({ exp: now - 1 })), false);
  const valid = await make();
  assert.equal(await verify(valid.replace(/\.[^.]+$/, ".broken")), false);
});
