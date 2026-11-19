import type { FeedConfig, FeedWake } from "#feed";
import type { GmailCredentials } from "#gmail";

export interface GmailFeedConfig {
  google: GmailCredentials;
  slackBotToken: string;
  openaiApiKey: string;
  feed: FeedConfig;
  screen: { model: string; timeoutMs: number; unsafe: number; wake: number };
}

const required = (env: Record<string, string | undefined>, name: string): string => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const number = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Reads the Worker's env: the `#gmail-feed` items of the root .env.schema (Gmail's OAuth client and
 * refresh token, the admin token), plus the feed bot's Slack token, the OpenAI key and the held
 * channels it shares with Beeper Watch.
 */
export function loadConfig(env: Record<string, string | undefined>): GmailFeedConfig {
  const wake = (env.GMAIL_FEED_WAKE ?? "screened").trim() as FeedWake;
  if (wake !== "screened" && wake !== "none")
    throw new Error("GMAIL_FEED_WAKE must be screened or none");
  return {
    google: {
      clientId: required(env, "GMAIL_FEED_GOOGLE_CLIENT_ID"),
      clientSecret: required(env, "GMAIL_FEED_GOOGLE_CLIENT_SECRET"),
      refreshToken: required(env, "GMAIL_FEED_GOOGLE_REFRESH_TOKEN"),
    },
    slackBotToken: required(env, "SLACK_BOT_TOKEN"),
    openaiApiKey: required(env, "OPENAI_API_KEY"),
    feed: {
      channel: (env.GMAIL_FEED_CHANNEL ?? "feed-gmail").trim().replace(/^#/, "") || "feed-gmail",
      flaggedChannel: required(env, "FEED_FLAGGED_CHANNEL"),
      spamChannel: env.GMAIL_FEED_SPAM_CHANNEL?.trim() || required(env, "FEED_SPAM_CHANNEL"),
      hermesUserId: required(env, "HERMES_SLACK_USER_ID"),
      invite: (env.FEED_INVITE ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
      wake,
      maxBody: 40_000,
    },
    screen: {
      model: env.SCREEN_MODEL?.trim() || "gpt-6-luna",
      timeoutMs: number(env.SCREEN_TIMEOUT_SECONDS, 30) * 1000,
      unsafe: number(env.SCREEN_UNSAFE_THRESHOLD, 0.3),
      // Email's own: 0.9 matched 80% of the old Gmail monitor's alerts while waking Hermes for
      // about a quarter of mail (the screener scores most notifications 0.8 or more).
      wake: number(env.GMAIL_FEED_WAKE_THRESHOLD, 0.9),
    },
  };
}
