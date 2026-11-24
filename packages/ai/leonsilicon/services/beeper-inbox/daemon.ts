import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import type net from "node:net";
import { join } from "node:path";
import type { DaemonExtension, RunningExtension } from "#extension";
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
  /** Services hosted by this daemon. */
  extensions?: readonly DaemonExtension[];
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
  const extensions = new Map<string, RunningExtension>();
  let server: net.Server | null = null;
  let stopping: Promise<void> | null = null;
  let watchdog: NodeJS.Timeout | null = null;
  let lastStartAttempt = Date.now();

  const shutdown = (code = 0): Promise<void> => {
    stopping ??= (async () => {
      log("info", "daemon stopping", { code });
      if (watchdog) clearInterval(watchdog);
      server?.close();
      for (const [name, extension] of extensions) {
        try {
          await extension.stop?.();
        } catch (error) {
          log("error", "extension stop failed", { extension: name, error: String(error) });
        }
      }
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

  // Extensions share this process, so their state has the store's single writer. One that fails to
  // start is left out; the inbox itself still runs.
  for (const extension of options.extensions ?? []) {
    try {
      const home = join(paths.home, extension.name);
      mkdirSync(home, { recursive: true, mode: 0o700 });
      extensions.set(
        extension.name,
        await extension.start({
          home,
          log: fileLogger(paths.logFile, extension.name),
          tool: async (name, args) => {
            await waitReady();
            // Only the in-process relay has permission to deliver the handoff to Grok.
            return runTool(inbox, name, args, extension.name === "grok-relay");
          },
          rooms: async (roomIds) => {
            await waitReady();
            return inbox.rooms(roomIds);
          },
          connections: async () => {
            await waitReady();
            return inbox.connections();
          },
          publishLinearIssue: async (roomId, record) => {
            await waitReady();
            await inbox.publishLinearIssue(roomId, record);
          },
          publishProjectVisibility: async (record) => {
            await waitReady();
            await inbox.publishProjectVisibility(record);
          },
          senderNames: async (userIds) => {
            await waitReady();
            return inbox.names(userIds);
          },
          // The journal is replaced when the inbox reloads, so it is looked up on every call.
          journal: {
            head: async () => inbox.journal.head(),
            coveredSince: async () => inbox.journal.coveredSince(),
            latest: async (roomId, count) => inbox.journal.latest(roomId, count),
            since: async (roomId, sinceTs) => inbox.journal.since(roomId, sinceTs),
            recent: async (sinceTs, limit) => inbox.journal.recent(sinceTs, limit),
            changes: async ({ waitMs, ...options }) =>
              waitMs
                ? inbox.journal.changesWhenAny({ ...options, waitMs })
                : inbox.journal.changes(options),
          },
        }),
      );
    } catch (error) {
      log("error", "extension failed to start", {
        extension: extension.name,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    }
  }

  server = await serveIpc(
    paths.socket,
    async (method, params) => {
      const input = (params ?? {}) as Record<string, unknown>;
      switch (method) {
        case "ping":
          return { pid: process.pid, state: inbox.state, version: VERSION };
        case "status": {
          await waitReady();
          const running: Record<string, unknown> = {};
          for (const [name, extension] of extensions) {
            try {
              running[name] = extension.status?.() ?? { running: true };
            } catch (error) {
              running[name] = { error: String(error) };
            }
          }
          return { ...(await inbox.status()), extensions: running };
        }
        case "tool":
          await waitReady();
          return runTool(
            inbox,
            typeof input.name === "string" ? input.name : "",
            input.arguments ?? {},
          );
        case "extension": {
          const name = typeof input.extension === "string" ? input.extension : "";
          const extension = extensions.get(name);
          if (!extension?.callTool)
            throw Object.assign(new Error(`this daemon has no extension "${name}"`), {
              code: "bad_method",
            });
          return extension.callTool(
            typeof input.name === "string" ? input.name : "",
            (input.arguments && typeof input.arguments === "object"
              ? input.arguments
              : {}) as Record<string, unknown>,
          );
        }
        case "journal": {
          // For operators: what sync delivered lately. Text only when asked for.
          const after = Number(input.after ?? Math.max(0, inbox.journal.head() - 20)) || 0;
          const page = inbox.journal.changes({
            after,
            ...(typeof input.room_id === "string" ? { roomId: input.room_id } : {}),
            limit: Number(input.limit ?? 50) || 50,
          });
          return {
            ...inbox.journal.stats(),
            cursor: page.cursor,
            entries: page.entries.map(({ text, html, ...rest }) => ({
              ...rest,
              chars: text.length,
              html: html !== null,
              ...(input.text === true ? { text } : {}),
            })),
          };
        }
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
      await inbox
        .journalTick()
        .catch((error: unknown) => log("warn", "journal upkeep failed", { error: String(error) }));
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
