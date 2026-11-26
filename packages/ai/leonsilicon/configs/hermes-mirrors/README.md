# @-/ai.leonsilicon.configs.hermes-mirrors

`_sync-hermes-mirrors` publishes each `apps/hermes-plugin-<name>/` directory from `main` to `leonsiliconAI/hermes-plugin-<name>`. The source directory becomes the mirror's root tree, with the original Hermes plugin name in `plugin.yaml`. The publisher appends a commit when the tree changes. The GitHub Actions workflow runs it after CI passes.

See [setup and operations](../../../../../DEVELOPMENT.md#hermes-plugin-mirrors) for the GitHub token and the Hermes Cloud migration.

`_pythonmonkey.py` is the bridge each plugin uses to run its `policy.cjs`. The Vite+ build copies it beside each bundle, and the mirrors publish it. [What it guarantees and what policies must do](../../../../../DEVELOPMENT.md#hermes-plugin-mirrors) is in the development guide. Its tests are in `__tests__/test_pythonmonkey.py`.
