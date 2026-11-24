# Development

This workspace follows the [Flatcap convention](https://github.com/leonsilicon/flatcap), with ImproveLabs/Haniverse's package layout and Vite+ for every task.

## Workspace layout

| Location                                         | Purpose                                                                                                                                                                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `www/<hostname, labels reversed>/`               | Website application packages, each entered through its `index.html`                                                                                                                      |
| `apps/<name>/`                                   | Deployable entrypoints (Workers and what runs on Hermes Cloud), deploy commands and `@assets/`                                                                                           |
| `packages/ai/leonsilicon/configs/cloudflare/`    | Serves the built pages from Workers, plus the script and styles the pages share                                                                                                          |
| `packages/ai/leonsilicon/services/<name>/`       | The services behind `*.leonsilicon.ai` and on Hermes Cloud                                                                                                                               |
| `packages/ai/leonsilicon/configs/<name>/`        | Cronometer as it ran on the Mac mini until 2026-11-21 (kept for reference), the env-file renderer, Unsnooze patching, Silicon Dot's agents-vault, and the Todoist Automations' manifests |
| `packages/com/leonsilicon/hermes/skills/<name>/` | Agent Skills folders installable with the Hermes skills CLI                                                                                                                              |
| `apps/hermes-plugin-<name>/`                     | Hermes plugins, installed to `$HERMES_HOME/plugins/<name>/` on Hermes Cloud                                                                                                              |
| `packages/com/npmjs/`                            | Wrappers for upstream runtime dependencies                                                                                                                                               |
| `patches.gen/`                                   | Committed versioned diffs generated from codemods                                                                                                                                        |

Worker and CLI applications use `@-apps/<folder>`. Sites use `@-apps/<reverse hostname>`, such as `@-apps/ai.leonsilicon.cronometer`. Native Hermes plugins keep their `@-/com.leonsilicon.hermes.plugins.<name>` package names where present. Importable package names mirror their path beneath `packages/`, joined with dots. For example, `packages/ai/leonsilicon/configs/cloudflare` is `@-/ai.leonsilicon.configs.cloudflare`. Upstream npm packages are wrapped in `packages/com/npmjs/<name>`.

## Sites

Each site is a private workspace application with an empty `exports` map. Its `index.html` is a Vite entrypoint. The service pages import `@-/ai.leonsilicon.configs.cloudflare/client` for the shared scripts and styles. `vp build` writes `dist/www`, keeping the reverse-hostname paths and putting shared files in `dist/www/assets/`.

A service Worker serves its hostname's pages by uploading `dist/www` as its assets and calling `serveSite` from [`@-/ai.leonsilicon.configs.cloudflare`](packages/ai/leonsilicon/configs/cloudflare/README.md) before its own handler. Browsers (GET with `Accept: text/html`) get the page; every other request, MCP included, goes to the handler.

The apex site at `www/ai/leonsilicon/index.html` deploys as an assets-only Worker. Its deploy task builds the apex page and its assets into `dist/landing`.

To add a site, create `www/<reversed host>/index.html` and its `package.json`. If the site serves a new Custom Domain on a Worker, add the route to that Worker's `wrangler.jsonc`. Tests check that every Custom Domain has a page and that the site packages have no exports or dependents.

`vp dev` serves the pages at `http://localhost:5173/<reversed host>/`. A page's own requests to its service, such as the status check against `/healthz`, only work when the Worker serves it.

## Package conventions

- Read the owning package's README before editing it, and update its API documentation when behavior changes.
- Keep implementation files beside `package.json`. Use `@assets/` for owned data and `__tests__/` for tests. A normal child directory is another package.
- Export named public APIs through `+.ts`, `+server.ts` or `+<subpath>.ts`. Those entrypoints contain only re-exports through local `#` imports.
- Define local `#` aliases in `package.json#imports`; import other packages by their public workspace name. Use `workspace:*` for workspace dependencies and the root catalog for external dependencies.
- Register executable `_command` files in `package.json#bin`, include a shebang, and make them executable.
- Keep root task definitions in `vite.config.ts`. Flatcap's published Oxlint preset validates layout, manifests, imports and package boundaries through `vp check`.

## Commands

Use Node 24+ for runtime and tests, Bun 1.4.4 for the lockfile, and Vite+ 1.5.0 for development tasks.

```sh
vp install
vpr -w test
vpr -w typecheck
vp check
vp build
```

Tests need no credentials. Runtime dependencies belong to the consuming package, so a production install (`bun install --production`) doesn't need root development tooling.

## Secrets and config

This repository is public, so nothing private is committed: not secrets, and not identifiers either, such as Slack user and channel IDs, tailnet hosts and IPs, usernames or private paths. They live in Infisical, and [varlock](https://varlock.dev) loads them through the root [`.env.schema`](.env.schema). Cloudflare resource IDs (KV namespaces) do stay in the Wrangler configs: they grant nothing without the account's credentials.

- **Infisical.** The project whose ID is in `.env.schema`, environment `prod` (override with `INFISICAL_ENVIRONMENT`), one folder per app (`/slack-as-leon`, `/linear-slack-sync`, `/autolinear`, `/dailylinear`, `/gmail-feed`, `/orca-bridge`, `/hermes`, `/agents-vault`, `/todoist-automations`, `/cronometer`, `/grok-bot-roster`) and `/shared` for values several apps use, such as Leon's Slack session. The schema says which keys each folder needs.
- **Access.** A Machine Identity (Universal Auth) in the project: `leonsilicon.com-repo` (named before the move to leonsilicon.ai), role Member, so it can write values as well as read them. Its `INFISICAL_CLIENT_ID` and `INFISICAL_CLIENT_SECRET` go in `.env` at the root (gitignored); add a client secret on the identity's Universal Auth page for another machine. `vpx varlock load --filter '#gmail2slack'` checks one app's values, with secrets redacted.
- **Tags.** Every schema item is tagged with the app that uses it, and an app loads only its own tag. A filtered load resolves nothing else, so one app's deploy never fetches, or uploads, another's secrets.
- **Workers.** `vpr -w deploy:slack-as-leon`, `vpr -w deploy:slack22linear`, `vpr -w deploy:autolinear`, `vpr -w deploy:dailylinear`, `vpr -w deploy:gmail2slack`, `vpr -w deploy:cronometer` and `vpr -w deploy:grok-bot-roster` run `varlock-wrangler deploy` in the app's directory, whose `package.json` sets `varlock.filter`. Sensitive values become Worker secrets and the rest vars, replacing everything the Worker had, so change values in Infisical rather than with `wrangler secret put`. It also uploads `__VARLOCK_ENV`, the same values as one secret, which the Worker doesn't read.
- **Env files.** [`_env-file`](packages/ai/leonsilicon/configs/env-file/README.md) renders an app's items as a `KEY='value'` file. The retired Mac mini Orca bridge read it from `~/.config/orca-bridge/env`, written over SSH by its `--start` deploy script.
- **Hermes Cloud and agents-vault.** The `#hermes` items are set in Hermes's own env (its dashboard's Keys page) by hand, and the agents-vault installer takes `#agents-vault` through `vpx varlock run --filter '#agents-vault' --`.
- **Adding a value.** Add the item to `.env.schema` with its app's tag: a literal for anything public, `infisical(leonsilicon, "<KEY>", "/<app>")` and `@sensitive` for anything private. Then add the value to Infisical.

CI deploys the Cloudflare Workers (see Deploying). Its credentials are in the GitHub environment `production`, which only `main` can use: `CLOUDFLARE_API_TOKEN`, `INFISICAL_CLIENT_ID` and `INFISICAL_CLIENT_SECRET` as secrets, and `CLOUDFLARE_ACCOUNT_ID` as a variable. Pull requests and the checks get none of them.

## Deploying

**The Workers deploy themselves.** A push to `main` runs CI's checks and then [Deploy](.github/workflows/deploy.yml), which deploys every Worker the push changed since the last successful run. The changed set is worked out by [deploy-targets](packages/ai/leonsilicon/configs/deploy-targets/README.md) from the workspace dependency graph: a Worker's app, every package it reaches, and the shared inputs (`www/`, the lockfile, root config, `.env.schema`). Docs and tests don't trigger it. A failed deploy is retried by the next push. The same workflow publishes the [Todoist Automations](packages/ai/leonsilicon/configs/todoist-automations/README.md) on every run, since the repo is their source of truth.

**Ship by pushing.** A finished, tested change to anything the workflow deploys is committed and pushed to `main`; that is the deploy (Leon's rule, 2026-11-23). Don't deploy it by hand: production then drifts from `main`, and the next push deploys `main` over it. The commands below, and Actions → Deploy with `all` or a list of Workers, are for recovering when a push can't deploy. Everything else in the table is still deployed by hand, and its changes are committed and pushed too, so `main` matches what runs.

| What                          | Command                                                                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `leonsilicon.ai` landing page | Automatic on push to `main`; by hand `vpr -w deploy:landing`                                                                                    |
| `slack-as-leon` Worker        | Automatic on push to `main`; by hand `vpr -w deploy:slack-as-leon`                                                                              |
| `slack22linear` Worker        | Automatic on push to `main`; by hand `vpr -w deploy:slack22linear`                                                                              |
| `autolinear` Worker           | Automatic on push to `main`; by hand `vpr -w deploy:autolinear` (after `slack22linear` when `/adopt` changes)                                   |
| `dailylinear` Worker          | Automatic on push to `main`; by hand `vpr -w deploy:dailylinear` (with `slack22linear` when day projects change)                                |
| `gmail2slack` Worker          | Automatic on push to `main`; by hand `vpr -w deploy:gmail2slack`                                                                                |
| `cronometer` Worker (Python)  | Automatic on push to `main`; by hand `vpr -w deploy:cronometer`, which needs uv 0.13.4 or newer                                                 |
| `grok-bot-roster` Worker      | Automatic on push to `main`; by hand `vpr -w deploy:grok-bot-roster`. Its sign-in lives in KV; see [its README](apps/grok-bot-roster/README.md) |
| Hermes skills                 | Install a skill from its repository path. See [Hermes skills](#hermes-skills).                                                                  |
| Hermes plugins                | Install from `leonsiliconAI/hermes-plugin-<name>`. See [Hermes plugin mirrors](#hermes-plugin-mirrors).                                         |
| Beeper inbox (Hermes Cloud)   | `vpr -w build:beeper-inbox`, then upload and install; see [its README](apps/beeper-inbox/README.md#deploy)                                      |
| Beeper inbox extensions       | Part of the Beeper inbox release above                                                                                                          |
| Todoist Automations           | Automatic on every Deploy run; by hand `vpx _todoist-automations push --yes`                                                                    |

The service Worker tasks build `www/` before deploying and need Infisical access for their configuration. The landing page deploy needs Cloudflare credentials. The retired Mac mini Orca bridge keeps its deploy script for reference.

### Hermes skills

Put each Hermes skill under `packages/com/leonsilicon/hermes/skills/<name>/`. The directory name matches the `name` field in its `SKILL.md`. Use the standard `name` and `description` frontmatter and add supporting files when the skill needs them. [Agent Skills specification](https://agentskills.io/specification)

Install an individual skill from its GitHub directory into the intended Hermes profile. Hermes runs its normal skill scan and tracks its source. Use `hermes skills list --source hub` to confirm the installation. [Hermes skills documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/)

```sh
hermes skills install leonsilicon/leonsilicon.ai/packages/com/leonsilicon/hermes/skills/orcahermes
```

### Hermes plugin mirrors

Each `apps/hermes-plugin-<name>/` directory maps to the root of `leonsiliconAI/hermes-plugin-<name>`. Hermes takes its installed name from `plugin.yaml` and installs it under `$HERMES_HOME/plugins/<name>/`. The [mirror workflow](.github/workflows/sync-hermes-plugins.yml) runs after successful CI on `main`. It links each mirror commit to its source and advances the mirror by fast-forward when the plugin files change, so Hermes can pull an update into an existing checkout.

Each plugin is a Vite+ project. Run `vp -C apps/hermes-plugin-<name> pack` to rebuild a bundle, or run `vpr -w build:hermes-plugins` to rebuild all bundles and refresh their shared PythonMonkey loader. Commit the generated `policy.cjs` and `_pythonmonkey.py` alongside the source so the mirrors include everything Hermes needs at runtime.

Hermes reads the exact PythonMonkey version from each plugin's `pyproject.toml`. The install commands use `--yes-deps` to approve dependency installation. Use a managed Hermes installation with `node` and `npm` available to its package manager for PythonMonkey's dependency installation. If Hermes offers to install the plugin's Node dependencies, skip that prompt. The Vite+ dependencies are for development. Existing installs need an interactive `hermes plugins update <name>` the first time they acquire PythonMonkey. Restart the gateway to load the new bundle and environment.

Install from the mirror using the command in the plugin's README. GitHub redirects former mirror URLs so existing Git checkouts can fetch from their recorded sources. When replacing a manually installed copy, back up its directory outside `$HERMES_HOME/plugins`, compare its files with the mirror, and reinstall from Git with `--force`. Use `--enable` or `--no-enable` to keep its current enabled state. Restart the gateway after replacing the Slack adapter plugins. Run `hermes plugins check-updates` to verify the installs and `hermes plugins auto-update on` to opt the profile into automatic updates.

The workflow uses a fine-grained GitHub token from the `HERMES_MIRROR_TOKEN` Actions secret in this repository. Scope it to `leonsiliconAI` and the plugin mirrors with Contents read and write. Create a corresponding mirror repository and add it to the token's scope when adding a plugin.

Hermes 0.23.2 through 0.23.4 reports Git subdirectory installs as `provenance drift` because those installs omit `.git`. Installing from a mirror's repository root makes it eligible for automatic updates. [Hermes updater source](https://github.com/NousResearch/hermes-agent/blob/v0.23.4/hermes_cli/plugins_provenance.py)

## Patching

Codemods and `patch.json` metadata are the source. Generated diffs in `patches.gen/` are reviewed, committed artifacts. Regeneration runs offline against a pristine package directory and leaves that directory unchanged:

```sh
vpr -w patches:generate -- unsnooze /path/to/pristine/unsnooze
```

The generator validates the package identity, rejects upstream source drift, and writes `patches.gen/unsnooze@<installed-version>.patch`. Don't regenerate from an already patched installation. To add a target, give it its own Flatcap codemod package with metadata, before/after fixtures and regression coverage, then register its definition in the generator.

Unsnooze is a global tool rather than this workspace's runtime dependency. Apply its codemod explicitly:

```sh
vpr -w patch:unsnooze
vpr -w patch:unsnooze -- /path/to/node_modules/unsnooze
```

The default target is `~/.bun/install/global/node_modules/unsnooze`. Application is idempotent, validates transformations before writing, saves originals under `~/.local/share/leonsilicon-ai/patch-backups/`, and runs the installed monitor's integration suite (`vpr -w test:unsnooze-patch` runs it on its own). Global package updates can overwrite the fix, so reapply after updating. Existing watchdogs must reload to use the changed code; new sessions load it automatically.
