# @-/ai.leonsilicon.configs.todoist-automations

Leon's [Todoist Automations](https://www.todoist.com/automations), as the manifests Todoist runs, one per automation in [`@assets/`](@assets/). This repo is their source of truth: every run of the [Deploy workflow](../../../../../.github/workflows/deploy.yml) (each push to `main`) runs `push --yes`, which publishes each manifest Todoist doesn't match.

To change one, edit its manifest here, or build the change in Todoist's Automations agent and `pull` it into the repo before the next deploy; a change left only in Todoist is overwritten.

| Manifest                                                                              | What it does                                                                                             |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [`mirror-linear-tasks-to-todoist`](@assets/mirror-linear-tasks-to-todoist.json)       | When a Linear issue is created already assigned to Leon, adds a task to his Todoist Inbox linking to it  |
| [`complete-linear-task-from-todoist`](@assets/complete-linear-task-from-todoist.json) | When a Todoist task is completed, finds a Linear identifier in its description and marks that issue Done |

```sh
vpx _todoist-automations check              # exits 1 unless every manifest here matches Todoist
vpx _todoist-automations pull               # Todoist → @assets/
vpx _todoist-automations push [name]        # @assets/ → Todoist, all or one: the diff and a preview
vpx _todoist-automations push [name] --yes  # publishes them; what the Deploy workflow runs
```

It runs the workspace's pinned [`tda`](https://www.npmjs.com/package/@todoist/automations-cli) and needs Infisical access in the root `.env`. On a Mac, tda uses its own login (`tda auth login`); in CI, where there's none, it uses `TODOIST_API_TOKEN`, a personal API token of Leon's Todoist account in Infisical's `/todoist-automations` folder, and the run fails without one.

## How a manifest here maps to Todoist

- **By name.** A manifest's `name` is what ties it to its automation, and its file is named after it (`slug()`). The automation's id isn't kept, because Todoist's agent sometimes deletes an automation and builds it again under a new id. Renaming one in Todoist makes `check` report a new automation and an orphaned manifest; `pull` adds the new file, and the old one is deleted by hand.
- **Private values.** This repository is public, so a value such as Leon's Linear user ID is written as `{ "$env": "LINEAR_LEON_USER_ID" }`, an item tagged `#todoist-automations` in the root [`.env.schema`](../../../../../.env.schema) with its value in Infisical. `pull` makes that substitution for every value it knows, and refuses to write a manifest where one appears inside a longer string. `push` puts the real values back. A test fails if a manifest refers to an untagged item, or holds anything shaped like a UUID.
- **Created when gone.** A manifest with no automation of its name in Todoist becomes a new one, bound to the Linear and Todoist connections that have exactly one authorized account each. `pull` never deletes a manifest, so an automation deleted in Todoist comes back on the next deploy; delete its manifest to retire it.
- **Edits.** An automation that differs gets an edit draft, so its id, enabled state and connections stay. A draft that isn't published is deleted, because an open draft blocks the next edit, and an automation the Automations agent has a draft open on fails the run until that draft is published or discarded.
- **Not in the repo.** An automation in Todoist with no manifest here is left alone, with a warning in the run. `pull` adopts it.
- **Logs.** The Deploy workflow's logs are public. Diffs are printed with `{ "$env": NAME }` in place of the values, anything from tda is redacted, and in GitHub Actions every loaded value is also masked.

## API

- `slug(name)`, `manifestName(manifest)`: the file name for an automation, and the name a manifest gives it.
- `toEnvRefs(manifest, values)`, `fillEnv(manifest, values)`, `envNames(manifest)`: replace private values with `{ "$env": NAME }`, put them back, and list the names used.
- `sameManifest(a, b)`, `sortKeys(value)`: equality whatever the key order.
- `redact(text, values)`: the text with each value replaced by `$NAME`.
- `pairByName(here, live, nameOf)`: the manifests and automations in both places, here only and in Todoist only.

## Test

```sh
node --test packages/ai/leonsilicon/configs/todoist-automations/__tests__/*.test.ts
```
