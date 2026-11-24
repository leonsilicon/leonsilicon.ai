# @-/ai.leonsilicon.services.orca-bridge

Orca over MCP for remote agents such as Hermes Cloud. It runs on the always-on Mac mini, so it targets the mini's Orca by default; the MacBook is reachable as the saved environment `MacBook` while it is awake. Deployment is in [`apps/orca-bridge`](../../../../../apps/orca-bridge/README.md). [OrcaHermes Device](../orcahermes-device/README.md) serves the same tools over stdio, built with `createServer`.

It merges two tool sets on one stateless Streamable HTTP endpoint (`/mcp`, bearer token):

| Tools                                                                                                             | From                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `orca_projects`, `orca_guide`, `orca_cli`                                                                         | This package. `orca_cli` runs any Orca CLI command, computer use included                                                            |
| `orca_status`, `orca_worktree_create`, `orca_worker_start`, `orca_agent_status`, `orca_wait`, `orca_send`, … (19) | [`@krzysztofkobra/orca-mcp`](../../../../com/npmjs/krzysztofkobra__orca-mcp/README.md): worker status, server-side waits, owner tags |

## Behavior

- **Access.** Leon granted full Orca access on 2026-11-05, including computer use. `orca_cli` refuses only `serve`, `plugin dev watch`, `environment add|rm`, `pair` and `--pairing-code`, plus any `--environment` other than those configured. Arguments go to `orca` as an argv array, never through a shell, with `--json` appended.
- **Timeouts.** A CLI call gets 60 s, or 180 s for `worktree create`, `agent launch` and `orchestration worker-start`, or its own `--timeout-ms` plus 20 s, never more than `maxCallMs` (170 s, under Hermes Cloud's 180 s). `orca_wait`, `orca_check` and `orca_terminal_wait` are capped at `maxCallMs` − 5 s and say so in their descriptions.
- **Screenshots.** Computer-use screenshots that Orca saves to temp files come back as JPEG image content at the window's point size (at most three per call), so image pixels equal click coordinates. They are resized with `sips` on macOS and Pillow on Linux; with neither, the PNG is attached as is and the tool says to divide its pixels by the scale.
- **Worker tools.** orca-mcp's paths must lie under `ORCA_MCP_ROOTS`. Workers it starts are tagged `orca-mcp:<ORCA_MCP_CLIENT>` (`hermes-cloud`) in their worktree comment, so they are found again after a restart. Its tools act on the mini's Orca only.
- **Origin.** A request with an `Origin` other than the public origin is refused (403). `/healthz` is open and reveals only the version.

## API

- `loadConfig(env)`: the `OrcaBridgeConfig` from `ORCA_BRIDGE_TOKEN` (required), `ORCA_BRIDGE_PORT`, `ORCA_BRIDGE_PUBLIC_ORIGIN`, `ORCA_BRIDGE_ENVIRONMENTS`, `ORCA_BRIDGE_MAX_CALL_MS`, `ORCA_BRIDGE_CWD`, `ORCA_BIN`, `ORCA_MCP_ROOTS`, `ORCA_MCP_CLIENT`. Its optional `host` (`mini`, the default, or `hermes-cloud`) changes only how the instructions and `orca_cli` description describe where the tools run.
- `createListener(config, overrides?)`: the HTTP server. `createServer(config, workers)`: one MCP server with all tools. `workerTools(config, overrides?)`: orca-mcp's tools with the wait caps.
- `checkArgs`, `timeoutFor`, `runCli`, `CliRefused`, `attachImages`, `instructions`, `VERSION`.

## History

Until 2026-11-12 this ran on the MacBook (`~/.local/share/orca-hermes-cloud`, v2.0.0, a Tailscale Funnel route), so Hermes lost Orca whenever the MacBook slept. v3.0.0 moved it to the mini and added orca-mcp's tools.
