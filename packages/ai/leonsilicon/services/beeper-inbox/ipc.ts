import { chmodSync, rmSync } from "node:fs";
import net from "node:net";
import type { Logger } from "#types";

/**
 * Newline-delimited JSON over the daemon's Unix socket (in the owner-only state directory). Every MCP
 * server process and the CLI are clients; the daemon is the only server. Payloads are small: files
 * travel as paths on the shared volume, never as bytes.
 */

const MAX_LINE = 4 * 1024 * 1024;

export interface IpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

export type IpcHandler = (method: string, params: unknown) => Promise<unknown>;

export class IpcError extends Error {
  readonly code: string;
  readonly data: unknown;

  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.name = "IpcError";
    this.code = code;
    this.data = data;
  }
}

/** Binds the socket. Call only while holding the owner lock, which makes removing a stale socket safe. */
export async function serveIpc(
  socketPath: string,
  handler: IpcHandler,
  log: Logger,
): Promise<net.Server> {
  rmSync(socketPath, { force: true });
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE) {
        socket.destroy();
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line.trim()) void respond(socket, line, handler, log);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(socketPath, 0o600);
  return server;
}

async function respond(
  socket: net.Socket,
  line: string,
  handler: IpcHandler,
  log: Logger,
): Promise<void> {
  let request: IpcRequest;
  try {
    request = JSON.parse(line) as IpcRequest;
  } catch {
    return;
  }
  let reply: Record<string, unknown>;
  try {
    reply = { id: request.id, ok: true, result: await handler(request.method, request.params) };
  } catch (error) {
    const err = error as { code?: unknown; data?: unknown; message?: unknown };
    const code = typeof err.code === "string" ? err.code : "internal_error";
    if (code === "internal_error")
      log("error", "ipc handler failed", {
        method: request.method,
        error: String(err.message ?? error),
      });
    reply = {
      id: request.id,
      ok: false,
      error: { code, message: String(err.message ?? error), data: err.data },
    };
  }
  if (!socket.destroyed) socket.write(`${JSON.stringify(reply)}\n`);
}

/** One request on a fresh connection. Throws IpcError `daemon_unreachable` when nothing listens. */
export function callIpc(
  socketPath: string,
  method: string,
  params?: unknown,
  timeoutMs = 120_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new IpcError(
              "daemon_timeout",
              `beeper-inbox daemon did not answer ${method} within ${timeoutMs} ms`,
            ),
          ),
        ),
      timeoutMs,
    );
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: 1, method, params })}\n`));
    socket.on("error", (error: NodeJS.ErrnoException) => {
      const unreachable = error.code === "ENOENT" || error.code === "ECONNREFUSED";
      finish(() =>
        reject(new IpcError(unreachable ? "daemon_unreachable" : "ipc_error", error.message)),
      );
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const reply = JSON.parse(buffer.slice(0, newline)) as {
        ok: boolean;
        result?: unknown;
        error?: { code: string; message: string; data?: unknown };
      };
      finish(() =>
        reply.ok
          ? resolve(reply.result)
          : reject(
              new IpcError(
                reply.error?.code ?? "error",
                reply.error?.message ?? "error",
                reply.error?.data,
              ),
            ),
      );
    });
    socket.on("close", () =>
      finish(() =>
        reject(
          new IpcError(
            "daemon_closed",
            `beeper-inbox daemon closed the connection during ${method}`,
          ),
        ),
      ),
    );
  });
}
