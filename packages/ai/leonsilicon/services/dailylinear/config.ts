import { DEFAULT_SECTION_ORDER } from "@-/ai.leonsilicon.services.slack22linear";

/** Settings for dailylinear, read from the Worker's vars. */
export interface DailyConfig {
  /** Linear team whose day projects these are, e.g. `LEON`. */
  teamKey: string;
  /** Whose midnight starts a day, and whose calendar names it. */
  timeZone: string;
  /** Hermes's Slack user ID: invited to every day's channel. Leon's session joins him itself. */
  hermesUserId: string;
  /** The project status a new day's project starts in, by name (Linear's Backlog). */
  projectStatus: string;
  /** The project status a day's project gets once its day is over, by name (Linear's Completed). */
  doneStatus: string;
  /** Linear project status types that close a project. */
  closedProjectTypes: string[];
  /** slack22linear's status sections, top to bottom, so the projects section is made below them. */
  sectionOrder: string[];
  /** The sidebar section a day's channel goes to once its day has passed. */
  projectSection: string;
  /** Longest channel name to generate (Slack allows 80). */
  channelNameMax: number;
}

const list = (value: string | undefined, fallback: string[]) =>
  value === undefined
    ? fallback
    : value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

export function loadConfig(env: Record<string, string | undefined>): DailyConfig {
  const hermesUserId = env.SLACK_HERMES_USER_ID?.trim();
  if (!hermesUserId) throw new Error("SLACK_HERMES_USER_ID is required");
  return {
    teamKey: env.LINEAR_TEAM_KEY ?? "LEON",
    timeZone: env.TIME_ZONE ?? "America/Toronto",
    hermesUserId,
    projectStatus: env.DAY_PROJECT_STATUS ?? "Backlog",
    doneStatus: env.DAY_DONE_STATUS ?? "Completed",
    closedProjectTypes: list(env.CLOSED_PROJECT_TYPES, ["completed", "canceled"]),
    sectionOrder: list(env.SECTION_ORDER, DEFAULT_SECTION_ORDER),
    projectSection: env.PROJECT_SECTION ?? "Projects",
    channelNameMax: Number(env.CHANNEL_NAME_MAX ?? "60"),
  };
}
