# @-/ai.leonsilicon.configs.hermes-mirrors

`_sync-hermes-mirrors` publishes each `apps/hermes-plugin-<name>/` directory from `main` to `leonsiliconAI/hermes-plugin-<name>`. The source directory becomes the mirror's root tree, with the original Hermes plugin name in `plugin.yaml`. The publisher appends a commit when the tree changes. The GitHub Actions workflow runs it after CI passes.

See [setup and operations](../../../../../DEVELOPMENT.md#hermes-plugin-mirrors) for the GitHub token and the Hermes Cloud migration.
