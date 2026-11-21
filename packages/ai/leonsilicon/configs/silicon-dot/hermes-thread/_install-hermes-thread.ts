#!/usr/bin/env node
// Installs hermes-thread for Silicon Dot's Codex sessions: the Keychain token, the MCP server in
// ~/.codex/config.toml, the command it runs, and the skill. Rerun it after editing @assets/SKILL.md.
//
//   vpx varlock run --filter '#hermes-thread' -- node packages/ai/leonsilicon/configs/silicon-dot/hermes-thread/_install-hermes-thread.ts
//
// Add --replace-token to overwrite a token already in the Keychain (after a rotation).
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KEYCHAIN_SERVICE, keychainToken, withServerSection } from "#hermes-thread";

const here = dirname(fileURLToPath(import.meta.url));
const home = homedir();

function replaceWithSymlink(target: string, path: string) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    if (!lstatSync(path).isSymbolicLink())
      throw new Error(`${path} exists and isn't a symlink; move it first.`);
    rmSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  symlinkSync(target, path);
}

// 1. The token, from Infisical through varlock, into the login Keychain (piped to `security -i`, so
//    it never shows in a process list).
if (keychainToken() && !process.argv.includes("--replace-token")) {
  console.log(`token: already in the login Keychain (${KEYCHAIN_SERVICE})`);
} else {
  const token = process.env.SLACK_AS_LEON_CODEX_TOKEN?.trim() ?? "";
  if (token.length < 40)
    throw new Error(
      "SLACK_AS_LEON_CODEX_TOKEN isn't set; run this through `vpx varlock run --filter '#hermes-thread' --`",
    );
  const add = spawnSync("/usr/bin/security", ["-i"], {
    input: `add-generic-password -U -a "${userInfo().username}" -s "${KEYCHAIN_SERVICE}" -l "slack-puppet token for Silicon Dot's Codex sessions" -T /usr/bin/security -w "${token}"\n`,
    encoding: "utf8",
  });
  if (add.status !== 0 || keychainToken() !== token)
    throw new Error("Couldn't store the token in the login Keychain.");
  console.log(`token: stored in the login Keychain (${KEYCHAIN_SERVICE})`);
}

// 2. The command Codex runs.
const command = join(home, ".local/bin/hermes-thread-mcp");
replaceWithSymlink(join(here, "_hermes-thread-mcp.ts"), command);
console.log(`command: ${command}`);

// 3. The MCP server in Codex's config, backing up the original once.
const configPath = join(home, ".codex/config.toml");
const before = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
// A Node that stays put: Homebrew's, not the version-numbered one a tool runner may be using.
const node =
  ["/opt/homebrew/bin/node", "/usr/local/bin/node"].find((path) => existsSync(path)) ??
  process.execPath;
const after = withServerSection(before, node, command);
if (after !== before) {
  // The first backup is the config before this installer ever ran; later runs keep it.
  const backup = `${configPath}.bak-hermes-thread`;
  if (before && !existsSync(backup)) writeFileSync(backup, before, { mode: 0o600 });
  writeFileSync(configPath, after);
  console.log(`codex: [mcp_servers.slack-puppet] written to ${configPath}`);
} else console.log("codex: config already up to date");

// 4. The skill.
const skill = join(home, ".agents/skills/hermes-slack-thread/SKILL.md");
mkdirSync(dirname(skill), { recursive: true });
copyFileSync(join(here, "@assets/SKILL.md"), skill);
console.log(`skill: ${skill}`);

// 5. Check: the proxy reaches slack-puppet with the token.
const check = spawnSync(process.execPath, [command, "--check"], { encoding: "utf8" });
console.log(`check: ${(check.stdout || check.stderr).trim()}`);
if (check.status !== 0) process.exit(1);
