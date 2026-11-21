/** Settings for autolinear, read from the Worker's vars. */
export interface AutolinearConfig {
  /** The Linear team whose issues it creates, e.g. `LEON`. */
  teamKey: string;
  /** The team's ID, and the ID of `intakeState`. Set, they spare a lookup on a cold start. */
  teamId: string | null;
  intakeStateId: string | null;
  /** The status new issues start in: Linear's default, Awaiting Init. */
  intakeState: string;
  /** Channel names start with this, then the issue number: `leon-401-check-rogers` (Linear Sync's). */
  channelPrefix: string;
  /** Longest channel name to generate (Slack allows 80). */
  channelNameMax: number;
  /** Whose messages become issues: Leon. */
  leonUserId: string;
  /** Hermes, whose mention is left out of titles. */
  hermesUserId: string;
  /** `https://<workspace>.slack.com`, for permalinks without asking Slack. Looked up when unset. */
  workspaceUrl: string | null;
  /** Leon's DM with Hermes, the one DM whose messages Slack's events start on. Looked up when unset. */
  hermesDmId: string | null;
  /** Channels whose messages Hermes answers where they are (Hermes's `AUTOLINEAR_SKIP_CHANNELS`). */
  skipChannels: string[];
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const optional = (value: string | undefined) => value?.trim() || null;

export function loadConfig(env: Record<string, string | undefined>): AutolinearConfig {
  const teamKey = env.LINEAR_TEAM_KEY ?? "LEON";
  return {
    teamKey,
    teamId: optional(env.LINEAR_TEAM_ID),
    intakeStateId: optional(env.LINEAR_INTAKE_STATE_ID),
    intakeState: env.INTAKE_STATE ?? "Awaiting Init",
    channelPrefix: env.CHANNEL_PREFIX ?? teamKey.toLowerCase(),
    channelNameMax: Number(env.CHANNEL_NAME_MAX ?? "60"),
    leonUserId: required(env, "SLACK_LEON_USER_ID"),
    hermesUserId: required(env, "SLACK_HERMES_USER_ID"),
    workspaceUrl: optional(env.SLACK_WORKSPACE_URL)?.replace(/\/+$/, "") ?? null,
    hermesDmId: optional(env.SLACK_HERMES_DM_ID),
    skipChannels: (env.AUTOLINEAR_SKIP_CHANNELS ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean),
  };
}
