# @-/ai.leonsilicon.configs.silicon-dot.hermes-thread

Lets the Codex sessions Silicon Dot starts talk to Hermes in a task's Slack thread. When Hermes hands Dot a task (the inbox's `send_message` in Dot's chat, which requires the task's Slack thread since 2026-11-21), the message ends with Leon's standing rule: start a Codex session titled `Task slack:<channel>/<thread_ts>`, link it, and have it work with Hermes in that thread. Dot's local tasks run as Codex inside the ChatGPT app on Leon's MacBook, which reads `~/.codex` and `~/.agents/skills`, so this installs the two things Codex needs there.

| Piece      | Where                                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MCP server | `[mcp_servers.slack-puppet]` in `~/.codex/config.toml`: `node ~/.local/bin/hermes-thread-mcp`, a stdio proxy to `https://slack-puppet.leonsilicon.ai/mcp` (tool timeout 180 s) |
| Token      | slack-puppet's `SLACK_AS_LEON_CODEX_TOKEN` (Infisical `/slack-as-leon`), kept in the login Keychain as `silicon-dot-slack-puppet`, never in Codex's config or an env var       |
| Command    | `~/.local/bin/hermes-thread send                                                                                                                                               | read`: the same two tools from a shell, for sessions that don't get Codex's MCP servers. Silicon Dot's sessions are ChatGPT conversations that use the Mac through the app, and they had the skill but not the MCP tools (2026-11-21) |
| Skill      | `~/.agents/skills/hermes-slack-thread/SKILL.md`, from `@assets/SKILL.md`                                                                                                       |

With that token slack-puppet gives Codex only `hermes_thread_send` and `hermes_thread_read`: replies in a channel thread, labelled `🤖 <session title>:`, with the marker group `c0de` that Hermes's `slack-as-leon-guard` lets through as a Codex session's post (see [slack-as-leon](../../../services/slack-as-leon/README.md#grok-bots)).

## Install

```sh
vpx varlock run --filter '#hermes-thread' -- node packages/ai/leonsilicon/configs/silicon-dot/hermes-thread/_install-hermes-thread.ts
```

It stores the token in the Keychain (piped to `security -i`, so it never shows in a process list), links the command, writes the Codex section (backing the old config up as `config.toml.bak-hermes-thread`), copies the skill, and ends with `hermes-thread-mcp --check`, which connects once and lists the tools. Rerun it after editing the skill; add `--replace-token` after rotating the token. New Codex sessions pick the server up; running ones don't.

## Cloud environment

Configure `SLACK_AS_LEON_CODEX_TOKEN` in the environment’s secret store and provide the checkout containing this client. Start the stdio server with `node <checkout>/packages/ai/leonsilicon/configs/silicon-dot/hermes-thread/_hermes-thread-mcp.ts`. Its `--check` flag verifies the tool listing. A shell-only worker can run `_hermes-thread.ts send` and `read` with the same arguments as `hermes-thread`. Include the companion skill in the environment so the session knows how to reach its thread.

## Test

```sh
node --test packages/ai/leonsilicon/configs/silicon-dot/hermes-thread/__tests__/*.test.ts
```
