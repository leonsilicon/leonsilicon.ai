import {
  createServer,
  workerTools,
  type OrcaBridgeConfig,
} from "@-/ai.leonsilicon.services.orca-bridge";
import { StdioServerTransport } from "@-/com.npmjs.modelcontextprotocol__sdk";
import { ensureLink } from "#link";
import { devicePaths, readDeviceConfig } from "#paths";

/**
 * The stdio MCP server Hermes runs as `orca`. The tools are the bridge's (orca_cli, orca_guide,
 * orca_projects and orca-mcp's worker tools), but they call the Orca CLI on Hermes Cloud itself,
 * which is a paired Orca device of each Mac, instead of going through the mini. It starts the link
 * daemon (tailnet and per-Mac forwarders) if it isn't running and checks on it every minute.
 */
export async function runMcpServer(
  linkCommand: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const paths = devicePaths(env);
  const device = readDeviceConfig(paths.config);
  const config: OrcaBridgeConfig = {
    token: "",
    port: 0,
    publicOrigin: "",
    orcaBin: paths.orca,
    workingDirectory: paths.home,
    environments: device.peers
      .map((peer) => peer.name)
      .filter((name) => name !== device.defaultEnvironment),
    maxCallMs: Number(env.ORCA_DEVICE_MAX_CALL_MS ?? 170_000),
    env: {
      PATH: env.PATH,
      HOME: env.HOME,
      ORCA_MCP_ROOTS: device.mcpRoots,
      ORCA_MCP_CLIENT: device.mcpClient,
    },
    host: "hermes-cloud",
  };
  const server = createServer(config, workerTools(config));

  void ensureLink(paths, linkCommand, env).catch(() => undefined);
  const heartbeat = setInterval(
    () => void ensureLink(paths, linkCommand, env).catch(() => undefined),
    60_000,
  );
  heartbeat.unref();

  // Hermes closing stdin ends this server only; the link keeps the tailnet up for the next one.
  server.server.onclose = () => process.exit(0);
  process.stdin.on("end", () => process.exit(0));
  await server.connect(new StdioServerTransport());
}
