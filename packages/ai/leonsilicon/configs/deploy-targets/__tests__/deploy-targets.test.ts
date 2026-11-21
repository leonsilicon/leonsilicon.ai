import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { affectedWorkers, readWorkspace } from "#deploy-targets";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const workspace = readWorkspace(root);

test("the Workers are the apps with a wrangler.jsonc, each with a deploy task", () => {
  const apps = workspace.workers.map((worker) => worker.app);
  assert.deepEqual(apps, [
    "autolinear",
    "cronometer",
    "dailylinear",
    "gmail-feed",
    "grok-bot-roster",
    "linear-slack-sync",
    "slack-as-leon",
  ]);
  const config = readFileSync(`${root}vite.config.ts`, "utf8");
  for (const app of apps)
    assert.ok(config.includes(`"deploy:${app}"`), `vite.config.ts has deploy:${app}`);
});

test("a change deploys exactly the Workers whose build it reaches", () => {
  const affected = (...files: string[]) => affectedWorkers(workspace, files);
  // Its own app and service.
  assert.deepEqual(affected("apps/gmail-feed/worker.ts"), ["gmail-feed"]);
  assert.deepEqual(affected("packages/ai/leonsilicon/services/grok-bot-roster/roster.ts"), [
    "grok-bot-roster",
  ]);
  // A Python Worker: its entry, the upstream source it carries and its Python lockfile.
  assert.deepEqual(affected("apps/cronometer/src/entry.py"), ["cronometer"]);
  assert.deepEqual(affected("apps/cronometer/src/cronometer_mcp/client.py"), ["cronometer"]);
  assert.deepEqual(affected("apps/cronometer/uv.lock"), ["cronometer"]);
  assert.deepEqual(affected("packages/ai/leonsilicon/services/autolinear/intake.ts"), [
    "autolinear",
  ]);
  assert.deepEqual(affected("packages/ai/leonsilicon/services/dailylinear/daily.ts"), [
    "dailylinear",
  ]);
  // autolinear and dailylinear build on linear-slack-sync's Linear client and helpers, so all go.
  assert.deepEqual(affected("packages/ai/leonsilicon/services/linear-slack-sync/sync.ts"), [
    "autolinear",
    "dailylinear",
    "linear-slack-sync",
  ]);
  // They all import slack-as-leon's session client.
  assert.deepEqual(affected("packages/ai/leonsilicon/services/slack-as-leon/slack.ts"), [
    "autolinear",
    "dailylinear",
    "linear-slack-sync",
    "slack-as-leon",
  ]);
  // Shared inputs reach every Worker: the pages, the lockfile, the env schema.
  assert.deepEqual(affected("www/ai/leonsilicon/cronometer/index.html"), [
    "autolinear",
    "cronometer",
    "dailylinear",
    "gmail-feed",
    "grok-bot-roster",
    "linear-slack-sync",
    "slack-as-leon",
  ]);
  assert.deepEqual(affected("bun.lock"), [
    "autolinear",
    "cronometer",
    "dailylinear",
    "gmail-feed",
    "grok-bot-roster",
    "linear-slack-sync",
    "slack-as-leon",
  ]);
  assert.deepEqual(affected("packages/ai/leonsilicon/configs/cloudflare/page.ts"), [
    "autolinear",
    "cronometer",
    "dailylinear",
    "gmail-feed",
    "grok-bot-roster",
    "linear-slack-sync",
    "slack-as-leon",
  ]);
  // The Gmail feed uses Beeper Watch's screener, so a change there redeploys it.
  assert.deepEqual(affected("packages/ai/leonsilicon/services/beeper-watch/screen.ts"), [
    "gmail-feed",
  ]);
  // Things that don't run on Cloudflare: the mini, Hermes, docs and tests.
  assert.deepEqual(affected("apps/beeper-watch/main.ts"), []);
  assert.deepEqual(affected("packages/ai/leonsilicon/services/beeper-inbox/inbox.ts"), []);
  assert.deepEqual(
    affected("packages/com/leonsilicon/hermes/plugins/slack-as-leon-guard/__init__.py"),
    [],
  );
  assert.deepEqual(affected("README.md", "apps/slack-as-leon/README.md"), []);
  assert.deepEqual(
    affected("packages/ai/leonsilicon/services/slack-as-leon/__tests__/service.test.ts"),
    [],
  );
});
