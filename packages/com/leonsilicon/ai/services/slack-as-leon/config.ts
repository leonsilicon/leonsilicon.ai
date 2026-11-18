import type { SlackSession } from "#slack";

export interface SlackAsLeonConfig {
  /** Bearer token MCP clients must send (at least 40 characters). */
  token: string;
  /** The public origin; a browser request from any other Origin is refused. */
  publicOrigin: string;
  /** Leon's Slack web session. */
  session: SlackSession;
  /** Most messages per rolling hour. */
  maxPerHour: number;
  /** Users nobody may reach through this service: no DM, no mention (Silicon Dot, in practice). */
  blockedUsers: readonly string[];
  /** Longest a call may wait for a reply: stays under Hermes Cloud's 180 s MCP timeout. */
  maxWaitSeconds: number;
}

const list = (value: string) =>
  value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

/** Reads the config from the Worker's secrets and vars (or any string map). */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): SlackAsLeonConfig {
  const token = env.SLACK_AS_LEON_MCP_TOKEN ?? "";
  if (token.length < 40)
    throw new Error("SLACK_AS_LEON_MCP_TOKEN must be a strong token (40+ characters)");
  const sessionToken = env.SLACK_SESSION_TOKEN ?? "";
  const cookie = env.SLACK_SESSION_COOKIE ?? "";
  if (!sessionToken.startsWith("xoxc-"))
    throw new Error("SLACK_SESSION_TOKEN must be Leon's xoxc- web session token");
  if (!cookie) throw new Error("SLACK_SESSION_COOKIE (the d cookie) is required");
  // Silicon Dot (ChatGPT) acts on Leon's own messages, so Hermes must keep using its own channel
  // there. Its ID is private, so it comes from the environment; an empty list allows everyone.
  const blocked = env.SLACK_AS_LEON_BLOCKED_USERS;
  if (blocked === undefined)
    throw new Error("SLACK_AS_LEON_BLOCKED_USERS is required (comma-separated Slack user IDs)");
  return {
    token,
    publicOrigin: new URL(env.SLACK_AS_LEON_PUBLIC_ORIGIN ?? "https://slack-as-leon.leonsilicon.ai")
      .origin,
    session: { token: sessionToken, cookie },
    maxPerHour: Number(env.SLACK_AS_LEON_MAX_PER_HOUR ?? 30),
    blockedUsers: list(blocked),
    maxWaitSeconds: Math.min(Number(env.SLACK_AS_LEON_MAX_WAIT_SECONDS ?? 150), 165),
  };
}
