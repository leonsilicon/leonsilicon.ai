import assert from "node:assert/strict";
import { test } from "node:test";
import { GmailClient, GmailError } from "#gmail";

const credentials = { clientId: "id", clientSecret: "secret", refreshToken: "refresh" };
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeFetch(answers: Array<[number, unknown]>) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push(url.includes("oauth2") ? "token" : (new URL(url).pathname.split("/").at(-1) ?? ""));
    if (url.includes("oauth2")) return reply(200, { access_token: "at", expires_in: 3600 });
    const [status, body] = answers.shift() ?? [500, {}];
    return reply(status, body);
  }) as typeof fetch;
  return { impl, calls };
}

test("refreshes once and reuses the token; retries rate limits, including Gmail's 403s", async () => {
  const limited = { error: { errors: [{ reason: "userRateLimitExceeded" }] } };
  const { impl, calls } = fakeFetch([
    [403, limited],
    [200, { emailAddress: "me@x.org", historyId: 42 }],
    [200, { labels: [{ id: "Label_1", name: "Receipts", type: "user" }] }],
  ]);
  const gmail = new GmailClient(credentials, impl);
  assert.deepEqual(await gmail.profile(), { emailAddress: "me@x.org", historyId: "42" });
  assert.equal((await gmail.labels()).length, 1);
  assert.deepEqual(calls, ["token", "profile", "profile", "labels"]);
});

test("a 404 on history comes back as a GmailError the feed can catch up from", async () => {
  const { impl } = fakeFetch([[404, { error: { errors: [{ reason: "notFound" }] } }]]);
  const error = await new GmailClient(credentials, impl).history("1").catch((e: unknown) => e);
  assert.ok(error instanceof GmailError);
  assert.equal(error.status, 404);
  assert.equal(error.reason, "notFound");
});

test("a revoked token fails with Google's reason", async () => {
  const impl = (async () => reply(400, { error: "invalid_grant" })) as unknown as typeof fetch;
  await assert.rejects(new GmailClient(credentials, impl).profile(), /token: 400 invalid_grant/);
});
