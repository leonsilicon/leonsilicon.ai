# Development

This workspace follows the [Flatcap convention](https://github.com/leonsilicon/flatcap), with ImproveLabs/Haniverse's package layout and Vite+ for every task.

## Workspace layout

| Location                                          | Purpose                                                                                                                                                           |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `www/<hostname, labels reversed>/index.html`      | A site's entrypoint: `www/ai/leonsilicon/orca/index.html` is `orca.leonsilicon.ai`                                                                                |
| `apps/<name>/`                                    | Deployable entrypoints (Workers and Mac mini services), deploy commands and `@assets/`                                                                            |
| `packages/com/leonsilicon/www/`                   | Serves the built pages from Workers, plus the script and styles the pages share                                                                                   |
| `packages/com/leonsilicon/ai/services/<name>/`    | The services behind `*.leonsilicon.ai`                                                                                                                            |
| `packages/com/leonsilicon/ai/configs/<name>/`     | Grok relay and Cronometer (copies of what runs on the mini outside this workspace), the mini env-file renderer, Unsnooze patching, and Silicon Dot's agents-vault |
| `packages/com/leonsilicon/hermes/plugins/<name>/` | Hermes plugins, installed to `$HERMES_HOME/plugins/<name>/` on Hermes Cloud                                                                                       |
| `packages/com/npmjs/`                             | Wrappers for upstream runtime dependencies                                                                                                                        |
| `patches.gen/`                                    | Committed versioned diffs generated from codemods                                                                                                                 |

Applications use `@-apps/<folder>`. Package names mirror their path beneath `packages/`, joined with dots: `packages/com/leonsilicon/www` becomes `@-/com.leonsilicon.www`. Upstream npm packages are wrapped in `packages/com/npmjs/<name>`.

## Sites

`www/` holds HTML only. Every `www/**/index.html` is a Vite entrypoint (`vite.config.ts` finds them), and its code comes from packages: a page imports `@-/com.leonsilicon.www/client` in an inline module script. `vp build` writes `dist/www`, keeping the `www/` paths, with shared scripts and styles in `dist/www/assets/`.

A Worker serves a hostname's pages by uploading `dist/www` as its assets and calling `serveSite` from [`@-/com.leonsilicon.www`](packages/com/leonsilicon/www/README.md) before its own handler. Browsers (GET with `Accept: text/html`) get the page; every other request, MCP included, goes to the handler.

To add a site, create `www/<reversed host>/index.html`. If it's a new Custom Domain on a Worker, add the route to that Worker's `wrangler.jsonc`; a test fails when a Custom Domain has no page.

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

Tests need no credentials. Runtime dependencies belong to the consuming package, so the Mac mini's production install (`bun install --production`) doesn't need root development tooling.

## Secrets and config

This repository is public, so nothing private is committed: not secrets, and not identifiers either, such as Slack user and channel IDs, tailnet hosts and IPs, usernames or private paths. They live in Infisical, and [varlock](https://varlock.dev) loads them through the root [`.env.schema`](.env.schema). Cloudflare resource IDs (KV namespace, Workers VPC service, tunnel) do stay in the Wrangler and cloudflared configs: they grant nothing without the account's credentials.

- **Infisical.** The project whose ID is in `.env.schema`, environment `prod` (override with `INFISICAL_ENVIRONMENT`), one folder per app (`/slack-as-leon`, `/linear-slack-sync`, `/orca-bridge`, `/beeper-watch`, `/hermes`, `/agents-vault`) and `/shared` for values several apps use, such as Leon's Slack session. The schema says which keys each folder needs.
- **Access.** A Machine Identity (Universal Auth) in the project: `leonsilicon.com-repo` (named before the move to leonsilicon.ai), role Member, so it can write values as well as read them. Its `INFISICAL_CLIENT_ID` and `INFISICAL_CLIENT_SECRET` go in `.env` at the root (gitignored); add a client secret on the identity's Universal Auth page for another machine. `vpx varlock load --filter '#orca-bridge'` checks one app's values, with secrets redacted.
- **Tags.** Every schema item is tagged with the app that uses it, and an app loads only its own tag. A filtered load resolves nothing else, so one app's deploy never fetches, or uploads, another's secrets.
- **Workers.** `vpr -w deploy:slack-as-leon` and `vpr -w deploy:linear-slack-sync` run `varlock-wrangler deploy` in the app's directory, whose `package.json` sets `varlock.filter`. Sensitive values become Worker secrets and the rest vars, replacing everything the Worker had, so change values in Infisical rather than with `wrangler secret put`. It also uploads `__VARLOCK_ENV`, the same values as one secret, which the Worker doesn't read. The `ai-edge` Worker has no config and deploys with plain `wrangler`.
- **Mini services.** `--start` writes `~/.config/<app>/env` (mode 600) on the mini with [`_env-file`](packages/com/leonsilicon/ai/configs/env-file/README.md), straight over SSH, before restarting the service. The values never touch the local disk, and nothing on the mini needs Infisical access.
- **Hermes Cloud and agents-vault.** The `#hermes` items are set in Hermes's own env (its dashboard's Keys page) by hand, and the agents-vault installer takes `#agents-vault` through `vpx varlock run --filter '#agents-vault' --`.
- **Adding a value.** Add the item to `.env.schema` with its app's tag: a literal for anything public, `infisical(leonsilicon, "<KEY>", "/<app>")` and `@sensitive` for anything private. Then add the value to Infisical.

CI runs no deploys and needs no Infisical access.

## Deploying

| What                         | Command                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `ai-edge` Worker             | `vpr -w deploy:ai-edge`                                                                                    |
| `slack-as-leon` Worker       | `vpr -w deploy:slack-as-leon`                                                                              |
| `linear-slack-sync` Worker   | `vpr -w deploy:linear-slack-sync`                                                                          |
| Hermes plugins               | Copy into `$HERMES_HOME/plugins/<name>/`; see each plugin's README                                         |
| Beeper inbox (Hermes Cloud)  | `vpr -w build:beeper-inbox`, then upload and install; see [its README](apps/beeper-inbox/README.md#deploy) |
| ai-gateway and tunnel (mini) | `apps/ai-gateway/_deploy-ai-gateway.sh [--start]`                                                          |
| Orca bridge (mini)           | `apps/orca-bridge/_deploy-orca-bridge.sh [--start]`                                                        |
| Beeper Watch (mini)          | `apps/beeper-watch/_deploy-beeper-watch.sh [--start]`                                                      |

The Worker tasks typecheck and build `www/` before deploying, and every command that writes config needs Infisical access. The mini scripts copy this workspace to the mini over SSH (`DEPLOY_HOST`, default `mini`) and install production dependencies there. The Grok relay and Cronometer are copied by hand; their READMEs have the steps.

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
