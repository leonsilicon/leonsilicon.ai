import { globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import flatcap from "eslint-plugin-flatcap";

const www = fileURLToPath(new URL("www", import.meta.url));
const ai = "packages/ai/leonsilicon";

// Build each site's HTML entrypoint at its reverse-hostname path in dist/www.
const pages = globSync("**/*.html", {
  cwd: www,
  exclude: ["**/node_modules/**"],
}).map((page) => `${www}/${page}`);

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
    ignorePatterns: [
      "apps/hermes-plugin-*/policy.cjs",
      "apps/hermes-plugin-*/*/policy.cjs",
      "**/bridge.cjs",
    ],
    options: { typeAware: true, typeCheck: true },
    overrides: [
      {
        // node:test registers top-level tests through promises managed by its runner.
        files: ["**/__tests__/**"],
        rules: { "typescript/no-floating-promises": "off" },
      },
    ],
  },
  fmt: {
    ignorePatterns: [
      "patches.gen/**",
      "apps/hermes-plugin-*/policy.cjs",
      "apps/hermes-plugin-*/*/policy.cjs",
      "**/bridge.cjs",
      "**/@fixtures/**",
      // beeperd's tool contracts and test data were recorded from the TypeScript it replaced, and
      // its tests compare against them byte for byte.
      "apps/beeperd/**/testdata/**",
      "apps/beeperd/**/tools.json",
      // What pywrangler puts beside a Python Worker: its packages, its environment and its lock.
      "**/python_modules/**",
      "**/.venv-workers/**",
      "**/pylock.toml",
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
          `${ai}/configs/hermes-mirrors/__tests__/*.test.ts`,
          `${ai}/configs/patching/codemods/unsnooze/__tests__/*.test.ts`,
          `${ai}/configs/patching/generator/__tests__/*.test.ts`,
          `${ai}/configs/silicon-dot/agents-vault/__tests__/*.test.ts`,
          `${ai}/configs/silicon-dot/hermes-thread/__tests__/*.test.ts`,
          `${ai}/configs/todoist-automations/__tests__/*.test.ts`,
          "apps/hermes-plugin-leon/__tests__/*.test.mjs",
          ...[
            "autolinear",
            "autotrigger",
            "dailylinear",
            "gmail2slack",
            "grok-bot-roster",
            "orca-bridge",
            "orcahermes-device",
            "slack-as-leon",
            "slack22linear",
          ].map((service) => `${ai}/services/${service}/__tests__/*.test.ts`),
        ].join(" "),
      },
      typecheck: { command: "tsc --noEmit" },
      "build:hermes-plugins": {
        cache: false,
        command: `node ${ai}/configs/hermes-mirrors/_build-hermes-plugins.ts`,
      },
      // beeperd is Go: its tests need a C compiler (SQLite), and goolm keeps Olm in pure Go.
      "test:beeperd": {
        cache: false,
        command: "go -C apps/beeperd test -tags=goolm ./...",
      },
      "vet:beeperd": {
        cache: false,
        command: "go -C apps/beeperd vet -tags=goolm ./...",
      },
      // dist/beeperd.tgz for Hermes Cloud: one static linux/amd64 binary.
      "build:beeperd": {
        cache: false,
        command: "node apps/beeperd/_build-beeperd.ts",
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
      "deploy:gmail2slack": {
        cache: false,
        // Like deploy:slack-as-leon: varlock-wrangler uploads the #gmail2slack items.
        command:
          "tsc --noEmit && vp build && cd apps/gmail2slack && varlock-wrangler deploy -c wrangler.jsonc",
      },
      "deploy:grok-bot-roster": {
        cache: false,
        // Like deploy:slack-as-leon: varlock-wrangler uploads the #grok-bot-roster items.
        command:
          "tsc --noEmit && vp build && cd apps/grok-bot-roster && varlock-wrangler deploy -c wrangler.jsonc",
      },
      "deploy:landing": {
        cache: false,
        command: [
          "vp build www/ai/leonsilicon --outDir ../../../dist/landing --emptyOutDir",
          "cp www/ai/leonsilicon/@assets/space-grotesk-OFL.txt dist/landing/assets/",
          "cd apps/landing",
          "wrangler deploy -c wrangler.jsonc",
        ].join(" && "),
      },
      "deploy:orcahermes-reference": {
        cache: false,
        command: "vp build && wrangler deploy -c apps/orcahermes-reference/wrangler.jsonc",
      },
      "deploy:slack-as-leon": {
        cache: false,
        // varlock-wrangler uploads the #slack-as-leon items of .env.schema (values from Infisical) as
        // the Worker's vars and secrets, replacing any others. It loads env from its working
        // directory, whose package.json sets that filter.
        command:
          "tsc --noEmit && vp build && cd apps/slack-as-leon && varlock-wrangler deploy -c wrangler.jsonc",
      },
      "deploy:slack22linear": {
        cache: false,
        // Like deploy:slack-as-leon: varlock-wrangler uploads the #slack22linear items.
        command:
          "tsc --noEmit && vp build && cd apps/slack22linear && varlock-wrangler deploy -c wrangler.jsonc",
      },
    },
  },
});
