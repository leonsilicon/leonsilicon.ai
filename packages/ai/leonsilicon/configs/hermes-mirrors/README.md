# @-/ai.leonsilicon.configs.hermes-mirrors

`_sync-hermes-mirrors` publishes the plugin directories from `main` to the corresponding repositories in `leonsiliconAI`. Each source directory becomes the mirror's root tree. The publisher leaves an identical tree at its current revision and appends a commit when the tree changes. The GitHub Actions workflow runs it after CI passes.

See [setup and operations](../../../../../DEVELOPMENT.md#hermes-plugin-mirrors) for the GitHub token and the Hermes Cloud migration.
