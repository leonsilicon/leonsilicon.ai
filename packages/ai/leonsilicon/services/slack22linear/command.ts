/**
 * Autolinear's commands (Leon's rule, 2026-11-23): after every turn in an issue channel, Hermes
 * tells Autolinear what to do with the channel in one line, and nothing moves on Hermes's answer
 * otherwise. Slack runs slash commands only for people, so Hermes writes the line as a mention of
 * Autolinear's bot; Leon can type the same words after `/autolinear`.
 *
 * ```text
 * @Autolinear move <status> [who=…] [start=…] [event=… stop=…] [due=…]
 * @Autolinear stay
 * @Autolinear help
 * ```
 *
 * `<status>` is a Linear status available to Autolinear, with or without "Awaiting": `done`,
 * `leon`, `"Awaiting Trigger"`. Values with spaces are double-quoted.
 */

export type AutolinearCommand =
  | { verb: "move"; status: string; keys: Record<string, string> }
  | { verb: "stay" }
  | { verb: "help" };

export type ParsedCommand = { ok: true; command: AutolinearCommand } | { ok: false; error: string };

/** Workflow details a `move` may set. */
export const COMMAND_KEYS = ["who", "start", "event", "stop", "due"] as const;
export const AWAITING_HERMES = "Awaiting Hermes";

/** What Hermes writes after Autolinear's mention (or Leon after `/autolinear`), as Slack mrkdwn. */
export function commandUsage(lead: string): string {
  return [
    `\`${lead} move done\`: nothing is left for anyone`,
    `\`${lead} move leon\`: Leon needs to see or do something`,
    `\`${lead} move trigger who="Apple App Review"\`: waiting on someone else`,
    `\`${lead} move trigger event="Rogers BYOD deal" stop=2026-12-01\`: waiting for an event until a stop date`,
    `\`${lead} move date start=2026-12-01T09:00:00-05:00\`: work starts later`,
    `\`${lead} move executing\`: work is already underway`,
    `\`${lead} stay\`: leave the status as it is`,
  ]
    .map((line) => `• ${line}`)
    .join("\n")
    .concat(
      "\nKeep the issue title and Slack channel name. Create a separate Linear issue for new work and link it to this one.",
    );
}

/**
 * The words after Autolinear's mention on the last line of `text` that starts with it, or null when
 * no line does. A mention inside a line, a quote or a code block isn't a command. The mention is
 * Slack's `<@U…>` token, or the plain `@Autolinear` Hermes may copy from what it has read (its Slack
 * adapter shows it every mention as `@Name`).
 */
export function commandLine(text: string, botUserId: string | null): string | null {
  const token = botUserId ? `<@${botUserId}(?:\\|[^>]*)?>|` : "";
  const line = new RegExp(`^\\s*(?:${token}@autolinear\\b)[\\s:,]*(.*)$`, "i");
  let found: string | null = null;
  let fenced = false;
  for (const raw of text.split("\n")) {
    if (raw.trimStart().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = line.exec(raw);
    if (match) found = match[1]!.trim();
  }
  return found;
}

const unescape = (text: string) =>
  text.replace(/[“”]/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/**
 * Splits on spaces, keeping `"quoted words"` and `key="quoted value"` together, quotes removed.
 * Null when a quote isn't closed.
 */
function tokens(text: string): string[] | null {
  const out: string[] = [];
  for (const match of text.matchAll(/([^\s"=]+=)?"((?:[^"\\]|\\.)*)"|(\S+)/g)) {
    if (match[3]?.includes('"')) return null;
    out.push(match[3] ?? `${match[1] ?? ""}${match[2]!.replace(/\\(.)/g, "$1")}`);
  }
  return out;
}

/** Reads a command's words (after the mention or `/autolinear`). Errors say what's wrong in a sentence. */
export function parseCommand(words: string): ParsedCommand {
  const list = tokens(unescape(words).trim());
  if (!list) return { ok: false, error: "a quote isn't closed" };
  // A sentence's full stop isn't part of the command.
  if (list.length) list[list.length - 1] = list.at(-1)!.replace(/[.!]+$/, "");
  const [verb = "", ...args] = list.filter(Boolean);
  switch (verb.toLowerCase()) {
    case "stay":
      return args.length
        ? { ok: false, error: "`stay` takes nothing after it" }
        : { ok: true, command: { verb: "stay" } };
    case "help":
      return { ok: true, command: { verb: "help" } };
    case "move": {
      const words: string[] = [];
      const keys: Record<string, string> = {};
      for (const arg of args) {
        const eq = arg.indexOf("=");
        if (eq < 0) {
          if (Object.keys(keys).length)
            return { ok: false, error: `the status goes before the keys, not \`${arg}\`` };
          words.push(arg);
          continue;
        }
        const key = arg.slice(0, eq).toLowerCase();
        const value = arg.slice(eq + 1).trim();
        if (!(COMMAND_KEYS as readonly string[]).includes(key))
          return {
            ok: false,
            error: `\`${key}\` isn't a key I know; use ${COMMAND_KEYS.map((k) => `\`${k}\``).join(", ")}`,
          };
        if (!value) return { ok: false, error: `\`${key}\` has no value` };
        keys[key] = value;
      }
      if (!words.length) return { ok: false, error: "`move` needs a status, such as `move done`" };
      const status = words.join(" ");
      if (matchStatus(status, [AWAITING_HERMES]))
        return { ok: false, error: "Awaiting Hermes is only available in Linear" };
      return { ok: true, command: { verb: "move", status, keys } };
    }
    case "":
      return { ok: false, error: "there's no command after my name" };
    default:
      return {
        ok: false,
        error: `\`${verb}\` isn't a command; use \`move\`, \`stay\` or \`help\``,
      };
  }
}

/**
 * The status a `move` names: one of `statuses`, matched without regard to case, with or without
 * "Awaiting " in front (`leon` is Awaiting Leon). Null when none matches.
 */
export function matchStatus(name: string, statuses: string[]): string | null {
  const want = name.trim().replace(/\s+/g, " ").toLowerCase();
  return (
    statuses.find((s) => s.toLowerCase() === want) ??
    statuses.find((s) => s.toLowerCase() === `awaiting ${want}`) ??
    null
  );
}

/** The `who` prefix in titles created before workflow details moved to the description. */
export const AWAITING_PREFIX = /^\s*\[AWAITING:\s*([^\]]*)\]\s*/i;
