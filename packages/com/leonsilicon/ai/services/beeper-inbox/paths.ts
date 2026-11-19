import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Unix socket paths are limited to about 104 bytes (macOS) or 108 (Linux). */
const MAX_SOCKET_PATH = 100;

/** Where everything lives. On Hermes Cloud the home is `/opt/data/beeper-inbox`, on the persistent volume. */
export interface InboxPaths {
  home: string;
  /** Hermes's own `.env`, which holds the device's secrets (`BEEPER_INBOX_*`). */
  hermesEnv: string;
  state: string;
  account: string;
  pickleDb: string;
  inboxDb: string;
  lock: string;
  socket: string;
  daemonInfo: string;
  downloads: string;
  logs: string;
  logFile: string;
  /** The vendored Pickle build (`node_modules/@beeper/pickle`), next to the app. */
  vendor: string;
}

export function inboxPaths(env: NodeJS.ProcessEnv = process.env): InboxPaths {
  const hermesHome = env.HERMES_HOME || env.HOME || "/opt/data";
  const home = env.BEEPER_INBOX_HOME || join(hermesHome, "beeper-inbox");
  const state = join(home, "state");
  const logs = join(home, "logs");
  return {
    home,
    hermesEnv: env.BEEPER_INBOX_ENV_FILE || join(hermesHome, ".env"),
    state,
    account: join(state, "account.json"),
    pickleDb: join(state, "pickle.db"),
    inboxDb: join(state, "inbox.db"),
    lock: join(state, "owner.lock"),
    socket: socketPath(state),
    daemonInfo: join(state, "daemon.json"),
    downloads: env.BEEPER_INBOX_DOWNLOADS || join(home, "downloads"),
    logs,
    logFile: join(logs, "daemon.log"),
    vendor: join(home, "node_modules"),
  };
}

/** Creates the directories; state (tokens' companions, the crypto store) is owner-only. */
export function ensureDirectories(paths: InboxPaths): void {
  for (const dir of [paths.home, paths.downloads, paths.logs]) mkdirSync(dir, { recursive: true });
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  chmodSync(paths.state, 0o700);
}

/** `state/daemon.sock`, or for a home too deep for a socket path, a per-home name in the temp dir. */
function socketPath(state: string): string {
  const preferred = join(state, "daemon.sock");
  if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH) return preferred;
  const id = createHash("sha256").update(state).digest("hex").slice(0, 16);
  return join(tmpdir(), `beeper-inbox-${id}.sock`);
}
