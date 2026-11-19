import { readFileSync } from "node:fs";
import { daemonPid, ensureDaemon, stopDaemon, type DaemonLauncher } from "#client";
import { EXIT_ALREADY_OWNED, fileLogger, startDaemon } from "#daemon";
import { callIpc } from "#ipc";
import { runMcpServer } from "#mcp";
import { ensureDirectories, inboxPaths } from "#paths";
import { readAccount, writeJsonAtomic } from "#secrets";

export const USAGE = `beeper-inbox <command>

  mcp                    stdio MCP server (what Hermes runs)
  daemon                 the store owner (started by mcp/start; exits 75 if one is running)
  start                  start the daemon if needed and print its status
  status                 print the daemon's status (doesn't start it)
  stop                   stop the daemon (the device stays signed in)
  restart                stop, then start
  reload                 re-read the account and secrets in the running daemon
  refresh-directory      rebuild the conversation directory
  install-account FILE   install a device's account.json (homeserver, userId, deviceId; no secrets)
  tool NAME [JSON]       call one tool through the daemon, as Hermes would
`;

export async function runCli(
  argv: readonly string[],
  entry: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const [command, ...rest] = argv;
  const launcher: DaemonLauncher = { command: [process.execPath, entry, "daemon"], env };
  const paths = inboxPaths(env);
  const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  switch (command) {
    case "mcp":
      await runMcpServer(launcher, env);
      return -1; // keeps running
    case "daemon": {
      try {
        const daemon = await startDaemon({ env });
        if (!daemon) return EXIT_ALREADY_OWNED;
      } catch (error) {
        // Started detached with no stderr: the log file is the only place this can go.
        ensureDirectories(paths);
        fileLogger(paths.logFile, "daemon")("error", "daemon failed to start", {
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
        return 1;
      }
      return -1;
    }
    case "start":
      await ensureDaemon(paths, launcher);
      print(await callIpc(paths.socket, "status", undefined, 120_000));
      return 0;
    case "status":
      print(await callIpc(paths.socket, "status", undefined, 120_000));
      return 0;
    case "stop":
      print(await stopDaemon(paths));
      return 0;
    case "restart": {
      const before = daemonPid(paths);
      const stopped = await stopDaemon(paths);
      await ensureDaemon(paths, launcher);
      print({
        previous_pid: before,
        stopped: stopped.stopped,
        status: await callIpc(paths.socket, "status", undefined, 120_000),
      });
      return 0;
    }
    case "reload":
      await ensureDaemon(paths, launcher);
      print(await callIpc(paths.socket, "reload", undefined, 170_000));
      return 0;
    case "refresh-directory":
      await ensureDaemon(paths, launcher);
      print(await callIpc(paths.socket, "refresh_directory", undefined, 200_000));
      return 0;
    case "install-account": {
      const file = rest[0];
      if (!file) throw new Error("install-account needs a file");
      ensureDirectories(paths);
      const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      for (const key of ["accessToken", "access_token", "password", "recoveryKey", "pickleKey"]) {
        if (key in value)
          throw new Error(
            `account files hold no secrets; remove ${key} (secrets go in Hermes's .env)`,
          );
      }
      writeJsonAtomic(paths.account, value, 0o600);
      print({ installed: readAccount(paths.account) });
      return 0;
    }
    case "tool": {
      const name = rest[0];
      if (!name) throw new Error("tool needs a name");
      const args = rest[1] ? (JSON.parse(rest[1]) as unknown) : {};
      await ensureDaemon(paths, launcher);
      print(await callIpc(paths.socket, "tool", { name, arguments: args }, 175_000));
      return 0;
    }
    default:
      process.stderr.write(USAGE);
      return command ? 64 : 0;
  }
}
