import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { DaemonExtension } from "@-/ai.leonsilicon.services.beeper-inbox";
import { inboxBackend } from "#backend";
import { bridgeServices } from "#bridge-services";
import { createBoxKeeper } from "#grok-box";
import { createGrokDelegation } from "#relay";
import { Slack22GrokBot } from "#slack22grokbot";
import { callTool, INSTRUCTIONS, TOOLS } from "#tools";

export const VERSION = "1.7.0";
const NAME = "slack22grokbot";
const POLL_MS = 15_000;
const BOX_EVERY_MS = 60_000;

/**
 * The relay as an extension of Hermes's Beeper inbox daemon: `beeper-inbox.mjs mcp slack22grokbot` is its
 * MCP server. It runs inside the daemon because the queue, the budget and the flusher need exactly
 * one owner, and Hermes starts an MCP server in several processes at once.
 */
export function slack22GrokBotExtension(): DaemonExtension {
  return {
    name: NAME,
    server: { name: NAME, version: VERSION, instructions: INSTRUCTIONS, tools: TOOLS },
    start(context) {
      const backend = inboxBackend((name, args) => context.tool(name, args), context.journal);
      const log = ({ event, ...fields }: Record<string, unknown>) =>
        context.log(
          typeof event === "string" && event.endsWith("_error") ? "warn" : "info",
          typeof event === "string" ? event : "event",
          fields,
        );
      let bridge: Slack22GrokBot | undefined;
      let problem: string | undefined;
      try {
        const env = parseEnv(readFileSync(join(context.home, "slack22grokbot.env"), "utf8"));
        bridge = new Slack22GrokBot({
          backend,
          journal: context.journal,
          services: bridgeServices(env),
          stateFile: join(context.home, "slack22grokbot.json"),
          hermesUserId: env.SLACK_HERMES_USER_ID,
          log,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") problem = "no settings file";
        else {
          problem = (error as Error).message;
          log({ event: "slack22grokbot_config_error", message: problem });
        }
      }
      // Keeps grok-box-browser set up in the Grok Bot cloud computer (grok-box.ts).
      const keeper = createBoxKeeper({
        stateFile: join(context.home, "state", "grok-box.json"),
        log,
      });
      const relay = createGrokDelegation({
        stateDir: join(context.home, "state"),
        backend,
        bridge,
        log,
        upkeep: () => keeper.upkeep(),
      });
      let stopped = false;
      let active = Promise.resolve();
      let timer: NodeJS.Timeout | undefined;
      const poll = (configured: Slack22GrokBot): void => {
        active = configured
          .tick()
          .then(
            () => {
              problem = undefined;
            },
            (error: Error) => {
              if (problem !== error.message)
                log({ event: "slack22grokbot_cycle_error", message: error.message });
              problem = error.message;
            },
          )
          .finally(() => {
            if (!stopped) timer = setTimeout(poll, POLL_MS, configured);
          });
      };
      if (bridge) poll(bridge);
      let boxActive = Promise.resolve();
      const boxTimer = setInterval(() => {
        boxActive = keeper
          .tick((bot, text) => relay.direct(bot, text))
          .catch((error: Error) => log({ event: "grok_box_tick_error", message: error.message }));
      }, BOX_EVERY_MS);
      boxTimer.unref();
      return {
        callTool: (name, args) => callTool(relay, name, args),
        status: () => ({
          running: Boolean(bridge),
          ...bridge?.status(),
          ...(problem ? { problem } : {}),
          grokBox: keeper.status(),
        }),
        async stop() {
          stopped = true;
          clearTimeout(timer);
          clearInterval(boxTimer);
          relay.stop();
          await active;
          await boxActive;
        },
      };
    },
  };
}
