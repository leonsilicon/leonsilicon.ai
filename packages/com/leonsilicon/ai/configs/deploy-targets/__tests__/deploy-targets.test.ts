import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { affectedWorkers, readWorkspace } from "#deploy-targets";

const root = fileURLToPath(new URL("../../../../../../../", import.meta.url));
const workspace = readWorkspace(root);

test("the Workers are the apps with a wrangler.jsonc, each with a deploy task", () => {
  const apps = workspace.workers.map((worker) => worker.app);
  assert.deepEqual(apps, [
    "ai-edge",
    "autolinear",
    "cronometer",
    "gmail-feed",
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
  assert.deepEqual(affected("apps/ai-edge/worker.ts"), ["ai-edge"]);
  // A Python Worker: its entry, the upstream source it carries and its Python lockfile.
  assert.deepEqual(affected("apps/cronometer/src/entry.py"), ["cronometer"]);
  assert.deepEqual(affected("apps/cronometer/src/cronometer_mcp/client.py"), ["cronometer"]);
  assert.deepEqual(affected("apps/cronometer/uv.lock"), ["cronometer"]);
  assert.deepEqual(affected("packages/com/leonsilicon/ai/services/autolinear/intake.ts"), [
    "autolinear",
  ]);
  // autolinear builds on linear-slack-sync's Linear client and helpers, so both go.
  assert.deepEqual(affected("packages/com/leonsilicon/ai/services/linear-slack-sync/sync.ts"), [
    "autolinear",
    "linear-slack-sync",
  ]);
  // Both import slack-as-leon's session client.
  assert.deepEqual(affected("packages/com/leonsilicon/ai/services/slack-as-leon/slack.ts"), [
    "autolinear",
    "linear-slack-sync",
    "slack-as-leon",
  ]);
  // Shared inputs reach every Worker: the pages, the lockfile, the env schema.
  assert.deepEqual(affected("www/ai/leonsilicon/orca/index.html"), [
    "ai-edge",
    "autolinear",
    "cronometer",
    "gmail-feed",
    "linear-slack-sync",
    "slack-as-leon",
  ]);
  assert.deepEqual(affected("bun.lock"), [
    "ai-edge",
    "autolinear",
    "cronometer",
    "gmail-feed",
    "linear-slack-sync",
    "slack-as-leon",
  ]);
  assert.deepEqual(affected("packages/com/leonsilicon/www/page.ts"), [
    "ai-edge",
    "autolinear",
    "cronometer",
    "gmail-feed",
    "linear-slack-sync",
    "slack-as-leon",
  ]);
  // The Gmail feed uses Beeper Watch's screener, so a change there redeploys it.
  assert.deepEqual(affected("packages/com/leonsilicon/ai/services/beeper-watch/screen.ts"), [
    "gmail-feed",
  ]);
  // Things that don't run on Cloudflare: the mini, Hermes, docs and tests.
  assert.deepEqual(affected("apps/beeper-watch/main.ts"), []);
  assert.deepEqual(affected("packages/com/leonsilicon/ai/services/beeper-inbox/inbox.ts"), []);
  assert.deepEqual(
    affected("packages/com/leonsilicon/hermes/plugins/slack-as-leon-guard/__init__.py"),
    [],
  );
  assert.deepEqual(affected("README.md", "apps/slack-as-leon/README.md"), []);
  assert.deepEqual(
    affected("packages/com/leonsilicon/ai/services/slack-as-leon/__tests__/service.test.ts"),
    [],
  );
});
