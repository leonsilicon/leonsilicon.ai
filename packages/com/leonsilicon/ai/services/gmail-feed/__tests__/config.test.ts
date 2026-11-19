import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "#config";

const env = {
  GMAIL_FEED_GOOGLE_CLIENT_ID: "id",
  GMAIL_FEED_GOOGLE_CLIENT_SECRET: "secret",
  GMAIL_FEED_GOOGLE_REFRESH_TOKEN: "refresh",
  SLACK_BOT_TOKEN: "xoxb-1",
  OPENAI_API_KEY: "sk-1",
  HERMES_SLACK_USER_ID: "UHERMES",
  FEED_FLAGGED_CHANNEL: "CFLAGGED1",
  FEED_SPAM_CHANNEL: "CSPAM0001",
  FEED_INVITE: " ULEON , ",
};

test("email has its own wake threshold, 0.9 unless set", () => {
  const config = loadConfig(env);
  assert.equal(config.screen.wake, 0.9);
  assert.equal(config.screen.unsafe, 0.3);
  assert.equal(config.feed.wake, "screened");
  assert.equal(config.feed.channel, "feed-gmail");
  assert.deepEqual(config.feed.invite, ["ULEON"]);
  assert.equal(loadConfig({ ...env, GMAIL_FEED_WAKE_THRESHOLD: "0.95" }).screen.wake, 0.95);
  // Beeper's knob doesn't move email's.
  assert.equal(loadConfig({ ...env, SCREEN_WAKE_THRESHOLD: "0.5" }).screen.wake, 0.9);
});

test("missing secrets and bad settings fail loudly", () => {
  const { OPENAI_API_KEY: _, ...noKey } = env;
  assert.throws(() => loadConfig(noKey), /OPENAI_API_KEY is not set/);
  assert.throws(() => loadConfig({ ...env, GMAIL_FEED_WAKE: "sometimes" }), /screened or none/);
  assert.equal(
    loadConfig({ ...env, GMAIL_FEED_SPAM_CHANNEL: "CGMAILSPAM" }).feed.spamChannel,
    "CGMAILSPAM",
  );
});
