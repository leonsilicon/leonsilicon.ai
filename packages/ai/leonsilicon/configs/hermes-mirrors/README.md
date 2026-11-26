# @-/ai.leonsilicon.configs.hermes-mirrors

`_sync-hermes-mirrors` publishes each `apps/hermes-plugin-<name>/` directory from `main` to `leonsiliconAI/hermes-plugin-<name>`. The source directory becomes the mirror's root tree, with the original Hermes plugin name in `plugin.yaml`. The publisher appends a commit when the tree changes. The GitHub Actions workflow runs it after CI passes.

See [setup and operations](../../../../../DEVELOPMENT.md#hermes-plugin-mirrors) for the GitHub token and the Hermes Cloud migration.

`_bridge.py` is the bridge each plugin uses to run its `policy.cjs`, and `bridge.ts` is the Node worker it starts, bundled with vscode-jsonrpc into `bridge.cjs` by `vp pack` here. The Vite+ build copies both beside each plugin's bundle, and the mirrors publish them. [What the bridge guarantees and what policies must do](../../../../../DEVELOPMENT.md#hermes-plugin-mirrors) is in the development guide. Its tests are in `__tests__/test_bridge.py`.
