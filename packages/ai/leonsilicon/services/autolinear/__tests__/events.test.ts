import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "#config";
import { messageFromEvent, type SlackMessageEvent } from "#events";

const LEON = "U0LEON00001";
const HERMES = "U0HERMES001";
const DM = "D0HERMESDM1";
const config = loadConfig({
  SLACK_LEON_USER_ID: LEON,
  SLACK_HERMES_USER_ID: HERMES,
  AUTOLINEAR_SKIP_CHANNELS: "C0SKIPPED01",
});
const names: Record<string, string> = {
  C0GENERAL01: "general",
  C0ISSUE0001: "leon-12-fix-the-printer",
  C0SKIPPED01: "quiet",
};
const asked: string[] = [];
const lookups = {
  hermesDmId: async () => {
    asked.push("dm");
    return DM;
  },
  channelName: async (id: string) => {
    asked.push(id);
    return names[id] ?? null;
  },
};

const event = (overrides: SlackMessageEvent = {}): SlackMessageEvent => ({
  type: "message",
  channel: DM,
  channel_type: "im",
  user: LEON,
  text: `<@${HERMES}> can you check rogers`,
  ts: "1794000000.000001",
  client_msg_id: "6a1c7d1e-0000-4000-8000-000000000001",
  ...overrides,
});

test("Leon's message in his DM with Hermes, or in a public channel, starts at once", async () => {
  assert.deepEqual(await messageFromEvent(event({ blocks: [] }), config, lookups), {
    channel: DM,
    ts: "1794000000.000001",
    threadTs: null,
    user: LEON,
    text: `<@${HERMES}> can you check rogers`,
    where: "a DM with Hermes",
    blocks: [],
  });
  const reply = await messageFromEvent(
    event({
      channel: "C0GENERAL01",
      channel_type: "channel",
      thread_ts: "1793999999.000001",
      subtype: "file_share",
      files: [
        {
          id: "F1",
          name: "a.png",
          title: "receipt.png",
          permalink: "https://files/F1",
          url_private: "x",
        },
      ],
    }),
    config,
    lookups,
  );
  assert.equal(reply?.where, "a thread in #general");
  assert.equal(reply?.threadTs, "1793999999.000001");
  assert.deepEqual(reply?.files, [
    { id: "F1", name: "a.png", title: "receipt.png", permalink: "https://files/F1" },
  ]);
});

test("anything Hermes might not answer waits for Hermes's own call, mostly without a lookup", async () => {
  asked.length = 0;
  const cheap: SlackMessageEvent[] = [
    event({ user: HERMES }), // someone else
    event({ bot_id: "B1" }), // a bot
    event({ client_msg_id: "de1e6a7e-1111-4000-8000-000000000001" }), // an agent's post as Leon
    event({ subtype: "message_changed" }), // an edit
    event({ subtype: "channel_join" }),
    event({ text: "/new" }),
    event({ text: "!stop" }),
    event({ text: "ask <@U0SOMEONE1> about it" }), // addressed to someone else
    event({ channel_type: "mpim" }),
    event({ channel_type: "group", channel: "G0PRIVATE01" }), // private: Hermes may not be in it
    event({ channel: "C0SKIPPED01", channel_type: "channel" }),
    event({ ts: "not-a-ts" }),
    { type: "reaction_added" },
  ];
  for (const e of cheap)
    assert.equal(await messageFromEvent(e, config, lookups), null, JSON.stringify(e));
  assert.deepEqual(asked, [], "decided without asking Slack");

  // These need a lookup to rule out: another DM, an issue channel, a channel Slack won't name.
  assert.equal(await messageFromEvent(event({ channel: "D0OTHERDM01" }), config, lookups), null);
  for (const channel of ["C0ISSUE0001", "C0UNKNOWN01"])
    assert.equal(
      await messageFromEvent(event({ channel, channel_type: "channel" }), config, lookups),
      null,
    );
});
