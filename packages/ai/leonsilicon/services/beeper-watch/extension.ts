import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { InboxExtension, RunningInboxExtension } from "#inbox";
import { journalSource } from "#journal-source";
import { callTool, INSTRUCTIONS, TOOLS, VERSION } from "#mcp";
import { createBeeperWatch, loadCoreConfig, type BeeperWatchCore } from "#service";
import { UserError } from "#watcher";

/**
 * `KEY=value` lines, as `_env-file` writes them for the mini: a value in single quotes, backticks or
 * double quotes is taken literally, without them.
 */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match?.[1] || line.trimStart().startsWith("#")) continue;
    env[match[1]] = (match[2] ?? "").replace(/^(["'`])(.*)\1$/, "$2");
  }
  return env;
}

/**
 * Beeper Watch as an extension of Hermes Cloud's Beeper inbox daemon: `beeper-inbox.mjs mcp
 * beeper-watch` is its MCP server. It reads Beeper through the inbox's journal, so it needs neither
 * Beeper Desktop nor the Mac mini.
 *
 * Its settings are the same as the stand-alone service's (see the README), in `env` in its own
 * directory. Without that file it stays off and says so.
 */
export function beeperWatchExtension(): InboxExtension {
  return {
    name: "beeper-watch",
    server: { name: "beeper-watch", version: VERSION, instructions: INSTRUCTIONS, tools: TOOLS },
    start(context): RunningInboxExtension {
      const envFile = join(context.home, "env");
      let core: BeeperWatchCore | null = null;
      let problem: string | null = "starting";
      let stopped = false;
      let retry: NodeJS.Timeout | null = null;

      // Slack must answer before it can start; the inbox may still be signing in. Keep trying.
      const boot = async (): Promise<void> => {
        if (stopped || core) return;
        try {
          let text: string;
          try {
            text = readFileSync(envFile, "utf8");
          } catch {
            problem = `not configured: ${envFile} is missing`;
            return; // nothing to retry until the file is put there and the daemon restarts
          }
          const config = loadCoreConfig({
            ...parseEnv(text),
            STATE_FILE: join(context.home, "state", "watches.json"),
            FEED_STATE_FILE: join(context.home, "state", "feed.json"),
          });
          const started = await createBeeperWatch({
            config,
            beeper: journalSource(context, context.log),
            log: context.log,
          });
          if (stopped) return void started.stop();
          core = started;
          problem = null;
          context.log("info", "beeper-watch started", {
            slackBot: started.slackBot,
            watches: started.watcher.list().length,
            dryRun: config.dryRun,
            ...started.summary,
          });
        } catch (error) {
          problem = (error as Error).message;
          context.log("error", "beeper-watch failed to start; trying again in 30 s", {
            error: problem,
          });
          retry = setTimeout(() => void boot(), 30_000);
          retry.unref();
        }
      };
      void boot();

      return {
        async callTool(name, args) {
          if (!core) return { ok: false, error: `Beeper Watch isn't running: ${problem}` };
          try {
            return (await callTool(core.watcher, name, args)) as Record<string, unknown>;
          } catch (error) {
            const known = error instanceof UserError;
            if (!known)
              context.log("error", "tool failed", { tool: name, error: (error as Error).message });
            return {
              ok: false,
              error: known
                ? (error as Error).message
                : `Beeper Watch failed: ${(error as Error).message}`,
            };
          }
        },
        status: () => (core ? core.health() : { running: false, problem }),
        async stop() {
          stopped = true;
          if (retry) clearTimeout(retry);
          await core?.stop();
        },
      };
    },
  };
}
