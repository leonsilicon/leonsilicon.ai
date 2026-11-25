import assert from "node:assert/strict";
import { test } from "node:test";
import { isAutolinearIssue, SlackError } from "@-/ai.leonsilicon.services.slack22linear";
import type {
  Adoption,
  LinearIssue,
  NewIssue,
  SlackParams,
} from "@-/ai.leonsilicon.services.slack22linear";
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
  const activeWhenStarted = new Map<string, string[]>();
  const failures: string[] = [];
  const track = async <T>(name: string, run: () => T): Promise<T> => {
    log.push(name);
    if (failures[0] === name) {
      failures.shift();
      throw new SlackError(name, "ratelimited");
    }
    activeWhenStarted.set(name, [...active]);
    active.add(name);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active.delete(name);
    return run();
  };
  const slack = {
    channels: [] as { id: string; name: string; private: boolean }[],
    posts: [] as { channel: string; ts: string; params: SlackParams }[],
    edits: [] as SlackParams[],
    shares: [] as { ts: string; params: SlackParams }[],
    detached: [] as SlackParams[],
    lookups: [] as SlackParams[],
    sourceFiles: [] as { id: string }[],
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
          if (params.file_ids)
            return {
              ok: true,
              message: {
                files: (JSON.parse(String(params.file_ids)) as string[]).map((id) => ({ id })),
              },
            };
          return { ok: true };
        case "chat.postMessage": {
          const ts = `1794000001.00000${slack.posts.length + 1}`;
          slack.posts.push({ channel: String(params.channel), ts, params });
          return { ok: true, ts };
        }
        case "files.share": {
          const ts = `1794000002.00000${slack.shares.length + 1}`;
          slack.shares.push({ ts, params });
          return { ok: true, file_msg_ts: ts };
        }
        case "chat.removeFile":
          slack.detached.push(params);
          slack.sourceFiles = slack.sourceFiles.filter((file) => file.id !== params.file);
          return { ok: true };
        case "conversations.history":
        case "conversations.replies":
          slack.lookups.push(params);
          return {
            ok: true,
            messages: [
              {
                ts: params.latest,
                ...(params.channel === DM
                  ? { files: slack.sourceFiles }
                  : { text: "existing copy" }),
              },
            ],
          };
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
  return {
    intake,
    log,
    activeWhenStarted,
    failures,
    slack,
    created,
    adopted,
    progress: () => progress,
  };
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

test("a message is copied to its new issue channel before being replaced with the link", async () => {
  const t = setup();
  const result = await t.intake.run(message());
  assert.ok(result.ok);

  assert.deepEqual(t.log, [
    "linear.createIssue",
    "conversations.create",
    "chat.postMessage",
    "adopt",
    "chat.update",
  ]);
  assert.deepEqual(t.activeWhenStarted.get("adopt"), ["chat.postMessage"]);
  assert.ok(!t.activeWhenStarted.get("chat.update")!.includes("chat.postMessage"));
  assert.deepEqual(Object.keys(result.ms).sort(), [
    "adopted",
    "channel",
    "copy",
    "issue",
    "linked",
  ]);

  const made = t.created[0]!;
  assert.ok(isAutolinearIssue(made.id), "slack22linear knows to wait for the hand-over");
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
    private: false,
  });
  const edit = t.slack.edits[0]!;
  assert.equal(edit.channel, DM);
  assert.equal(edit.ts, message().ts);
  assert.equal(edit.text, "<#C1>");
  assert.equal(edit.attachments, "[]");
  assert.deepEqual(JSON.parse(String(edit.blocks)), [
    {
      type: "rich_text",
      elements: [
        {
          type: "rich_text_section",
          elements: [{ type: "channel", channel_id: "C1" }],
        },
      ],
    },
  ]);
  const copy = t.slack.posts[0]!;
  assert.equal(copy.channel, "C1");
  assert.equal(copy.params.text, message().text);
  assert.deepEqual(JSON.parse(String(copy.params.blocks)), message().blocks);
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
  assert.deepEqual(t.activeWhenStarted.get("auth.test"), ["linear.team"]);
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
  assert.ok(!t.log.includes("chat.update"), "the original stays intact until the copy succeeds");
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
  t.slack.sourceFiles = [{ id: "F1" }];
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
  assert.equal(t.slack.edits[0]!.text, `<#${result.channel.id}>`);
  assert.deepEqual(t.slack.lookups[0], {
    channel: DM,
    ts: "1794000000.000004",
    oldest: "1794000000.000005",
    latest: "1794000000.000005",
    inclusive: true,
    limit: 5,
  });
  assert.equal(t.slack.shares[0]!.params.files, "F1");
  assert.equal(t.slack.shares[0]!.params.comment, "sure, ask <@U0SYED00001>");
  assert.deepEqual(t.slack.detached, [{ channel: DM, ts: "1794000000.000005", file: "F1" }]);
});

test("uploaded files and formatting move before the original is reduced to a channel link", async () => {
  const t = setup();
  const msg = message({ files: [{ id: "F1", name: "image.png" }, { id: "F2" }] });
  const result = await t.intake.run(msg);
  assert.ok(result.ok);
  const share = t.slack.shares[0]!;
  assert.equal(result.ts, share.ts);
  assert.equal(share.params.channel, result.channel.id);
  assert.equal(share.params.files, "F1,F2");
  assert.equal(share.params.resharing_aware, true);
  assert.deepEqual(JSON.parse(String(share.params.blocks)), msg.blocks);
  assert.match(String(share.params.client_msg_id), /^de1e6a7e-/);
  assert.equal(t.slack.posts.length, 0);
  assert.equal(t.slack.lookups.length, 0);
  assert.equal(t.slack.edits[0]!.text, `<#${result.channel.id}>`);
  assert.deepEqual(t.slack.detached, [
    { channel: DM, ts: msg.ts, file: "F1" },
    { channel: DM, ts: msg.ts, file: "F2" },
  ]);
  assert.deepEqual(
    t.log.filter((method) => ["files.share", "chat.update", "chat.removeFile"].includes(method)),
    ["files.share", "chat.update", "chat.removeFile", "chat.removeFile"],
  );
});

test("a file-only message keeps its source until shared and resumes a failed detach", async () => {
  const t = setup();
  t.slack.sourceFiles = [{ id: "F1" }];
  const msg = message({ files: [{ id: "F1", name: "image.png" }], text: "", blocks: undefined });
  t.failures.push("files.share", "chat.removeFile");
  await assert.rejects(t.intake.run(msg), /files.share failed/);
  assert.equal(t.slack.edits.length, 0);
  assert.equal(t.slack.detached.length, 0);
  const clientMsgId = t.progress().copyClientMsgId;
  assert.match(clientMsgId!, /^de1e6a7e-/);

  await assert.rejects(t.intake.run(msg), /chat.removeFile failed/);
  assert.equal(t.slack.shares[0]!.params.comment, undefined);
  assert.equal(t.slack.shares[0]!.params.client_msg_id, clientMsgId);
  assert.deepEqual(t.progress().filesToDetach, ["F1"]);

  const result = await t.intake.run(msg);
  assert.ok(result.ok);
  assert.equal(result.ts, t.slack.shares[0]!.ts);
  assert.equal(t.slack.shares.length, 1);
  assert.equal(t.slack.edits.length, 1);
  assert.equal(t.slack.detached.length, 1);
  assert.deepEqual(t.progress().filesToDetach, []);
});

test("a retry can attach an image to a copy saved before file sharing was added", async () => {
  const t = setup();
  t.failures.push("adopt");
  await assert.rejects(t.intake.run(message()), /adopt failed/);
  const copyTs = t.progress().copyTs;
  const result = await t.intake.run(message({ files: [{ id: "F1" }] }));
  assert.ok(result.ok);
  assert.equal(result.ts, copyTs);
  assert.equal(t.slack.posts.length, 1);
  assert.equal(t.slack.shares.length, 0);
  assert.equal(t.slack.edits[1]!.ts, copyTs);
  assert.equal(t.slack.edits[1]!.file_ids, '["F1"]');
  assert.deepEqual(t.slack.detached, [{ channel: DM, ts: message().ts, file: "F1" }]);
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
