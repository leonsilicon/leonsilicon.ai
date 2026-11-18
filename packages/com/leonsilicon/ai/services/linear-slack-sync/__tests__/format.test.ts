import assert from "node:assert/strict";
import { test } from "node:test";
import {
  channelName,
  channelNumber,
  channelTopic,
  formatTitle,
  linearToSlack,
  metaInstant,
  parseTitle,
  slackToLinear,
} from "#format";
import { hmacHex, verifyLinear, verifySlack } from "#verify";

test("parseTitle reads the backticked YAML at the end of a title", () => {
  assert.deepEqual(
    parseTitle("switch to rogers `{event: Rogers unlimited BYOD deal, stop: 2026-12-01}`"),
    {
      name: "switch to rogers",
      meta: { event: "Rogers unlimited BYOD deal", stop: "2026-12-01" },
    },
  );
  assert.deepEqual(parseTitle('Ask `{event: "Deal: under $50, unlimited"}`'), {
    name: "Ask",
    meta: { event: "Deal: under $50, unlimited" },
  });
  assert.deepEqual(parseTitle("Fix `{iOS}` crash"), { name: "Fix `{iOS}` crash", meta: {} });
  assert.deepEqual(parseTitle("Plain title"), { name: "Plain title", meta: {} });
  assert.deepEqual(parseTitle("Broken `{a: [}`"), { name: "Broken `{a: [}`", meta: {} });
});

test("formatTitle writes metadata back and round-trips through parseTitle", () => {
  assert.equal(formatTitle("x", {}), "x");
  const title = formatTitle("switch to rogers", {
    event: "Deal: under $50, unlimited",
    stop: "2026-12-01",
  });
  assert.equal(title, 'switch to rogers `{event: "Deal: under $50, unlimited", stop: 2026-12-01}`');
  assert.deepEqual(parseTitle(title).meta, {
    event: "Deal: under $50, unlimited",
    stop: "2026-12-01",
  });
});

test("metaInstant reads bare dates as Toronto midnight and RFC 3339 times as given", () => {
  assert.equal(
    metaInstant("2026-12-01", "America/Toronto")?.toISOString(),
    "2026-12-01T05:00:00.000Z",
  );
  assert.equal(
    metaInstant("2026-07-01", "America/Toronto")?.toISOString(),
    "2026-07-01T04:00:00.000Z",
  );
  assert.equal(
    metaInstant("2026-12-01T09:00:00-05:00", "America/Toronto")?.toISOString(),
    "2026-12-01T14:00:00.000Z",
  );
  assert.equal(metaInstant("next week", "America/Toronto"), null);
  assert.equal(metaInstant("2026-12-01T09:00", "America/Toronto"), null);
});

test("channel names use the prefix and number, cut at a word", () => {
  assert.equal(channelName("leon", 205, "switch to rogers", 60), "leon-205-switch-to-rogers");
  assert.equal(
    channelName("leon", 315, "Migrate Instagram payout setup from US to Canada", 50),
    "leon-315-migrate-instagram-payout-setup-from-us-to",
  );
  assert.equal(channelName("leon", 7, "Café — résumé!", 60), "leon-7-cafe-resume");
  assert.equal(channelName("leon", 8, "!!!", 60), "leon-8");
  assert.equal(channelNumber("leon", "leon-205-switch-to-rogers"), 205);
  assert.equal(channelNumber("leon", "leon-205"), 205);
  assert.equal(channelNumber("leon", "leonx-205"), null);
  assert.equal(channelNumber("leon", "general"), null);
});

test("the topic carries status, metadata and link, within Slack's limit", () => {
  assert.equal(
    channelTopic(
      "Awaiting Listener",
      { event: "deal", stop: "2026-12-01" },
      "https://linear.app/x/issue/LEON-205",
    ),
    "Awaiting Listener · event: deal · stop: 2026-12-01 · https://linear.app/x/issue/LEON-205",
  );
  assert.ok(channelTopic("S", { event: "x".repeat(400) }, "https://l/1").length <= 250);
});

test("linearToSlack converts Markdown to mrkdwn", () => {
  const md = [
    "## Current state",
    "**Bold** and *italic* and ~~gone~~ with [a link](https://x.com/a?b=1&c=2).",
    "* first",
    "- second",
    "> quoted <tag>",
    "`**not bold**` and ![shot](https://img/1.png)",
    "---",
  ].join("\n");
  assert.equal(
    linearToSlack(md),
    [
      "*Current state*",
      "*Bold* and _italic_ and ~gone~ with <https://x.com/a?b=1&amp;c=2|a link>.",
      "• first",
      "• second",
      "> quoted &lt;tag&gt;",
      "`**not bold**` and <https://img/1.png|shot>",
      "──────────",
    ].join("\n"),
  );
});

test("slackToLinear converts mrkdwn, mentions and links to Markdown", () => {
  const names: Record<string, string> = { U1: "Leon", U2: "Hermes" };
  assert.equal(
    slackToLinear(
      "*yes* _please_ ~no~ <@U1> ask <@U2|hermes> in <#C1|general> <https://a.com|site> <https://b.com> &lt;3 `*raw* &amp;`\n• item",
      (id) => names[id] ?? id,
    ),
    "**yes** *please* ~~no~~ @Leon ask @Hermes in #general [site](https://a.com) https://b.com <3 `*raw* &`\n- item",
  );
});

test("Slack and Linear signatures verify, and stale or forged ones don't", async () => {
  const now = Date.UTC(2026, 10, 18, 20, 0);
  const ts = String(Math.floor(now / 1000));
  const body = '{"type":"event_callback"}';
  const good = `v0=${await hmacHex("s3cret", `v0:${ts}:${body}`)}`;
  assert.equal(await verifySlack("s3cret", ts, good, body, now), true);
  assert.equal(await verifySlack("s3cret", ts, good, body + " ", now), false);
  assert.equal(await verifySlack("s3cret", ts, good, body, now + 10 * 60_000), false);
  assert.equal(await verifySlack("s3cret", null, good, body, now), false);

  const hook = JSON.stringify({ action: "create", type: "Issue", webhookTimestamp: now });
  const sig = await hmacHex("whsec", hook);
  assert.equal(await verifyLinear("whsec", sig, hook, now + 1000), true);
  assert.equal(await verifyLinear("whsec", sig, hook, now + 10 * 60_000), false);
  assert.equal(await verifyLinear("other", sig, hook, now), false);
});
