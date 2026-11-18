# @-/com.leonsilicon.ai.configs.patching.codemods.unsnooze

Source transformation and regression coverage for Claude transport-error recovery in Unsnooze.

## Usage

Use `vpr -w patch:unsnooze` from the repository root. The runner applies this codemod to a global installation and verifies its actual monitor.

## API

- `patchClaudeAdapter(source)` returns patched source, or `null` when already applied. Missing or duplicate anchors throw before any write.
- `unsnoozePatch` declares the npm package, affected bundles, transformation, and integration test path.

`patch.json` records the target and verified versions. `@fixtures/` contains before/after source examples; `__tests__/` contains offline codemod tests and the explicit installed-package integration suite. The generated diff belongs in root `patches.gen/`.
