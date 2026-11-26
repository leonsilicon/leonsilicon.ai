import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { callIpc, IpcError } from "#ipc";
import type { InboxPaths } from "#paths";

/**
 * How clients (the MCP adapter, the CLI) reach the daemon, starting it if nothing answers and no live
 * owner is named in daemon.json. Any number of clients may race here: each may spawn a daemon, the
 * owner lock lets exactly one keep running, and the rest exit at once with EXIT_ALREADY_OWNED.
 */

export interface DaemonLauncher {
  /** argv for the daemon, e.g. [process.execPath, "/opt/data/beeper-inbox/app/beeper-inbox.mjs", "daemon"]. */
  command: string[];
  env?: NodeJS.ProcessEnv;
}

let inflight: Promise<void> | null = null;

/** How long to give a daemon that was just started before starting another. */
const RESPAWN_MS = 10_000;

export function ensureDaemon(
  paths: InboxPaths,
  launcher: DaemonLauncher,
  waitMs = 45_000,
): Promise<void> {
  inflight ??= start(paths, launcher, waitMs).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function answers(paths: InboxPaths, timeoutMs: number): Promise<boolean> {
  try {
    await callIpc(paths.socket, "ping", undefined, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function start(paths: InboxPaths, launcher: DaemonLauncher, waitMs: number): Promise<void> {
  if (await answers(paths, 5_000)) return;
  const [command, ...args] = launcher.command;
  if (!command) throw new IpcError("daemon_unreachable", "no daemon command");
  const deadline = Date.now() + waitMs;
  let spawnedAt = Number.NEGATIVE_INFINITY;
  let owner = daemonPid(paths);
  for (;;) {
    // A live owner that is slow to answer (busy with Matrix, say) is waited for, not replaced: a
    // second daemon can't take the store from it and exits at once.
    if (owner === null && Date.now() - spawnedAt >= RESPAWN_MS) {
      spawnedAt = Date.now();
      // detached: setsid(), its own session and process group, outside the MCP server's group that
      // Hermes reaps when it exits. Output goes to the daemon's own log file.
      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        env: daemonEnv(launcher.env ?? process.env),
      });
      child.unref();
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (await answers(paths, owner === null ? 2_000 : 5_000)) return;
    owner = daemonPid(paths);
  }
  if (owner !== null)
    throw new IpcError(
      "daemon_busy",
      `the beeper-inbox daemon (pid ${owner}) is running but hasn't answered for ${waitMs / 1000}s, usually because Matrix is slow; try again in a minute (see ${paths.logFile})`,
    );
  throw new IpcError(
    "daemon_unreachable",
    `the beeper-inbox daemon didn't start within ${waitMs / 1000}s; see ${paths.logFile}`,
  );
}

/** The daemon reads its secrets from Hermes's .env itself; it gets only the basics from here. */
function daemonEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keep = [
    "HOME",
    "HERMES_HOME",
    "PATH",
    "LANG",
    "TZ",
    "TMPDIR",
    "TMP",
    "TEMP",
    "BEEPER_INBOX_HOME",
    "BEEPER_INBOX_ENV_FILE",
    "BEEPER_INBOX_DOWNLOADS",
    "NODE_OPTIONS",
  ];
  const out: NodeJS.ProcessEnv = {};
  for (const key of keep) if (env[key]) out[key] = env[key];
  return out;
}

/** The daemon's pid, if its info file names a live beeper-inbox daemon process. */
export function daemonPid(paths: InboxPaths): number | null {
  if (!existsSync(paths.daemonInfo)) return null;
  try {
    const info = JSON.parse(readFileSync(paths.daemonInfo, "utf8")) as { pid?: number };
    if (!info.pid) return null;
    process.kill(info.pid, 0);
    const cmdline = existsSync(`/proc/${info.pid}/cmdline`)
      ? readFileSync(`/proc/${info.pid}/cmdline`, "utf8")
      : "";
    if (cmdline && !cmdline.includes("daemon")) return null;
    return info.pid;
  } catch {
    return null;
  }
}

/** Asks the daemon to stop and waits until its socket stops answering. */
export async function stopDaemon(
  paths: InboxPaths,
  waitMs = 30_000,
): Promise<{ stopped: boolean; pid: number | null }> {
  const pid = daemonPid(paths);
  try {
    await callIpc(paths.socket, "shutdown", undefined, 5_000);
  } catch (error) {
    if (!(error instanceof IpcError) || error.code !== "daemon_unreachable") {
      if (pid) process.kill(pid, "SIGTERM");
    }
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!(await answers(paths, 1_000)) && (!pid || !isAlive(pid))) return { stopped: true, pid };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { stopped: false, pid };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
