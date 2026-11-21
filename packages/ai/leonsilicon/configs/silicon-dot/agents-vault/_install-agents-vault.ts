#!/usr/bin/env node
// Installs agents-vault for Silicon Dot's local Codex tasks: the command on PATH, the skill, and the Keychain token.
import { spawnSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KEYCHAIN_SERVICE } from "#agents-vault";

/**
 * Private-vault backup of the token (an op:// reference), created with the service account on
 * 2026-11-06. It names a private item, so it comes from the environment: the #agents-vault item of
 * the root .env.schema, which `vpx varlock run --filter '#agents-vault'` supplies.
 */
const TOKEN_ITEM = process.env.AGENTS_VAULT_TOKEN_REF ?? "";

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

function keychainHasToken(): boolean {
  return (
    spawnSync(
      "/usr/bin/security",
      ["find-generic-password", "-a", userInfo().username, "-s", KEYCHAIN_SERVICE],
      {
        stdio: "ignore",
      },
    ).status === 0
  );
}

const bin = join(home, ".local/bin/agents-vault");
replaceWithSymlink(join(here, "_agents-vault.ts"), bin);
console.log(`command: ${bin}`);

const skill = join(home, ".agents/skills/agents-vault/SKILL.md");
mkdirSync(dirname(skill), { recursive: true });
copyFileSync(join(here, "@assets/SKILL.md"), skill);
console.log(`skill: ${skill}`);

if (keychainHasToken()) {
  console.log(`token: already in the login Keychain (${KEYCHAIN_SERVICE})`);
} else if (process.argv.includes("--token-from-1password")) {
  // Reads the backup through the 1Password desktop app (asks Leon to approve) and pipes it to the Keychain
  // over stdin, so the token never appears in output or in a process's arguments.
  if (!TOKEN_ITEM.startsWith("op://"))
    throw new Error(
      "AGENTS_VAULT_TOKEN_REF isn't set: run the installer through `vpx varlock run --filter '#agents-vault' --`.",
    );
  const read = spawnSync("op", ["read", TOKEN_ITEM], {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
  });
  const token = read.stdout?.trim() ?? "";
  if (read.status !== 0 || !/^[\w.=-]+$/.test(token))
    throw new Error("Couldn't read the token backup from 1Password.");
  const add = spawnSync("/usr/bin/security", ["-i"], {
    input: `add-generic-password -U -a "${userInfo().username}" -s "${KEYCHAIN_SERVICE}" -l "Silicon Dot 1Password service account (Agents vault, read-only)" -T /usr/bin/security -w "${token}"\n`,
    stdio: ["pipe", "ignore", "inherit"],
  });
  if (add.status !== 0 || !keychainHasToken())
    throw new Error("Couldn't store the token in the login Keychain.");
  console.log(`token: copied from 1Password to the login Keychain (${KEYCHAIN_SERVICE})`);
} else {
  console.log(
    `token: missing. Rerun with --token-from-1password to copy it from the Private vault.`,
  );
  process.exitCode = 1;
}
