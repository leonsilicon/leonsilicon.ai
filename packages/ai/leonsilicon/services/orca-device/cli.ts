import { ensureLink, EXIT_ALREADY_RUNNING, readLinkStatus, startLink } from "#link";
import { runMcpServer } from "#mcp";
import { devicePaths } from "#paths";

export const USAGE = `orca-device <command>

  mcp       stdio MCP server (what Hermes runs as "orca")
  link      the tailnet link daemon (started by mcp/start; exits 75 if one is running)
  start     start the link if needed and print its status
  status    print the link's status (doesn't start it)
  stop      stop the link (the tailnet login stays)
`;

export async function runCli(
  argv: readonly string[],
  entry: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const [command] = argv;
  const paths = devicePaths(env);
  const linkCommand = [process.execPath, entry, "link"];
  const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  switch (command) {
    case "mcp":
      await runMcpServer(linkCommand, env);
      return -1;
    case "link":
      return (await startLink({ env })) ? -1 : EXIT_ALREADY_RUNNING;
    case "start":
      print(
        (await ensureLink(paths, linkCommand, env)) ?? {
          error: `the link didn't start; see ${paths.linkLog}`,
        },
      );
      return 0;
    case "status":
      print(readLinkStatus(paths) ?? { running: false });
      return 0;
    case "stop": {
      const status = readLinkStatus(paths);
      if (status) process.kill(status.pid, "SIGTERM");
      print({ stopped: Boolean(status), pid: status?.pid ?? null });
      return 0;
    }
    default:
      process.stderr.write(USAGE);
      return command ? 64 : 0;
  }
}
