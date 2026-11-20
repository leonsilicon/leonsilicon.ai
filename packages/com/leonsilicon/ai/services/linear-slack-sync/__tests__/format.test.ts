import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addDays,
  channelName,
  channelNumber,
  channelTopic,
  formatTitle,
  hasTime,
  linearToSlack,
  localDay,
  localLabel,
  mentions,
  metaInstant,
  parseTitle,
  projectChannelName,
  projectDay,
  slackToLinear,
  withDay,
  zonedIso,
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

test("zonedIso writes an instant as Toronto wall-clock time with its offset", () => {
  assert.equal(
    zonedIso(Date.UTC(2026, 11, 1, 22, 0, 0, 500), "America/Toronto"),
    "2026-12-01T17:00:00-05:00",
  );
  assert.equal(
    zonedIso(Date.UTC(2026, 6, 1, 21, 30), "America/Toronto"),
    "2026-07-01T17:30:00-04:00",
  );
  assert.equal(zonedIso(Date.UTC(2026, 6, 1, 21, 30), "Asia/Kolkata"), "2026-07-02T03:00:00+05:30");
});

test("withDay moves a due to another day at the same wall-clock time, across DST", () => {
  const tz = "America/Toronto";
  assert.equal(withDay("2026-12-01", "2026-12-03", tz), "2026-12-03");
  assert.equal(withDay("2026-12-01T17:00:00-05:00", "2026-12-03", tz), "2026-12-03T17:00:00-05:00");
  // 17:00 in October is EDT; on the day after the clocks change it's EST, still 17:00.
  assert.equal(withDay("2026-10-30T17:00:00-04:00", "2026-11-02", tz), "2026-11-02T17:00:00-05:00");
  assert.equal(withDay("2026-12-01T22:00:00Z", "2026-12-02", tz), "2026-12-02T17:00:00-05:00");
  assert.equal(withDay("someday", "2026-12-02", tz), null);
  assert.equal(withDay("2026-12-01", "Dec 2", tz), null);
});

test("hasTime, addDays and localLabel", () => {
  assert.equal(hasTime("2026-12-01"), false);
  assert.equal(hasTime("2026-12-01T09:00:00-05:00"), true);
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  const at = Date.UTC(2026, 11, 1, 22, 0);
  assert.equal(localLabel(at, "America/Toronto", false), "Tue, Dec 1");
  assert.equal(localLabel(at, "America/Toronto", true), "Tue, Dec 1, 5:00 PM");
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

test("projectChannelName uses Linear's prefix and cuts at a word", () => {
  assert.equal(projectChannelName("p-", "UofT Creators Club", 60), "p-uoft-creators-club");
  assert.equal(projectChannelName("p-", "unduo.me", 60), "p-unduo-me");
  assert.equal(projectChannelName("project-", "Café & Co.", 60), "project-cafe-co");
  assert.equal(projectChannelName("p-", "!!!", 60), "p-project");
  assert.equal(
    projectChannelName("p-", "Creator accounts and payouts for every platform", 25),
    "p-creator-accounts-and",
  );
});

test("projectDay reads a project named after a calendar day, either way it's written", () => {
  assert.equal(projectDay("20261119"), "2026-11-19");
  assert.equal(projectDay("2026-11-19"), "2026-11-19");
  assert.equal(projectDay(" 20261119 "), "2026-11-19");
  assert.equal(projectDay("20261131"), null);
  assert.equal(projectDay("2026-1119"), null);
  assert.equal(projectDay("University"), null);
  assert.equal(projectDay("20261119 debrief"), null);
  assert.equal(projectDay("202611190"), null);
});

test("a day's project channel is project-YYYY-MM-DD", () => {
  assert.equal(projectChannelName("project-", "20261119", 60), "project-2026-11-19");
  assert.equal(projectChannelName("project-", "2026-11-19", 60), "project-2026-11-19");
});

test("localDay is the calendar day in the given time zone", () => {
  // 04:30 UTC on Nov 20 is still Nov 19 in Toronto.
  assert.equal(localDay(Date.UTC(2026, 10, 20, 4, 30), "America/Toronto"), "2026-11-19");
  assert.equal(localDay(Date.UTC(2026, 10, 20, 5, 0), "America/Toronto"), "2026-11-20");
});

test("mentions finds a user's Slack mention, with or without a label", () => {
  assert.equal(mentions("<@U0LEON00001> please look", "U0LEON00001"), true);
  assert.equal(mentions("thanks <@U0LEON00001|leon>", "U0LEON00001"), true);
  assert.equal(mentions("<@U0LEON000012> is someone else", "U0LEON00001"), false);
  assert.equal(mentions("@Leon in plain text", "U0LEON00001"), false);
});

test("linearToSlack keeps a Slack user mention written into Linear, outside code", () => {
  assert.equal(linearToSlack("<@U0LEON00001> can you approve?"), "<@U0LEON00001> can you approve?");
  assert.equal(linearToSlack("\\<@U0LEON00001\\> escaped"), "<@U0LEON00001> escaped");
  assert.equal(linearToSlack("`<@U0LEON00001>` in code"), "`&lt;@U0LEON00001&gt;` in code");
  assert.equal(linearToSlack("a <b> tag"), "a &lt;b&gt; tag");
});
