import assert from "node:assert/strict";
import { test } from "node:test";
import { isAutolinearIssue, SlackError } from "@-/ai.leonsilicon.services.linear-slack-sync";
import type {
  Adoption,
  LinearIssue,
  NewIssue,
  SlackParams,
} from "@-/ai.leonsilicon.services.linear-slack-sync";
import { loadConfig } from "#config";
import { Intake, type IntakeCache, type IntakeMessage, type Progress } from "#intake";

const LEON = "U0LEON00001";
const HERMES = "U0HERMES001";
const DM = "D0LEONDM01";
const WORKSPACE = "https://leonsilicon.slack.com";

/** Slack and Linear, with every call logged and each answer `delay` ms late (on a fake clock). */
function setup(env: Record<string, string> = {}, cache: IntakeCache = {}) {
  const log: string[] = [];
  const active = new Set<string>();
  /** Calls that were running at the same time as another. */
  const overlapped = new Set<string>();
  const failures: string[] = [];
  const track = async <T>(name: string, run: () => T): Promise<T> => {
    log.push(name);
    if (failures[0] === name) {
      failures.shift();
      throw new SlackError(name, "ratelimited");
    }
    for (const other of active) overlapped.add(other).add(name);
    active.add(name);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active.delete(name);
    return run();
  };
  const slack = {
    channels: [] as { id: string; name: string; private: boolean }[],
    posts: [] as { channel: string; ts: string; params: SlackParams }[],
    edits: [] as SlackParams[],
    refuseEdits: false,
  };
  const session = (method: string, params: SlackParams = {}) =>
    track(method, () => {
      switch (method) {
        case "auth.test":
          return { ok: true, url: `${WORKSPACE}/` };
        case "users.info":
          return { ok: true, user: { profile: { display_name: "Syed" } } };
        case "conversations.create": {
          if (slack.channels.some((c) => c.name === params.name))
            throw new SlackError(method, "name_taken");
          const channel = {
            id: `C${slack.channels.length + 1}`,
            name: String(params.name),
            private: params.is_private === true,
          };
          slack.channels.push(channel);
          return { ok: true, channel: { id: channel.id } };
        }
        case "chat.update":
          if (slack.refuseEdits) throw new SlackError(method, "edit_window_closed");
          slack.edits.push(params);
          return { ok: true };
        case "chat.postMessage": {
          const ts = `1794000001.00000${slack.posts.length + 1}`;
          slack.posts.push({ channel: String(params.channel), ts, params });
          return { ok: true, ts };
        }
        default:
          throw new Error(`fake Slack has no ${method}`);
      }
    });
  const issues = new Map<string, LinearIssue>();
  const created: NewIssue[] = [];
  const linear = {
    issue: async (id: string) => issues.get(id) ?? null,
    team: (key: string) =>
      track("linear.team", () => ({
        id: `team-${key}`,
        states: [
          { id: "state-init", name: "Awaiting Init", type: "unstarted" },
          { id: "state-leon", name: "Awaiting Leon", type: "started" },
        ],
      })),
    createIssue: (input: NewIssue) =>
      track("linear.createIssue", () => {
        if (issues.has(input.id)) throw new Error("Entity already exists");
        created.push(input);
        const number = 400 + created.length;
        const issue: LinearIssue = {
          id: input.id,
          identifier: `LEON-${number}`,
          number,
          title: input.title,
          url: `https://linear.app/leonsilicon/issue/LEON-${number}`,
          description: input.description,
          state: { id: input.stateId, name: "Awaiting Init", type: "unstarted" },
          priority: 0,
          teamKey: "LEON",
          dueDate: null,
        };
        issues.set(issue.id, issue);
        return issue;
      }),
  };
  const adopted: Adoption[] = [];
  let progress: Progress = {};
  const intake = new Intake({
    config: loadConfig({
      SLACK_LEON_USER_ID: LEON,
      SLACK_HERMES_USER_ID: HERMES,
      LINEAR_TEAM_ID: "team-LEON",
      LINEAR_INTAKE_STATE_ID: "state-init",
      SLACK_WORKSPACE_URL: `${WORKSPACE}/`,
      ...env,
    }),
    linear,
    session,
    adopt: (a) => track("adopt", () => void adopted.push(a)),
    progress: {
      get: async () => structuredClone(progress),
      put: async (p) => {
        progress = structuredClone(p);
      },
    },
    cache,
  });
  return { intake, log, overlapped, failures, slack, created, adopted, progress: () => progress };
}

const message = (overrides: Partial<IntakeMessage> = {}): IntakeMessage => ({
  channel: DM,
  ts: "1794000000.000001",
  user: LEON,
  text: `<@${HERMES}> can you check whether *Rogers* billed me twice?\nsecond line`,
  blocks: [{ type: "rich_text", elements: [] }],
  where: "a DM with Hermes",
  ...overrides,
});

test("a message becomes an issue, a channel, a link and a copy, in as few steps as can be", async () => {
  const t = setup();
  const result = await t.intake.run(message());
  assert.ok(result.ok);

  // Only these calls: no lookups, and the last three at once.
  assert.deepEqual(t.log, [
    "linear.createIssue",
    "conversations.create",
    "chat.update",
    "chat.postMessage",
    "adopt",
  ]);
  assert.deepEqual([...t.overlapped].sort(), ["adopt", "chat.postMessage", "chat.update"]);
  assert.deepEqual(Object.keys(result.ms), ["issue", "channel", "linked", "copy", "adopted"]);

  const made = t.created[0]!;
  assert.ok(isAutolinearIssue(made.id), "Linear Sync knows to wait for the hand-over");
  assert.equal(made.teamId, "team-LEON");
  assert.equal(made.stateId, "state-init");
  assert.equal(made.title, "can you check whether Rogers billed me twice?");
  const permalink = `${WORKSPACE}/archives/${DM}/p1794000000000001`;
  assert.equal(
    made.description,
    `**Leon in Slack** ([a DM with Hermes](${permalink})):\n\n` +
      "@Hermes can you check whether **Rogers** billed me twice?\nsecond line",
  );

  const channel = t.slack.channels[0]!;
  assert.deepEqual(channel, {
    id: "C1",
    name: "leon-401-can-you-check-whether-rogers-billed-me-twice",
    private: true,
  });
  const edit = t.slack.edits[0]!;
  assert.equal(edit.channel, DM);
  assert.equal(edit.text, `${message().text}\n→ <#C1>`);
  assert.deepEqual(JSON.parse(String(edit.blocks)).at(-1), {
    type: "rich_text",
    elements: [
      {
        type: "rich_text_section",
        elements: [
          { type: "text", text: "→ " },
          { type: "channel", channel_id: "C1" },
        ],
      },
    ],
  });
  const copy = t.slack.posts[0]!;
  assert.equal(copy.channel, "C1");
  assert.equal(copy.params.text, message().text);
  assert.match(String(copy.params.client_msg_id), /^de1e6a7e-/);
  assert.deepEqual(t.adopted, [
    {
      issueId: made.id,
      identifier: "LEON-401",
      title: made.title,
      stateName: "Awaiting Init",
      channelId: "C1",
      channelName: channel.name,
      sourceChannel: DM,
      sourceTs: "1794000000.000001",
      sourceThreadTs: null,
      lead: `From Leon's message in <${permalink}|a DM with Hermes>.`,
    },
  ]);
  assert.deepEqual(result, {
    ok: true,
    issue: {
      id: made.id,
      identifier: "LEON-401",
      url: "https://linear.app/leonsilicon/issue/LEON-401",
    },
    channel: { id: "C1", name: channel.name },
    ts: copy.ts,
    source: "a DM with Hermes",
    ms: result.ms,
  });

  // Run again (a retry), it does nothing more.
  const calls = t.log.length;
  assert.deepEqual(await t.intake.run(message()), { ...result, ms: {} });
  assert.equal(t.log.length, calls);
});

test("without IDs in config, the team and workspace are looked up once, in parallel, then cached", async () => {
  const cache: IntakeCache = {};
  const env = { LINEAR_TEAM_ID: "", LINEAR_INTAKE_STATE_ID: "", SLACK_WORKSPACE_URL: "" };
  const t = setup(env, cache);
  await t.intake.run(message());
  assert.deepEqual(t.log.slice(0, 3), ["linear.team", "auth.test", "linear.createIssue"]);
  assert.ok(t.overlapped.has("linear.team") && t.overlapped.has("auth.test"));
  assert.equal(t.created[0]!.stateId, "state-init");

  const warm = setup(env, cache);
  await warm.intake.run(message({ ts: "1794000000.000002" }));
  assert.equal(warm.log[0], "linear.createIssue");
});

test("a retry after a failed step carries on: one issue, one channel, one copy", async () => {
  const t = setup();
  t.failures.push("chat.postMessage");
  await assert.rejects(t.intake.run(message()), /ratelimited/);
  assert.equal(t.progress().adopted, true, "the steps that worked are kept");
  const result = await t.intake.run(message());
  assert.ok(result.ok);
  assert.equal(t.created.length, 1);
  assert.equal(t.slack.channels.length, 1);
  assert.equal(t.slack.edits.length, 1);
  assert.equal(t.slack.posts.length, 1);
  assert.equal(t.adopted.length, 1);
});

test("a reply links its thread, others' mentions get names, and a taken channel name gets -2", async () => {
  const t = setup();
  t.slack.channels.push({ id: "C0OLD", name: "leon-401-sure-ask-syed", private: true });
  const result = await t.intake.run(
    message({
      ts: "1794000000.000005",
      threadTs: "1794000000.000004",
      text: "sure, ask <@U0SYED00001>",
      blocks: undefined,
      files: [{ name: "a.png", title: "receipt.png", permalink: "https://files.slack.com/F1" }],
      where: "a thread in #feed-gmail",
    }),
  );
  assert.ok(result.ok);
  assert.equal(result.channel.name, "leon-401-sure-ask-syed-2");
  const permalink = `${WORKSPACE}/archives/${DM}/p1794000000000005?thread_ts=1794000000.000004&cid=${DM}`;
  assert.equal(
    t.created[0]!.description,
    `**Leon in Slack** ([a thread in #feed-gmail](${permalink})):\n\nsure, ask @Syed\n\n` +
      "📎 [receipt.png](https://files.slack.com/F1)",
  );
  assert.equal(t.adopted[0]!.sourceThreadTs, "1794000000.000004");
  assert.equal(t.adopted[0]!.lead, `From Leon's reply in <${permalink}|a thread in #feed-gmail>.`);
  assert.equal(t.slack.edits[0]!.blocks, undefined, "no blocks to keep");
  assert.equal(
    t.slack.posts[0]!.params.text,
    "sure, ask <@U0SYED00001>\n📎 <https://files.slack.com/F1|receipt.png>",
  );
});

test("an edit Slack refuses is logged; the issue, channel and copy still happen", async () => {
  const t = setup();
  t.slack.refuseEdits = true;
  const result = await t.intake.run(message());
  assert.ok(result.ok);
  assert.equal(t.progress().linked, false);
  assert.equal(t.slack.posts.length, 1);
});

test("someone else's message, or one in an issue channel, is left alone", async () => {
  const t = setup();
  assert.deepEqual(await t.intake.run(message({ user: "U0SOMEONE1" })), {
    ok: false,
    skipped: "not_leon",
  });
  for (const where of ["#leon-12-fix-it", "a thread in #leon-12"])
    assert.deepEqual(await t.intake.run(message({ where })), {
      ok: false,
      skipped: "issue_channel",
    });
  assert.deepEqual(t.log, []);
});
