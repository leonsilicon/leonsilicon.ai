import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { beeperSource } from "#beeper";
import { Feed, type FeedWake } from "#feed";
import { createListener } from "#mcp";
import { decisionsScreener } from "#screen";
import { slackPoster } from "#slack";
import { WatchStore } from "#store";
import type { BeeperFeedSource, BeeperSource, Logger } from "#types";
import { Watcher } from "#watcher";

/** What only the stand-alone service needs: Beeper Desktop, and its own HTTP MCP endpoint. */
export interface BeeperWatchConfig extends CoreConfig {
  beeperURL: string;
  beeperTokenFile: string;
  mcpToken: string;
  publicOrigin: string;
  port: number;
}

/** The settings of the watcher and the feed themselves, wherever they run. */
export interface CoreConfig {
  slackBotToken: string;
  hermesUserId: string;
  defaultChannel: string;
  /** Log what would be posted to Slack instead of posting it, for a trial run beside the live one. */
  dryRun: boolean;
  stateFile: string;
  pollMs: number;
  quietMs: number;
  maxBatchMs: number;
  /**
   * The every-message feed posts each Beeper connection to `<feedChannelPrefix><platform>`, such as
   * #feed-whatsapp, creating channels as needed; null turns the feed off.
   */
  feedChannelPrefix: string | null;
  /** A channel name or ID for some platforms, instead of the prefixed name. */
  feedPlatformChannels: Record<string, string>;
  /** Slack users added to the feed channels Beeper Watch creates, besides Hermes. */
  feedInvite: string[];
  feedWake: FeedWake;
  feedStateFile: string;
  /** Beeper account ID prefixes never copied, on top of this Slack workspace's own account. */
  feedExcludeAccounts: string[];
  /** Networks or account prefixes whose messages never wake Hermes (lowercase). */
  feedQuietNetworks: string[];
  /** "openai" screens messages from people before Hermes sees them; "off" posts them unscreened. */
  screen: "openai" | "off";
  flaggedChannel: string;
  spamChannel: string;
  /** Safe messages from chats Leon muted can wake Hermes too. */
  screenWakeMuted: boolean;
  /** OpenAI API key for the Decisions API; required when `screen` is "openai". */
  openaiApiKey: string | null;
  screenModel: string;
  screenTimeoutMs: number;
  /** Held as unsafe at this summed probability of the unsafe reasons. */
  screenUnsafeThreshold: number;
  /** Safe messages wake Hermes at this probability that it should know about them. */
  screenWakeThreshold: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BeeperWatchConfig {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const mcpToken = required("MCP_TOKEN");
  if (mcpToken.length < 40) throw new Error("MCP_TOKEN must be at least 40 characters");
  return {
    ...loadCoreConfig(env),
    beeperURL: env.BEEPER_URL ?? "http://127.0.0.1:23373",
    beeperTokenFile: required("BEEPER_TOKEN_FILE"),
    mcpToken,
    publicOrigin: required("PUBLIC_ORIGIN"),
    port: Number(env.PORT ?? 18789),
  };
}

export function loadCoreConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const seconds = (name: string, fallback: number): number => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
    return value * 1000;
  };
  const fraction = (name: string, fallback: number): number => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isFinite(value) || value <= 0 || value > 1)
      throw new Error(`${name} must be a number above 0 and at most 1`);
    return value;
  };
  const screen = screenMode(env.FEED_SCREEN);
  // Until 2026-11-18 one FEED_CHANNEL held the whole feed; FEED_CHANNEL=off must not turn it back on.
  if (env.FEED_CHANNEL !== undefined)
    throw new Error(
      "FEED_CHANNEL was replaced by FEED_CHANNEL_PREFIX (feed-, or off), one channel per connection",
    );
  return {
    slackBotToken: required("SLACK_BOT_TOKEN"),
    hermesUserId: required("HERMES_SLACK_USER_ID"),
    defaultChannel: env.DEFAULT_SLACK_CHANNEL ?? "home",
    dryRun: /^(1|true|yes|on)$/i.test(env.DRY_RUN ?? ""),
    stateFile: env.STATE_FILE ?? path.join(os.homedir(), ".local/share/beeper-watch/watches.json"),
    pollMs: seconds("POLL_SECONDS", 10),
    quietMs: seconds("QUIET_SECONDS", 30),
    maxBatchMs: seconds("MAX_BATCH_SECONDS", 120),
    feedChannelPrefix: feedChannelPrefix(env.FEED_CHANNEL_PREFIX),
    feedPlatformChannels: pairs("FEED_PLATFORM_CHANNELS", env.FEED_PLATFORM_CHANNELS),
    feedInvite: list(env.FEED_INVITE),
    feedWake: feedWake(env.FEED_WAKE),
    feedStateFile:
      env.FEED_STATE_FILE ?? path.join(os.homedir(), ".local/share/beeper-watch/feed.json"),
    feedExcludeAccounts: list(env.FEED_EXCLUDE_ACCOUNTS),
    feedQuietNetworks: list(
      env.FEED_QUIET_NETWORKS ?? "grokbot,grok bot,muse,chatgpt-dots,chatgpt dots",
    ).map((name) => name.toLowerCase()),
    screen,
    flaggedChannel: env.FEED_FLAGGED_CHANNEL?.trim() || "feed-flagged",
    spamChannel: env.FEED_SPAM_CHANNEL?.trim() || "feed-spam",
    screenWakeMuted: /^(1|true|yes|on)$/i.test(env.SCREEN_WAKE_MUTED ?? ""),
    openaiApiKey: screen === "openai" ? required("OPENAI_API_KEY") : null,
    screenModel: env.SCREEN_MODEL?.trim() || "gpt-6-luna",
    screenTimeoutMs: seconds("SCREEN_TIMEOUT_SECONDS", 30),
    screenUnsafeThreshold: fraction("SCREEN_UNSAFE_THRESHOLD", 0.3),
    screenWakeThreshold: fraction("SCREEN_WAKE_THRESHOLD", 0.5),
  };
}

function screenMode(value: string | undefined): "openai" | "off" {
  const mode = (value ?? "off").trim().toLowerCase();
  if (mode === "openai" || mode === "off") return mode;
  throw new Error("FEED_SCREEN must be openai or off");
}

function feedChannelPrefix(value: string | undefined): string | null {
  const prefix = (value ?? "feed-").trim().replace(/^#/, "").toLowerCase();
  if (prefix === "off") return null;
  if (!/^[a-z0-9_-]*$/.test(prefix))
    throw new Error("FEED_CHANNEL_PREFIX may hold only lowercase letters, digits, - and _");
  return prefix;
}

/** `whatsapp=feed-wa,x=C0123` → { whatsapp: "feed-wa", x: "C0123" } */
function pairs(name: string, value: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of list(value)) {
    const [key, channel] = item.split("=").map((part) => part.trim());
    if (!key || !channel) throw new Error(`${name} entries look like platform=channel`);
    result[key.toLowerCase()] = channel.replace(/^#/, "");
  }
  return result;
}

function feedWake(value: string | undefined): FeedWake {
  const wake = (value ?? "people").trim().toLowerCase();
  if (wake === "people" || wake === "all" || wake === "none") return wake;
  throw new Error("FEED_WAKE must be people, all or none");
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export const jsonLogger: Logger = (level, message, fields) => {
  const line = JSON.stringify({ at: new Date().toISOString(), level, message, ...fields });
  if (level === "info") console.log(line);
  else console.error(line);
};

/**
 * A Slack poster that posts nothing: it looks channels up, creates none, and logs what would have
 * gone out. For running a second Beeper Watch beside the live one, to compare what each picks up.
 */
function dryRunPoster(real: ReturnType<typeof slackPoster>, log: Logger): typeof real {
  let posts = 0;
  const lookup = async (nameOrId: string) => {
    try {
      return await real.channel(nameOrId);
    } catch {
      return { id: `dry-${nameOrId}`, name: nameOrId, isPrivate: false, isMember: true };
    }
  };
  return {
    identity: () => real.identity(),
    channel: lookup,
    ensureChannel: lookup,
    post: async (channel, text, threadTs) => {
      posts += 1;
      log("info", "dry run: would post", {
        channel,
        chars: text.length,
        thread: Boolean(threadTs),
        mentions: /<@[A-Z0-9]+>/.test(text),
      });
      return { ts: `dry.${posts}` };
    },
  };
}

export interface BeeperWatchCore {
  watcher: Watcher;
  feed: Feed | null;
  slackBot: string;
  /** What the feed and the screener are set to, for the start-up log line. */
  summary: { feed: string; screener: string };
  health(): Record<string, unknown>;
  stop(): Promise<void>;
}

/**
 * The watcher and the feed, polling a Beeper source and posting to Slack. The source decides where
 * Beeper is read: Beeper Desktop for the stand-alone service, the inbox's journal on Hermes Cloud.
 */
export async function createBeeperWatch({
  config,
  beeper,
  log = jsonLogger,
}: {
  config: CoreConfig;
  beeper: BeeperSource & BeeperFeedSource;
  log?: Logger;
}): Promise<BeeperWatchCore> {
  const real = slackPoster(config.slackBotToken);
  const slack = config.dryRun ? dryRunPoster(real, log) : real;
  const identity = await slack.identity();
  const store = new WatchStore(config.stateFile, log);
  const screener =
    config.screen === "openai" && config.openaiApiKey
      ? decisionsScreener({
          apiKey: config.openaiApiKey,
          model: config.screenModel,
          timeoutMs: config.screenTimeoutMs,
          thresholds: { unsafe: config.screenUnsafeThreshold, wake: config.screenWakeThreshold },
          log,
        })
      : null;
  const agentNetwork = (network: string) =>
    config.feedQuietNetworks.includes(network.trim().toLowerCase());
  const watcher = new Watcher({
    store,
    beeper,
    slack,
    hermesUserId: config.hermesUserId,
    defaultChannel: config.defaultChannel,
    quietMs: config.quietMs,
    maxBatchMs: config.maxBatchMs,
    screening: screener
      ? {
          screener,
          flaggedChannel: config.flaggedChannel,
          spamChannel: config.spamChannel,
          trusted: agentNetwork,
        }
      : null,
    log,
  });

  const feed =
    config.feedChannelPrefix !== null
      ? new Feed({
          beeper,
          slack,
          log,
          channelPrefix: config.feedChannelPrefix,
          platformChannels: config.feedPlatformChannels,
          invite: config.feedInvite,
          hermesUserId: config.hermesUserId,
          stateFile: config.feedStateFile,
          wake: config.feedWake,
          screening: screener
            ? {
                screener,
                flaggedChannel: config.flaggedChannel,
                spamChannel: config.spamChannel,
                wakeMuted: config.screenWakeMuted,
              }
            : null,
          // This workspace's own Slack account in Beeper: its messages are already in Slack, and
          // copying them would loop back through Beeper's Slack bridge.
          excludeAccounts: [
            ...(identity.teamId ? [`slackgo.${identity.teamId}`] : []),
            ...config.feedExcludeAccounts,
          ],
          quietNetworks: config.feedQuietNetworks,
          watchedChats: () => new Set(store.list().map((watch) => watch.chatID)),
          quietMs: config.quietMs,
          maxBatchMs: config.maxBatchMs,
        })
      : null;

  let stopped = false;
  let feedError: string | null = null;
  let watchError: string | null = null;
  const startedAt = new Date().toISOString();
  const loop = (async () => {
    while (!stopped) {
      const started = Date.now();
      try {
        await watcher.tick();
        watchError = null;
      } catch (error) {
        watchError = (error as Error).message;
        log("error", "poll failed", { error: watchError });
      }
      if (feed) {
        try {
          await feed.tick();
          if (feedError) log("info", "feed recovered");
          feedError = null;
        } catch (error) {
          const message = (error as Error).message;
          if (feedError !== message) log("error", "feed poll failed", { error: message });
          feedError = message;
        }
      }
      await sleep(Math.max(1000, config.pollMs - (Date.now() - started)));
    }
  })();

  return {
    watcher,
    feed,
    slackBot: identity.userId,
    summary: {
      feed:
        config.feedChannelPrefix === null
          ? "off"
          : `#${config.feedChannelPrefix}<platform>, created as needed${
              screener
                ? `; people's messages screened (wake Hermes when it should know), held in ${config.flaggedChannel} and ${config.spamChannel}`
                : ` (wake: ${config.feedWake})`
            }`,
      screener: screener
        ? `OpenAI Decisions ${config.screenModel} (unsafe ≥ ${config.screenUnsafeThreshold}, wake ≥ ${config.screenWakeThreshold})`
        : "off",
    },
    health: () => ({
      started_at: startedAt,
      dry_run: config.dryRun,
      watches: store.list().length,
      watch_error: watchError,
      feed: feed ? { ...feed.health(), error: feedError } : "off",
    }),
    async stop(): Promise<void> {
      stopped = true;
      await loop;
    },
  };
}

/** Starts polling watched Beeper chats and serving the MCP tools. Resolves once both are running. */
export async function startBeeperWatch(
  config: BeeperWatchConfig = loadConfig(),
  log: Logger = jsonLogger,
) {
  const core = await createBeeperWatch({
    config,
    beeper: beeperSource({ baseURL: config.beeperURL, tokenFile: config.beeperTokenFile }),
    log,
  });
  const listener = createListener({
    watcher: core.watcher,
    feed: core.feed,
    token: config.mcpToken,
    publicOrigin: config.publicOrigin,
    log,
  });
  listener.requestTimeout = 60_000;
  await new Promise<void>((resolve) => listener.listen(config.port, "127.0.0.1", resolve));
  log("info", "beeper-watch started", {
    listening: `127.0.0.1:${config.port}`,
    slackBot: core.slackBot,
    watches: core.watcher.list().length,
    ...core.summary,
  });

  return {
    watcher: core.watcher,
    async stop(): Promise<void> {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      await core.stop();
    },
  };
}
