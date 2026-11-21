# @-/ai.leonsilicon.configs.silicon-dot.agents-vault

Gives Silicon Dot read-only access to the 1Password **Agents** vault, so it can sign in to Leon's accounts without help, UofT included. Dot's local tasks run as Codex inside the ChatGPT app on Leon's MacBook, which reads `~/.codex` and `~/.agents/skills`. This package installs a command and a skill there.

## Setup

| Piece           | Where                                                                                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Service account | 1Password "Silicon Dot", `read_items` on Agents only (created 2026-11-06). It can't see other vaults or write.                                                                                               |
| Token           | Login Keychain, service `silicon-dot-op-service-account`. Backup: Private vault, "Service Account Auth Token: Silicon Dot"; its `op://` reference is `AGENTS_VAULT_TOKEN_REF` in Infisical (`/agents-vault`) |
| Command         | `~/.local/bin/agents-vault`, a symlink to `_agents-vault.ts`                                                                                                                                                 |
| Skill           | `~/.agents/skills/agents-vault/SKILL.md`, copied from `@assets/SKILL.md`                                                                                                                                     |
| UofT browser    | Persistent headless Camoufox session `uoft`, a Duo-trusted device                                                                                                                                            |

Install or update, then check:

```sh
node packages/ai/leonsilicon/configs/silicon-dot/agents-vault/_install-agents-vault.ts
# or, to copy the token backup into the Keychain:
vpx varlock run --filter '#agents-vault' -- node packages/ai/leonsilicon/configs/silicon-dot/agents-vault/_install-agents-vault.ts --token-from-1password
agents-vault check
```

`--token-from-1password` copies the backup into the Keychain through the 1Password desktop app, which asks Leon to approve. Rerun the installer after editing `@assets/SKILL.md`. To rotate the token, create a new service account with `op service-account create "Silicon Dot" --vault Agents:read_items --raw`, replace the backup item's credential, delete the Keychain entry, rerun the installer with `--token-from-1password`, and revoke the old account at my.1password.com.

The token never goes into an environment variable. `agents-vault` reads it from the Keychain for each `op` call, so Leon's own `op` keeps using the desktop app account.

## Commands

- `agents-vault check` confirms the account is a service account that sees only Agents.
- `agents-vault items` and `agents-vault fields <item>` list items, saved websites and field names, never values or notes.
- `agents-vault fill <session> <target> <item> <field> [--submit | --click <target>]` types `username`, `password`, `otp` or a labelled field into a camoufox-browser element.
- `agents-vault uoft-login [--url <url>] [--session uoft] [--no-persist]` signs in through UTORid weblogin and Duo. Duo is answered with a passcode, never a push, and the command finishes on `--url`.
- `agents-vault op <arguments>` runs `op` as the service account.

## Safeguards

- `fill` works only on HTTPS pages whose host is one of the item's saved websites or a subdomain of one, the way 1Password's own autofill matches sites. UofT allows `utoronto.ca` and `duosecurity.com`.
- Camoufox echoes filled text and page snapshots show input values. So `fill` hides command output, removes secrets from errors, and requires secrets to be submitted in the same call. If the page doesn't move on, it clears any copy left in a field.
- Notes can't be selected. The UofT item's notes hold Duo bypass codes.

None of these limit a misbehaving agent. Anything running as Leon on the MacBook can read the Keychain token and every item in Agents, notes and bypass codes included. Keep the vault to what agents need.

## API

`fill`, `uoftLogin`, and the pure helpers `matchItem`, `selectField`, `fieldValue`, `isSecret`, `originAllowed` and `redact` are exported from `+.ts`. Tests cover the pure helpers offline: `node --test __tests__/*.test.ts`.
