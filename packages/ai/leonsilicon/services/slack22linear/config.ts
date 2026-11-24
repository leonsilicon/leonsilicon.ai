/** Settings for the Linear ⇄ Slack sync, read from the Worker's vars. */
export interface SyncConfig {
  /** Linear team key whose issues get channels, e.g. `LEON`. */
  teamKey: string;
  /** Channel names start with this, then the issue number: `leon-205-switch-to-rogers`. */
  channelPrefix: string;
  /** Longest channel name to generate (Slack allows 80). */
  channelNameMax: number;
  /** Leon's Slack user ID: invited to every channel and mentioned when an issue needs him. */
  leonUserId: string;
  /** Hermes's Slack bot user ID: invited to every channel and mentioned to wake it. */
  hermesUserId: string;
  /** Sidebar sections in order, top to bottom. Each is named exactly after a Linear status. */
  sectionOrder: string[];
  /** Statuses that mention Leon when an issue moves into them. */
  mentionLeonStates: string[];
  /** Statuses that mention Hermes when an issue moves into them, so it picks the issue up. */
  pingHermesStates: string[];
  /** Linear state types that close an issue; its channel is archived. */
  closedStateTypes: string[];
  /** The status whose issues wait for a `start` date, and where they go when it arrives. */
  dateState: string;
  dateTarget: string;
  /** The status whose issues wait on a listener, and where they go once its `stop` passes. */
  listenerState: string;
  listenerExpiredTarget: string;
  /**
   * Hermes's reaction (Slack's name, no colons) to Leon's message when it takes it up (👀). The
   * issue moves to `hermesAckState` at once, so the sidebar shows Hermes has it (`Sync.onHermesAck`).
   */
  hermesAckReaction: string;
  hermesAckState: string;
  /**
   * Hermes's reactions (Slack's names, no colons) to the message it took up once its turn is over
   * (✅), or once its turn failed (❌). Hermes then owes Autolinear a command (`Sync.onAnswered`).
   */
  hermesAnsweredReaction: string;
  hermesFailedReaction: string;
  /**
   * Autolinear's bot user (Leon's rule, 2026-11-23): Hermes ends every turn in an issue channel with
   * a line mentioning it that says what to do with the channel (`#command`), and it reminds Hermes
   * when a turn ends without one. Null until the bot exists: then no reminders are sent, and only a
   * plain-text `@Autolinear` line is read as a command.
   */
  autolinearUserId: string | null;
  /** The status whose issue titles start with `[AWAITING: <who>]` (Leon's convention). */
  othersState: string;
  /** Time zone for bare dates in title metadata, and for Linear's own due dates, which have no time. */
  timeZone: string;
  /** The public channel where issues coming due are announced, created when missing: `feed-linear`. */
  feedChannel: string;
  /** The sidebar section for project channels, below the status sections. */
  projectSection: string;
  /** Linear project status types that close a project; its channel is archived. */
  closedProjectTypes: string[];
}

const list = (value: string | undefined, fallback: string[]) =>
  value === undefined
    ? fallback
    : value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

export const DEFAULT_SECTION_ORDER = [
  "Awaiting Leon",
  "Awaiting Clarification",
  "Awaiting Others",
  "Awaiting Listener",
  "Awaiting Hermes",
  "Awaiting Init",
  "Awaiting Start",
  "Executing",
  "Awaiting Date",
];

/** A setting with no default, such as a Slack user ID, which is private and so comes from the environment. */
function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function loadConfig(env: Record<string, string | undefined>): SyncConfig {
  const teamKey = env.LINEAR_TEAM_KEY ?? "LEON";
  return {
    teamKey,
    channelPrefix: env.CHANNEL_PREFIX ?? teamKey.toLowerCase(),
    channelNameMax: Number(env.CHANNEL_NAME_MAX ?? "60"),
    leonUserId: required(env, "SLACK_LEON_USER_ID"),
    hermesUserId: required(env, "SLACK_HERMES_USER_ID"),
    sectionOrder: list(env.SECTION_ORDER, DEFAULT_SECTION_ORDER),
    mentionLeonStates: list(env.MENTION_LEON_STATES, ["Awaiting Leon", "Awaiting Clarification"]),
    pingHermesStates: list(env.PING_HERMES_STATES, ["Awaiting Hermes", "Awaiting Start"]),
    closedStateTypes: list(env.CLOSED_STATE_TYPES, ["completed", "canceled", "duplicate"]),
    dateState: env.DATE_STATE ?? "Awaiting Date",
    dateTarget: env.DATE_TARGET ?? "Awaiting Start",
    listenerState: env.LISTENER_STATE ?? "Awaiting Listener",
    listenerExpiredTarget: env.LISTENER_EXPIRED_TARGET ?? "Awaiting Leon",
    hermesAckReaction: env.HERMES_ACK_REACTION ?? "eyes",
    hermesAckState: env.HERMES_ACK_STATE ?? "Executing",
    hermesAnsweredReaction: env.HERMES_ANSWERED_REACTION ?? "white_check_mark",
    hermesFailedReaction: env.HERMES_FAILED_REACTION ?? "x",
    autolinearUserId: env.AUTOLINEAR_BOT_USER_ID?.trim() || null,
    othersState: env.OTHERS_STATE ?? "Awaiting Others",
    timeZone: env.TIME_ZONE ?? "America/Toronto",
    feedChannel: (env.LINEAR_FEED_CHANNEL ?? "feed-linear").replace(/^#/, ""),
    projectSection: env.PROJECT_SECTION ?? "Projects",
    closedProjectTypes: list(env.CLOSED_PROJECT_TYPES, ["completed", "canceled"]),
  };
}
