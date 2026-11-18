# @-/com.npmjs.krzysztofkobra__orca-mcp

Workspace wrapper for `@krzysztofkobra/orca-mcp` (MIT, [krzysztofkobra/orca-mcp](https://github.com/krzysztofkobra/orca-mcp)), an MCP server that wraps the Orca CLI with worker status, server-side waits and owner tags. Pinned at 0.1.1, whose published `dist` was compared file by file with a build of the reviewed commit `fe67eef` (2026-11-12): identical.

## Usage

Import the upstream exports through `@-/com.npmjs.krzysztofkobra__orca-mcp`.

## API

`buildTools(deps)` returns the 19 tool definitions (`name`, `description`, zod `shape`, `handler`) to register on your own MCP server; `VERSION`. Types: `OrcaRunner`, `ToolDef`, `ToolDeps`, `ToolResult`.
