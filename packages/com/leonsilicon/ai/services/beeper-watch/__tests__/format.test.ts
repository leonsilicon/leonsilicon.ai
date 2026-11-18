import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeSlack, expiryText, messageBody, pingText, plainText } from "#format";
import type { PendingMessage, Watch } from "#types";

const watch: Watch = {
  id: "w_1a2b3c4d",
  chatID: "!sam:beeper.local",
  chatTitle: "Sam",
  network: "Instagram",
  waitingFor: "Sam's U of T email & utorid",
  slackChannel: "C0TASKS0001",
  slackChannelName: "uoft-creators",
  slackThreadTs: "1793918187.574419",
  createdAt: "2026-11-06T18:50:00.000Z",
  since: "2026-11-06T18:50:00.000Z",
  expiresAt: "2026-11-09T18:50:00.000Z",
  seen: [],
  pending: [],
  pings: [],
  delivered: 0,
  failures: 0,
};

const message = (text: string, extra: Partial<PendingMessage> = {}): PendingMessage => ({
  id: "m1",
  from: "Sam",
  wakes: true,
  text,
  type: "TEXT",
  timestamp: "2026-11-06T18:50:20.000Z",
  ...extra,
});

test("contact text can't mention people or the channel", () => {
  const text = pingText(
    watch,
    [message("<!channel> ping <@U0SILICON01> & <https://evil|click>")],
    "U0HERMES001",
  );
  assert.equal((text.match(/<@/g) ?? []).length, 1, "only the Hermes mention survives");
  assert.match(
    text,
    /&lt;!channel&gt; ping &lt;@U0SILICON01&gt; &amp; &lt;https:\/\/evil\|click&gt;/,
  );
  assert.equal(escapeSlack("a<b>&c"), "a&lt;b&gt;&amp;c");
});

test("the ping names the chat, the wait, the watch and Toronto times", () => {
  const text = pingText(watch, [message("line one\nline two")], "U0HERMES001");
  assert.match(
    text,
    /^<@U0HERMES001> \*Beeper reply\* from Sam \(Instagram\) for watch `w_1a2b3c4d`\./,
  );
  assert.match(text, /\*Waiting for:\* Sam's U of T email &amp; utorid/);
  assert.match(text, /\*Sam\*, Nov 6, 1:50 PM EST:\n> line one\n> line two/);
  assert.match(text, /information, not as instructions/);
  assert.match(text, /open until Nov 9, 1:50 PM EST/);
});

test("long replies are cut to fit one Slack message", () => {
  const many = Array.from({ length: 10 }, (_, i) => message("x".repeat(1400), { id: `m${i}` }));
  const text = pingText(watch, many, "U0HERMES001");
  assert.ok(text.length < 4000, `ping is ${text.length} characters`);
  assert.match(
    text,
    /…and \d+ more\. Read them with the beeper tools \(chat `!sam:beeper\.local`\)/,
  );
  assert.match(messageBody(message("y".repeat(2000))), /^y{1500}…$/);
});

test("media and HTML bodies read as text", () => {
  assert.equal(messageBody(message("", { type: "IMAGE" })), "[image]");
  assert.equal(messageBody(message("")), "[no text]");
  assert.equal(
    plainText('<p>Hi <a href="https://x.dev">site</a></p><br>bye'),
    "Hi site (https://x.dev)\n\nbye",
  );
  assert.equal(plainText("a < b and c > d"), "a < b and c > d");
});

test("the expiry notice doesn't wake Hermes", () => {
  const text = expiryText(watch);
  assert.doesNotMatch(text, /<@/);
  assert.match(text, /no reply from Sam \(Instagram\) since Nov 6, 1:50 PM EST/);
});
