import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Server,
  StdioServerTransport,
} from "@-/com.npmjs.modelcontextprotocol__sdk";
import { ensureDaemon, type DaemonLauncher } from "#client";
import type { McpExtension } from "#extension";
import { VERSION } from "#inbox";
import { callIpc, IpcError } from "#ipc";
import { ensureDirectories, inboxPaths } from "#paths";
import { INSTRUCTIONS, TOOLS } from "#tools";

/**
 * The stdio MCP server Hermes starts (`mcp_servers.beeper-inbox`). It holds no Matrix state: every call
 * goes to the daemon over its socket, so any number of Hermes processes can run one of these while the
 * crypto store keeps a single writer. It also starts the daemon when Hermes starts, and checks on it
 * every minute, so background sync survives gateway restarts and machine restarts.
 *
 * With an `extension` it serves that extension's tools instead (`mcp_servers.slack22grokbot` runs
 * `beeper-inbox.mjs mcp slack22grokbot`), through the same daemon.
 */
export async function runMcpServer(
  launcher: DaemonLauncher,
  env: NodeJS.ProcessEnv = process.env,
  extension?: McpExtension,
): Promise<void> {
  const paths = inboxPaths(env);
  ensureDirectories(paths);
  const server = new Server(
    extension
      ? { name: extension.server.name, version: extension.server.version }
      : { name: "beeper-inbox", version: VERSION },
    {
      capabilities: { tools: {} },
      instructions: extension ? extension.server.instructions : INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (extension ? extension.server.tools : TOOLS).map((tool) => ({ ...tool })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      await ensureDaemon(paths, launcher);
      const call = { name: request.params.name, arguments: request.params.arguments ?? {} };
      const result = (await (extension
        ? callIpc(paths.socket, "extension", { extension: extension.name, ...call }, 175_000)
        : callIpc(paths.socket, "tool", call, 175_000))) as Record<string, unknown>;
      return {
        // An extension reports a refused call as `ok: false` (slack22grokbot's budget, for example).
        ...(result.ok === false ? { isError: true } : {}),
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 1) }],
        structuredContent: result,
      };
    } catch (error) {
      const err = error as { code?: unknown; message?: unknown; data?: unknown };
      const body = {
        error: {
          code: typeof err.code === "string" ? err.code : "error",
          message: String(err.message ?? error),
          ...(err.data !== undefined ? { data: err.data } : {}),
        },
      };
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify(body, null, 1) }],
      };
    }
  });

  const heartbeat = setInterval(() => {
    void ensureDaemon(paths, launcher).catch(() => undefined);
  }, 60_000);
  heartbeat.unref();
  void ensureDaemon(paths, launcher).catch((error: unknown) => {
    process.stderr.write(
      `beeper-inbox: daemon not reachable yet: ${error instanceof IpcError ? error.message : String(error)}\n`,
    );
  });

  // Hermes closing stdin ends this adapter only; the daemon keeps the device's session.
  server.onclose = () => process.exit(0);
  process.stdin.on("end", () => process.exit(0));
  await server.connect(new StdioServerTransport());
}
