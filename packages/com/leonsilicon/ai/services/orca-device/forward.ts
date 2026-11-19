import { spawn } from "node:child_process";
import net from "node:net";
import type { Peer } from "#paths";

export type Log = (
  level: "info" | "warn" | "error",
  message: string,
  fields?: Record<string, unknown>,
) => void;

export interface ForwarderStats {
  connections: number;
  failures: number;
  lastError: string | null;
  lastConnectedAt: number | null;
}

/**
 * A loopback listener for one Mac: every connection to `peer.loopback:peer.port` is carried to
 * `peer.address:peer.port` over the tailnet by `tailscale nc`. Userspace Tailscale has no kernel
 * route to tailnet addresses, so this is how the Orca CLI's WebSocket reaches the Mac, and the
 * pairing offer advertises the loopback address.
 *
 * `dial` is the command prefix that is given the host and port (normally
 * `[tailscale, --socket, <sock>, nc]`); tests pass a stand-in.
 */
export function startForwarder(
  peer: Peer,
  dial: readonly string[],
  log: Log,
): { server: net.Server; stats: ForwarderStats; ready: Promise<void> } {
  const stats: ForwarderStats = {
    connections: 0,
    failures: 0,
    lastError: null,
    lastConnectedAt: null,
  };
  const [command, ...prefix] = dial;
  if (!command) throw new Error("no dial command");
  const server = net.createServer((socket) => {
    stats.connections += 1;
    const child = spawn(command, [...prefix, peer.address, String(peer.port)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let gotData = false;
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-500);
    });
    child.stdout.once("data", () => {
      gotData = true;
      stats.lastConnectedAt = Date.now();
    });
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
    const finish = () => {
      socket.destroy();
      if (child.exitCode === null) child.kill("SIGTERM");
    };
    socket.on("error", finish);
    socket.on("close", finish);
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => {
      stats.failures += 1;
      stats.lastError = error.message;
      finish();
    });
    child.on("exit", (code) => {
      if (code !== 0 && !gotData) {
        stats.failures += 1;
        stats.lastError = stderr.trim() || `exit ${code}`;
        log("warn", "tailnet dial failed", { peer: peer.name, code, error: stats.lastError });
      }
      socket.end();
    });
  });
  const ready = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(peer.port, peer.loopback, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { server, stats, ready };
}
