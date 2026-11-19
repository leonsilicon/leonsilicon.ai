import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { InboxAccount } from "#types";

/**
 * Secrets Leon may set live in Hermes's own `.env` (the dashboard's Keys page), the deployment's secret
 * mechanism: Hermes redacts those values from tool output. Only the `BEEPER_INBOX_*` keys are read.
 *
 * Pickle's store passphrase is not one of them. It used to be `BEEPER_INBOX_PICKLE_KEY` in `.env`, and
 * on 2026-11-19 the recovery key was pasted over it on the Keys page, which made the device's store
 * unreadable for good. It is now generated per device and kept beside the store (`pickleKeyFile`), where
 * nobody needs to see or edit it.
 */
export const SECRET_KEYS = {
  accessToken: "BEEPER_INBOX_ACCESS_TOKEN",
  recoveryKey: "BEEPER_INBOX_RECOVERY_KEY",
} as const;

/** Where the pickle key lived until 2026-11-19: read only to migrate an old store, or to explain a mix-up. */
export const LEGACY_PICKLE_KEY = "BEEPER_INBOX_PICKLE_KEY";

/** A Matrix recovery key: 48 base58 characters, usually shown as 12 groups of 4. */
export function looksLikeRecoveryKey(value: string): boolean {
  return /^(?:[1-9A-HJ-NP-Za-km-z]{4}\s*){12}$/.test(value.trim());
}

export function parseEnvFile(text: string, wanted: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match?.[1] || !wanted.includes(match[1])) continue;
    let value = match[2] ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
      if (match[2]?.startsWith('"'))
        value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    out[match[1]] = value;
  }
  return out;
}

export interface EnvSecrets {
  accessToken?: string;
  recoveryKey?: string;
  legacyPickleKey?: string;
  /** Mistakes worth telling Leon about, in words he can act on. */
  problems: string[];
  /** The subset that makes the values unusable: the daemon won't start (or reload) with them. */
  fatal: string[];
}

export function readEnvSecrets(envFile: string, env: NodeJS.ProcessEnv = process.env): EnvSecrets {
  const wanted = [...Object.values(SECRET_KEYS), LEGACY_PICKLE_KEY];
  const fromFile = existsSync(envFile) ? parseEnvFile(readFileSync(envFile, "utf8"), wanted) : {};
  const pick = (key: string): string | undefined =>
    (fromFile[key] || env[key] || undefined)?.trim() || undefined;
  const accessToken = pick(SECRET_KEYS.accessToken);
  const recoveryKey = pick(SECRET_KEYS.recoveryKey);
  const legacyPickleKey = pick(LEGACY_PICKLE_KEY);
  const problems: string[] = [];
  const fatal: string[] = [];
  if (accessToken && looksLikeRecoveryKey(accessToken)) {
    fatal.push(
      `${SECRET_KEYS.accessToken} holds what looks like a recovery key; the recovery key belongs in ${SECRET_KEYS.recoveryKey}`,
    );
  }
  if (recoveryKey && !looksLikeRecoveryKey(recoveryKey)) {
    fatal.push(
      `${SECRET_KEYS.recoveryKey} isn't in the recovery-key format (12 groups of 4 letters and digits)`,
    );
  }
  if (legacyPickleKey && looksLikeRecoveryKey(legacyPickleKey)) {
    problems.push(
      recoveryKey
        ? `${LEGACY_PICKLE_KEY} holds a recovery key; it isn't used any more and can be deleted`
        : `${LEGACY_PICKLE_KEY} holds what looks like the recovery key; put it in ${SECRET_KEYS.recoveryKey} instead (${LEGACY_PICKLE_KEY} isn't used any more)`,
    );
  } else if (legacyPickleKey) {
    problems.push(
      `${LEGACY_PICKLE_KEY} isn't used any more (the store key now lives beside the store); it can be deleted`,
    );
  }
  problems.push(...fatal);
  return {
    ...(accessToken ? { accessToken } : {}),
    ...(recoveryKey ? { recoveryKey } : {}),
    ...(legacyPickleKey ? { legacyPickleKey } : {}),
    problems,
    fatal,
  };
}

/** The device's store passphrase file: per device, so a new device never reuses an old store's key. */
export function pickleKeyFile(stateDir: string, deviceId: string): string {
  return join(stateDir, `pickle-key-${Buffer.from(deviceId).toString("base64url")}`);
}

/** Whether Pickle already has an encrypted crypto store for this device in `db`. */
export function storeHasCrypto(db: DatabaseSync, deviceId: string): boolean {
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM matrix_store WHERE key LIKE ?")
      .get(`%/${Buffer.from(deviceId).toString("base64url")}/crypto.json`) as
      | { n: number }
      | undefined;
    return Number(row?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * The pickle key for a device: the existing file; a new random one for a device with no store yet; or,
 * once, the legacy `.env` value for a store created before the file existed. Throws when a store exists
 * but its key is gone, because opening it with any other key can only fail.
 */
export function loadPickleKey(
  file: string,
  hasStore: boolean,
  legacy: string | undefined,
): { pickleKey: string; source: "file" | "created" | "migrated" } {
  if (existsSync(file)) {
    const pickleKey = readFileSync(file, "utf8").trim();
    if (pickleKey) return { pickleKey, source: "file" };
  }
  if (!hasStore) {
    const pickleKey = randomBytes(32).toString("base64url");
    writeFileSync(file, `${pickleKey}\n`, { mode: 0o600, flag: "wx" });
    return { pickleKey, source: "created" };
  }
  if (legacy && !looksLikeRecoveryKey(legacy)) {
    writeFileSync(file, `${legacy}\n`, { mode: 0o600, flag: "wx" });
    return { pickleKey: legacy, source: "migrated" };
  }
  throw new Error(
    "this device's encrypted store exists but the key it was created with is gone, so it can never be opened again; retire the store and sign in a new device (apps/beeper-inbox README)",
  );
}

export function readAccount(path: string): InboxAccount | null {
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<InboxAccount>;
  if (!value.homeserver || !value.userId || !value.deviceId) {
    throw new Error(`${path} is missing homeserver, userId or deviceId`);
  }
  return {
    homeserver: value.homeserver,
    userId: value.userId,
    deviceId: value.deviceId,
    createdAt: value.createdAt ?? "",
    ...(value.displayName ? { displayName: value.displayName } : {}),
  };
}

export function writeJsonAtomic(path: string, value: unknown, mode = 0o600): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  renameSync(temp, path);
}
