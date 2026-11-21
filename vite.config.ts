import { globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import flatcap from "eslint-plugin-flatcap";

const www = fileURLToPath(new URL("www", import.meta.url));
const ai = "packages/ai/leonsilicon";

// Build each site's HTML entrypoint at its reverse-hostname path in dist/www.
const pages = globSync("**/index.html", { cwd: www, exclude: ["**/node_modules/**"] }).map(
  (page) => `${www}/${page}`,
);

export default defineConfig({
  root: www,
  publicDir: false,
  build: {
    outDir: fileURLToPath(new URL("dist/www", import.meta.url)),
    emptyOutDir: true,
    rolldownOptions: { input: pages },
  },
  lint: {
    ...flatcap.configs.oxlint,
    options: { typeAware: true, typeCheck: true },
    overrides: [
      {
        // node:test registers top-level tests through promises managed by its runner.
        files: ["**/__tests__/**"],
        rules: { "typescript/no-floating-promises": "off" },
      },
      {
        // Byte-identical copy of the Grok relay deployed on the mini (plain .mjs, not a workspace
        // package), kept so the source lives here; see its README.
        files: [`${ai}/configs/grok-relay-hermes/**`],
        rules: { "flatcap/flat-package-files": "off", "flatcap/no-relative-imports": "off" },
      },
    ],
  },
  fmt: {
    ignorePatterns: [
      "patches.gen/**",
      "**/@fixtures/**",
      // What pywrangler puts beside a Python Worker: its packages, its environment and its lock.
      "**/python_modules/**",
      "**/.venv-workers/**",
      "**/pylock.toml",
      // Byte-identical copy of what runs on the mini; reformatting would hide drift.
      `${ai}/configs/grok-relay-hermes/*.mjs`,
    ],
  },
  run: {
    tasks: {
      test: {
        cache: false,
        command: [
          "node --test",
          `${ai}/configs/cloudflare/__tests__/*.test.ts`,
          `${ai}/configs/deploy-targets/__tests__/*.test.ts`,
          `${ai}/configs/env-file/__tests__/*.test.ts`,
          `${ai}/configs/patching/codemods/unsnooze/__tests__/*.test.ts`,
          `${ai}/configs/patching/generator/__tests__/*.test.ts`,
          `${ai}/configs/silicon-dot/agents-vault/__tests__/*.test.ts`,
          `${ai}/configs/todoist-automations/__tests__/*.test.ts`,
          ...[
            "autolinear",
            "beeper-inbox",
            "beeper-watch",
            "dailylinear",
            "gmail-feed",
            "grok-bot-roster",
            "grok-relay",
            "linear-slack-sync",
            "orca-bridge",
            "orca-device",
            "slack-as-leon",
          ].map((service) => `${ai}/services/${service}/__tests__/*.test.ts`),
        ].join(" "),
      },
      typecheck: { command: "tsc --noEmit" },
      // dist/beeper-inbox.tgz for Hermes Cloud: the app plus Pickle built from its pinned revision.
      "build:beeper-inbox": {
        cache: false,
        command: "node apps/beeper-inbox/_build-beeper-inbox.ts",
      },
      // Reapplies the Unsnooze connection-loss fix to the global install (or the path after --).
      "patch:unsnooze": {
        cache: false,
        command: `node ${ai}/configs/patching/generator/_apply-patches.ts unsnooze`,
      },
      "patches:generate": {
        cache: false,
        command: `node ${ai}/configs/patching/generator/_generate-patches.ts`,
      },
      "test:unsnooze-patch": {
        cache: false,
        command: `node --test ${ai}/configs/patching/codemods/unsnooze/__tests__/connection-loss.integration.mjs`,
      },
      "deploy:autolinear": {
        cache: false,
        // Like deploy:slack-as-leon: varlock-wrangler uploads the #autolinear items.
        command:
          "tsc --noEmit && vp build && cd apps/autolinear && varlock-wrangler deploy -c wrangler.jsonc",
      },
      "deploy:cronometer": {
        cache: false,
        // A Python Worker: pywrangler puts its Python packages in python_modules (it needs uv 0.13.4
        // or newer), then varlock-wrangler deploys and uploads the #cronometer items, as for the others.
        command:
          "vp build && cd apps/cronometer && uv run pywrangler sync && varlock-wrangler deploy -c wrangler.jsonc",
      },
      "deploy:dailylinear": {
        cache: false,
        // Like deploy:slack-as-leon: varlock-wrangler uploads the #dailylinear items.
        command:
          "tsc --noEmit && vp build && cd apps/dailylinear && varlock-wrangler deploy -c wrangler.jsonc",
      },
      "deploy:gmail-feed": {
        cache: false,
        // Like deploy:slack-as-leon: varlock-wrangler uploads the #gmail-feed items.
        command:
          "tsc --noEmit && vp build && cd apps/gmail-feed && varlock-wrangler deploy -c wrangler.jsonc",
      },
      "deploy:grok-bot-roster": {
        cache: false,
        // Like deploy:slack-as-leon: varlock-wrangler uploads the #grok-bot-roster items.
        command:
          "tsc --noEmit && vp build && cd apps/grok-bot-roster && varlock-wrangler deploy -c wrangler.jsonc",
      },
      "deploy:linear-slack-sync": {
        cache: false,
        // Like deploy:slack-as-leon: varlock-wrangler uploads the #linear-slack-sync items.
        command:
          "tsc --noEmit && vp build && cd apps/linear-slack-sync && varlock-wrangler deploy -c wrangler.jsonc",
      },
      "deploy:slack-as-leon": {
        cache: false,
        // varlock-wrangler uploads the #slack-as-leon items of .env.schema (values from Infisical) as
        // the Worker's vars and secrets, replacing any others. It loads env from its working
        // directory, whose package.json sets that filter.
        command:
          "tsc --noEmit && vp build && cd apps/slack-as-leon && varlock-wrangler deploy -c wrangler.jsonc",
      },
    },
  },
});
