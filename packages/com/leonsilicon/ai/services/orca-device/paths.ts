import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Everything lives under `$ORCA_DEVICE_HOME` (default `$HERMES_HOME/orca-device`, i.e.
 * `/opt/data/orca-device` on Hermes Cloud's persistent volume):
 *
 * - `bin/orca`: the Orca CLI wrapper (Linux Orca CLI on Orca's own pinned Node).
 * - `data/`: the Orca profile: the pairing store and device keys for the paired Macs (0700).
 * - `tailscale/`: userspace Tailscale (`bin/`, `state/`, `tailscaled.sock`).
 * - `device.json`: which Macs to reach and how (tailnet addresses live only here, not in the repo).
 * - `state/`: the link daemon's lock and status.
 */
export interface DevicePaths {
  home: string;
  hermesEnv: string;
  orca: string;
  data: string;
  config: string;
  state: string;
  lock: string;
  status: string;
  logs: string;
  linkLog: string;
  tailscaledLog: string;
  tailscale: string;
  tailscaleCli: string;
  tailscaled: string;
  tailscaleState: string;
  tailscaleSocket: string;
  tailscaledPid: string;
}

export function devicePaths(env: NodeJS.ProcessEnv = process.env): DevicePaths {
  const hermesHome = env.HERMES_HOME || env.HOME || "/opt/data";
  const home = env.ORCA_DEVICE_HOME || join(hermesHome, "orca-device");
  const tailscale = join(home, "tailscale");
  const state = join(home, "state");
  const logs = join(home, "logs");
  return {
    home,
    hermesEnv: env.ORCA_DEVICE_ENV_FILE || join(hermesHome, ".env"),
    orca: join(home, "bin", "orca"),
    data: join(home, "data"),
    config: join(home, "device.json"),
    state,
    lock: join(state, "link.lock"),
    status: join(state, "link-status.json"),
    logs,
    linkLog: join(logs, "link.log"),
    tailscaledLog: join(logs, "tailscaled.log"),
    tailscale,
    tailscaleCli: join(tailscale, "bin", "tailscale"),
    tailscaled: join(tailscale, "bin", "tailscaled"),
    tailscaleState: join(tailscale, "state"),
    tailscaleSocket: join(tailscale, "tailscaled.sock"),
    tailscaledPid: join(state, "tailscaled.pid"),
  };
}

/** One Mac whose Orca this device pairs with. */
export interface Peer {
  /** The Orca environment name, as `--environment` takes it ("MacBook", "Mac mini"). */
  name: string;
  /** Its tailnet address. */
  address: string;
  /** Its Orca port (6768 unless that Orca picked another). */
  port: number;
  /** The loopback address this device dials for it; the pairing offer advertises this. */
  loopback: string;
}

export interface DeviceConfig {
  /** The device's tailnet hostname. */
  hostname: string;
  peers: Peer[];
  /** Environment used when a command names none (the bridge's "default is the mini"). */
  defaultEnvironment: string;
  /** orca-mcp's allowed repo roots, as paths on the default Mac (colon-separated). */
  mcpRoots: string;
  /** orca-mcp's owner tag for the workers it starts. */
  mcpClient: string;
}

export function readDeviceConfig(path: string): DeviceConfig {
  if (!existsSync(path)) throw new Error(`${path} is missing`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<DeviceConfig>;
  const peers = (raw.peers ?? []).map((peer) => {
    if (!peer.name || !peer.address || !peer.loopback)
      throw new Error(`${path}: every peer needs name, address and loopback`);
    if (!/^127\.\d+\.\d+\.\d+$/.test(peer.loopback))
      throw new Error(`${path}: ${peer.name}'s loopback must be a 127.x.y.z address`);
    return {
      name: peer.name,
      address: peer.address,
      port: Number(peer.port ?? 6768),
      loopback: peer.loopback,
    };
  });
  return {
    hostname: raw.hostname || "hermes-cloud",
    peers,
    defaultEnvironment: raw.defaultEnvironment || peers[0]?.name || "",
    mcpRoots: raw.mcpRoots ?? "",
    mcpClient: raw.mcpClient || "hermes-cloud",
  };
}

/** Reads only the wanted KEY=value lines of Hermes's .env. */
export function readEnvValue(path: string, key: string): string | null {
  if (!existsSync(path)) return null;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw.trim());
    if (match?.[1] !== key) continue;
    const value = (match[2] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
    return value || null;
  }
  return null;
}
