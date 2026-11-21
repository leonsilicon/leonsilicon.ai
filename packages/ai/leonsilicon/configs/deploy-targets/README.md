# @-/ai.leonsilicon.configs.deploy-targets

Decides which Cloudflare Workers a push needs to redeploy, for the [Deploy workflow](../../../../../.github/workflows/deploy.yml). A Worker is an app with a `wrangler.jsonc` and a `deploy:<app>` task in the root `vite.config.ts`: `autolinear`, `cronometer`, `gmail-feed`, `linear-slack-sync` and `slack-as-leon` (served as slack-puppet).

A changed file affects a Worker when it is in the Worker's app or in a library the app reaches through `workspace:*` dependencies. Every Worker builds the sites in `www/` into its assets, so the site files and their library dependencies affect all Workers. The lockfile, root config, `.env.schema` and the deploy workflow are also shared inputs. The graph is read from the `package.json` files each time, so new dependencies are picked up automatically.

```sh
node packages/ai/leonsilicon/configs/deploy-targets/_deploy-targets.ts --base <sha> [--head <sha>] [--github-output]
node packages/ai/leonsilicon/configs/deploy-targets/_deploy-targets.ts --only gmail-feed,slack-as-leon   # or --all
```

It prints a JSON array of app names. When `--base` is missing or isn't in the history (first deploy, force-push), every Worker is deployed. `--github-output` also writes `workers=<json>` to `$GITHUB_OUTPUT`.

Public API: `readWorkspace(root)`, `affectedWorkers(workspace, changedFiles)`, `ROOT_INPUTS`.
