import { appendFileSync, renameSync, rmSync, statSync } from "node:fs";
import type net from "node:net";
import { Inbox, VERSION } from "#inbox";
import { serveIpc } from "#ipc";
import { OwnerLock } from "#lock";
import { ensureDirectories, inboxPaths } from "#paths";
import { loadPickle, type PickleRuntime } from "#pickle";
import { writeJsonAtomic } from "#secrets";
import { runTool } from "#tools";
import type { Logger } from "#types";

/** Exit code when another live process already owns the store (EX_TEMPFAIL). */
export const EXIT_ALREADY_OWNED = 75;
const LOG_MAX_BYTES = 5 * 1024 * 1024;

export function fileLogger(path: string, component: string): Logger {
  return (level, message, fields) => {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), level, component, pid: process.pid, message, ...fields })}\n`;
    try {
      if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) > LOG_MAX_BYTES)
        renameSync(path, `${path}.1`);
      appendFileSync(path, line, { mode: 0o600 });
    } catch {
      process.stderr.write(line);
    }
  };
}

export interface DaemonOptions {
  env?: NodeJS.ProcessEnv;
  pickle?: () => Promise<PickleRuntime>;
  baseFetch?: typeof fetch;
  bridgeStatusWaitMs?: number;
  /** Tests: don't install signal handlers or exit the process. */
  embedded?: boolean;
}

export interface RunningDaemon {
  inbox: Inbox;
  ready: Promise<void>;
  shutdown(code?: number): Promise<void>;
}

/**
 * The store's one owner. Takes the lock or exits with EXIT_ALREADY_OWNED, then serves the socket,
 * signs in and keeps syncing until it's told to stop. It runs in its own session (the adapter starts
 * it detached), so Hermes reaping an MCP server's process group doesn't take it down mid-write.
 */
export async function startDaemon(options: DaemonOptions = {}): Promise<RunningDaemon | null> {
  const env = options.env ?? process.env;
  const paths = inboxPaths(env);
  ensureDirectories(paths);
  const log = fileLogger(paths.logFile, "daemon");
  const lock = OwnerLock.tryAcquire(paths.lock);
  if (!lock) {
    log("info", "another process owns the store; exiting");
    return null;
  }
  writeJsonAtomic(paths.daemonInfo, {
    pid: process.pid,
    version: VERSION,
    node: process.version,
    startedAt: new Date().toISOString(),
    argv: process.argv.slice(1),
  });
  log("info", "daemon starting", { version: VERSION, node: process.version });
  const inbox = new Inbox({
    paths,
    log,
    pickle: options.pickle ?? (() => loadPickle(paths.vendor)),
    ...(options.baseFetch ? { baseFetch: options.baseFetch } : {}),
    ...(options.bridgeStatusWaitMs !== undefined
      ? { bridgeStatusWaitMs: options.bridgeStatusWaitMs }
      : {}),
  });
  let server: net.Server | null = null;
  let stopping: Promise<void> | null = null;
  let watchdog: NodeJS.Timeout | null = null;
  let lastStartAttempt = Date.now();

  const shutdown = (code = 0): Promise<void> => {
    stopping ??= (async () => {
      log("info", "daemon stopping", { code });
      if (watchdog) clearInterval(watchdog);
      server?.close();
      try {
        await inbox.stop();
      } catch (error) {
        log("error", "stop failed", { error: String(error) });
      }
      rmSync(paths.socket, { force: true });
      lock.release();
      log("info", "daemon stopped; the device stays signed in");
      if (!options.embedded) process.exit(code);
    })();
    return stopping;
  };

  const ready = inbox.start();
  const waitReady = async () => {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([ready, new Promise((resolve) => (timer = setTimeout(resolve, 90_000)))]);
    clearTimeout(timer);
  };

  server = await serveIpc(
    paths.socket,
    async (method, params) => {
      const input = (params ?? {}) as Record<string, unknown>;
      switch (method) {
        case "ping":
          return { pid: process.pid, state: inbox.state, version: VERSION };
        case "status":
          await waitReady();
          return inbox.status();
        case "tool":
          await waitReady();
          return runTool(
            inbox,
            typeof input.name === "string" ? input.name : "",
            input.arguments ?? {},
          );
        case "reload":
          await inbox.reload();
          return inbox.status();
        case "refresh_directory":
          return inbox.refreshDirectory();
        case "shutdown":
          setTimeout(() => void shutdown(0), 50);
          return { stopping: true, pid: process.pid };
        default:
          throw Object.assign(new Error(`unknown method ${method}`), { code: "bad_method" });
      }
    },
    log,
  );

  // Health: a wedged Matrix core exits (the next tool call or adapter heartbeat starts a fresh owner),
  // stalled sync restarts in place, and a failed start is retried with a long backoff.
  watchdog = setInterval(() => {
    void (async () => {
      if (stopping) return;
      if ((await inbox.secretsChange()) === "reload") {
        log("info", "the device's account or secrets changed; reloading");
        lastStartAttempt = Date.now();
        await inbox.reload();
        return;
      }
      if (inbox.state === "ready") {
        if (!(await inbox.alive())) {
          log("error", "Matrix core stopped answering; exiting so a fresh owner starts");
          await shutdown(70);
          return;
        }
        if (inbox.syncStale()) {
          log("warn", "sync is stale; restarting it");
          await inbox
            .restartSync()
            .catch((error: unknown) =>
              log("error", "sync restart failed", { error: String(error) }),
            );
        }
      } else if (inbox.state === "error" && Date.now() - lastStartAttempt > 5 * 60_000) {
        lastStartAttempt = Date.now();
        log("info", "retrying start after an error");
        await inbox.reload();
      }
    })();
  }, 60_000);
  watchdog.unref();

  if (!options.embedded) {
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
      process.once(signal, () => void shutdown(0));
    process.on("uncaughtException", (error) => {
      log("error", "uncaught exception", { error: error.stack ?? String(error) });
      void shutdown(1);
    });
    process.on("unhandledRejection", (error) =>
      log("error", "unhandled rejection", { error: String(error) }),
    );
  }
  return { inbox, ready, shutdown };
}
