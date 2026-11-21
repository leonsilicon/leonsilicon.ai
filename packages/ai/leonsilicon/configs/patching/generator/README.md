# @-/ai.leonsilicon.configs.patching.generator

Offline patch generation and explicit application to locally installed tools.

## Usage

```sh
vpx _apply-patches unsnooze [package-directory]
vpx _generate-patches unsnooze /path/to/pristine/unsnooze
```

## API

- `applyPatch(name, packageRoot?, { backupDir? }?)` validates the target and all bundle transformations before writing atomically. Originals are backed up outside the repository. It returns changed file paths.
- `verifyPatch(name, packageRoot?)` runs the codemod package's integration tests against the target. The apply CLI always calls it.
- `generatePatch(name, packageRoot, outputDir?)` generates a versioned unified diff without modifying the source installation or using the network. By default output goes to `patches.gen/` relative to the current directory.

Unsnooze defaults to `~/.bun/install/global/node_modules/unsnooze`. Explicit paths support other package managers. This runner does not restart watchdogs or agents. Package updates can overwrite global patches; reapply and reload existing watchdogs or start a new session.
