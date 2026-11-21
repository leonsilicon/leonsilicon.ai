# @-/com.leonsilicon.ai.configs.deploy-targets

Decides which Cloudflare Workers a push needs to redeploy, for the [Deploy workflow](../../../../../../.github/workflows/deploy.yml). A Worker is an app with a `wrangler.jsonc` and a `deploy:<app>` task in the root `vite.config.ts`: `autolinear`, `cronometer`, `gmail-feed`, `linear-slack-sync` and `slack-as-leon` (served as slack-puppet).

A changed file affects a Worker when it is in the Worker's app or in any workspace package the app reaches through `workspace:*` dependencies. It also affects every Worker when it is a shared build input: `www/`, which is built into every Worker's assets, the lockfile, root config, `.env.schema` and the deploy workflow. Docs (`*.md`) and `__tests__/` never trigger a deploy. The graph is read from the `package.json` files each time, so a new dependency is picked up without editing anything here.

```sh
node packages/com/leonsilicon/ai/configs/deploy-targets/_deploy-targets.ts --base <sha> [--head <sha>] [--github-output]
node packages/com/leonsilicon/ai/configs/deploy-targets/_deploy-targets.ts --only gmail-feed,slack-as-leon   # or --all
```

It prints a JSON array of app names. When `--base` is missing or isn't in the history (first deploy, force-push), every Worker is deployed. `--github-output` also writes `workers=<json>` to `$GITHUB_OUTPUT`.

Public API: `readWorkspace(root)`, `affectedWorkers(workspace, changedFiles)`, `ROOT_INPUTS`.
