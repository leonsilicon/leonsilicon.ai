import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type net from "node:net";
import { DatabaseSync } from "node:sqlite";
import { startForwarder, type ForwarderStats, type Log } from "#forward";
import { devicePaths, readDeviceConfig, readEnvValue, type DevicePaths, type Peer } from "#paths";

/** Exit code when another live link daemon already owns the tailnet state (EX_TEMPFAIL). */
export const EXIT_ALREADY_RUNNING = 75;
/** Hermes .env key for a one-time Tailscale auth key; only read while the node is logged out. */
export const AUTHKEY_ENV = "ORCA_DEVICE_TS_AUTHKEY";
const LOG_MAX_BYTES = 5 * 1024 * 1024;

export function fileLog(path: string): Log {
  return (level, message, fields) => {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), level, pid: process.pid, message, ...fields })}\n`;
    try {
      if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) > LOG_MAX_BYTES)
        renameSync(path, `${path}.1`);
      appendFileSync(path, line, { mode: 0o600 });
    } catch {
      process.stderr.write(line);
    }
  };
}

/**
 * The single owner of this device's tailnet identity. It holds an open `BEGIN EXCLUSIVE` SQLite
 * transaction on `state/link.lock`, which the kernel drops when the process dies by any cause.
 */
export function tryLock(path: string): DatabaseSync | null {
  const db = new DatabaseSync(path, { timeout: 0 });
  try {
    db.exec("PRAGMA journal_mode=DELETE");
    db.exec("CREATE TABLE IF NOT EXISTS owner (pid INTEGER NOT NULL)");
    db.exec("PRAGMA locking_mode=EXCLUSIVE");
    db.exec("BEGIN EXCLUSIVE");
    db.prepare("INSERT INTO owner (pid) VALUES (?)").run(process.pid);
    return db;
  } catch (error) {
    db.close();
    if (/database is locked|SQLITE_BUSY/i.test(String(error))) return null;
    throw error;
  }
}

export interface LinkStatus {
  pid: number;
  startedAt: string;
  updatedAt: string;
  tailscale: {
    daemonPid: number | null;
    backendState: string | null;
    tailnetIp: string | null;
    hostname: string | null;
    tags: string[];
    error: string | null;
  };
  peers: Array<
    {
      name: string;
      loopback: string;
      port: number;
      listening: boolean;
      online: boolean | null;
    } & ForwarderStats
  >;
}

function run(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface LinkOptions {
  env?: NodeJS.ProcessEnv;
  /** Tests: don't exit the process or install signal handlers. */
  embedded?: boolean;
  /** Tests: replace `tailscale nc` and skip tailscaled. */
  dial?: string[];
  noTailscale?: boolean;
  pollMs?: number;
}

export interface RunningLink {
  status(): LinkStatus;
  stop(code?: number): Promise<void>;
}

export async function startLink(options: LinkOptions = {}): Promise<RunningLink | null> {
  const paths = devicePaths(options.env);
  for (const dir of [paths.state, paths.logs]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(paths.state, 0o700);
  const log = fileLog(paths.linkLog);
  const lock = tryLock(paths.lock);
  if (!lock) return null;
  const config = readDeviceConfig(paths.config);
  const startedAt = new Date().toISOString();
  log("info", "link starting", { peers: config.peers.map((peer) => peer.name) });

  const servers: net.Server[] = [];
  const peerStatus: Array<
    Peer & { listening: boolean; online: boolean | null; stats: ForwarderStats }
  > = [];
  let tailscaled: ChildProcess | null = null;
  let stopping: Promise<void> | null = null;
  let restartDelay = 2_000;
  const ts: LinkStatus["tailscale"] = {
    daemonPid: null,
    backendState: null,
    tailnetIp: null,
    hostname: null,
    tags: [],
    error: null,
  };
  const cli = (args: string[], timeoutMs = 30_000) =>
    run(paths.tailscaleCli, ["--socket", paths.tailscaleSocket, ...args], timeoutMs);

  const startTailscaled = () => {
    if (options.noTailscale || stopping) return;
    // A tailscaled left behind by an owner that was killed still holds the state: stop it first.
    if (existsSync(paths.tailscaledPid)) {
      const old = Number(readFileSync(paths.tailscaledPid, "utf8"));
      if (old > 1 && alive(old)) {
        const cmdline = existsSync(`/proc/${old}/cmdline`)
          ? readFileSync(`/proc/${old}/cmdline`, "utf8")
          : "";
        if (cmdline.includes("tailscaled")) {
          process.kill(old, "SIGTERM");
          log("warn", "stopped a tailscaled left behind by an earlier link", { pid: old });
        }
      }
    }
    mkdirSync(paths.tailscaleState, { recursive: true, mode: 0o700 });
    const out = paths.tailscaledLog;
    if ((statSync(out, { throwIfNoEntry: false })?.size ?? 0) > LOG_MAX_BYTES)
      renameSync(out, `${out}.1`);
    const child = spawn(
      paths.tailscaled,
      [
        "--tun=userspace-networking",
        `--statedir=${paths.tailscaleState}`,
        `--socket=${paths.tailscaleSocket}`,
        "--port=0",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    tailscaled = child;
    ts.daemonPid = child.pid ?? null;
    if (child.pid) writeFileSync(paths.tailscaledPid, String(child.pid));
    const sink = (chunk: Buffer) => {
      try {
        appendFileSync(out, chunk);
      } catch {
        // logging is best effort
      }
    };
    child.stdout?.on("data", sink);
    child.stderr?.on("data", sink);
    child.on("exit", (code, signal) => {
      ts.daemonPid = null;
      if (stopping) return;
      log("warn", "tailscaled exited; restarting", { code, signal, inMs: restartDelay });
      setTimeout(startTailscaled, restartDelay).unref();
      restartDelay = Math.min(restartDelay * 2, 60_000);
    });
  };

  const poll = async () => {
    if (options.noTailscale || stopping) return;
    const status = await cli(["status", "--json"], 15_000);
    try {
      const body = JSON.parse(status.stdout) as {
        BackendState?: string;
        Self?: { TailscaleIPs?: string[]; HostName?: string; Tags?: string[] };
        Peer?: Record<string, { TailscaleIPs?: string[]; Online?: boolean }>;
      };
      ts.backendState = body.BackendState ?? null;
      ts.tailnetIp = body.Self?.TailscaleIPs?.[0] ?? null;
      ts.hostname = body.Self?.HostName ?? null;
      ts.tags = body.Self?.Tags ?? [];
      ts.error = null;
      if (ts.backendState === "Running") restartDelay = 2_000;
      for (const peer of peerStatus) {
        const match = Object.values(body.Peer ?? {}).find((candidate) =>
          candidate.TailscaleIPs?.includes(peer.address),
        );
        peer.online = match ? Boolean(match.Online) : null;
      }
      if (
        ts.backendState === "NeedsLogin" ||
        ts.backendState === "NoState" ||
        ts.backendState === "Stopped"
      ) {
        const key = readEnvValue(paths.hermesEnv, AUTHKEY_ENV);
        if (key) {
          log("info", "joining the tailnet with the one-time key from Hermes's .env", {
            hostname: config.hostname,
          });
          const up = await cli(
            [
              "up",
              `--auth-key=${key}`,
              `--hostname=${config.hostname}`,
              "--accept-dns=false",
              "--accept-routes=false",
            ],
            90_000,
          );
          if (up.code !== 0) {
            ts.error = up.stderr.trim().slice(0, 300) || `tailscale up exited ${up.code}`;
            log("error", "tailnet join failed", { error: ts.error });
          } else log("info", "joined the tailnet");
        }
      }
    } catch {
      ts.error = (status.stderr || status.stdout).trim().slice(0, 300) || "tailscale status failed";
    }
  };

  const dial = options.dial ?? [paths.tailscaleCli, "--socket", paths.tailscaleSocket, "nc"];
  for (const peer of config.peers) {
    const forwarder = startForwarder(peer, dial, log);
    const entry = {
      ...peer,
      listening: false,
      online: null as boolean | null,
      stats: forwarder.stats,
    };
    peerStatus.push(entry);
    servers.push(forwarder.server);
    try {
      await forwarder.ready;
      entry.listening = true;
    } catch (error) {
      log("error", "could not listen for a peer", { peer: peer.name, error: String(error) });
    }
  }

  const status = (): LinkStatus => ({
    pid: process.pid,
    startedAt,
    updatedAt: new Date().toISOString(),
    tailscale: { ...ts },
    peers: peerStatus.map((peer) => ({
      name: peer.name,
      loopback: peer.loopback,
      port: peer.port,
      listening: peer.listening,
      online: peer.online,
      ...peer.stats,
    })),
  });
  const writeStatus = () => {
    try {
      const temp = `${paths.status}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(status(), null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, paths.status);
    } catch {
      // status is advisory
    }
  };

  startTailscaled();
  const timer = setInterval(() => {
    void poll().finally(writeStatus);
  }, options.pollMs ?? 15_000);
  setTimeout(() => void poll().finally(writeStatus), 3_000).unref();
  writeStatus();

  const stop = (code = 0): Promise<void> => {
    stopping ??= (async () => {
      log("info", "link stopping", { code });
      clearInterval(timer);
      for (const server of servers) server.close();
      if (tailscaled && tailscaled.exitCode === null) {
        tailscaled.kill("SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        if (tailscaled.exitCode === null) tailscaled.kill("SIGKILL");
      }
      try {
        lock.exec("ROLLBACK");
      } finally {
        lock.close();
      }
      log("info", "link stopped; the tailnet login stays in tailscale/state");
      if (!options.embedded) process.exit(code);
    })();
    return stopping;
  };

  if (!options.embedded) {
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
      process.once(signal, () => void stop(0));
    process.on("uncaughtException", (error) => {
      log("error", "uncaught exception", { error: error.stack ?? String(error) });
      void stop(1);
    });
  }
  return { status, stop };
}

export function readLinkStatus(paths: DevicePaths): LinkStatus | null {
  try {
    const value = JSON.parse(readFileSync(paths.status, "utf8")) as LinkStatus;
    return alive(value.pid) ? value : null;
  } catch {
    return null;
  }
}

/** Starts the link daemon detached (its own session) unless one is already running. */
export async function ensureLink(
  paths: DevicePaths,
  command: string[],
  env: NodeJS.ProcessEnv = process.env,
  waitMs = 20_000,
): Promise<LinkStatus | null> {
  const current = readLinkStatus(paths);
  if (current) return current;
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  const probe = tryLock(paths.lock);
  if (!probe) return readLinkStatus(paths);
  probe.exec("ROLLBACK");
  probe.close();
  const [file, ...args] = command;
  if (!file) return null;
  const keep = [
    "HOME",
    "HERMES_HOME",
    "PATH",
    "LANG",
    "TZ",
    "TMPDIR",
    "ORCA_DEVICE_HOME",
    "ORCA_DEVICE_ENV_FILE",
  ];
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of keep) if (env[key]) childEnv[key] = env[key];
  spawn(file, args, { detached: true, stdio: "ignore", env: childEnv }).unref();
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const status = readLinkStatus(paths);
    if (status) return status;
  }
  return null;
}

export { devicePaths };
