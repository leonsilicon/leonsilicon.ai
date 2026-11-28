import { parseArgs } from "@-/com.npmjs.citty";

/**
 * Autolinear's commands (Leon's rule, 2026-11-23): after every turn in an issue channel, Hermes
 * tells Autolinear what to do with the channel in one line, and nothing moves on Hermes's answer
 * otherwise. Slack runs slash commands only for people, so Hermes writes the line as a mention of
 * Autolinear's bot; Leon can type the same words after `/autolinear`.
 *
 * ```text
 * @Autolinear move <status> [--who …] [--start …] [--event … --stop …] [--until …] [--due …]
 * @Autolinear stay
 * @Autolinear help
 * ```
 *
 * `<status>` is a Linear status available to Autolinear, with or without "Awaiting": `done`,
 * `leon`, `"Awaiting Trigger"`. Values with spaces are double-quoted. `--until` goes with Executing:
 * when the work should be done, as a duration (`45m`, `2h`, `1h30m`) or a time.
 */

export type AutolinearCommand =
  | { verb: "move"; status: string; keys: Record<string, string> }
  | { verb: "stay" }
  | { verb: "help" };

export type ParsedCommand = { ok: true; command: AutolinearCommand } | { ok: false; error: string };

const moveOptions = {
  who: { type: "string" },
  start: { type: "string" },
  event: { type: "string" },
  stop: { type: "string" },
  until: { type: "string" },
  due: { type: "string" },
} as const;
const moveArgs = { status: { type: "positional" }, ...moveOptions } as const;

/** Workflow details a `move` may set. */
export const COMMAND_KEYS = Object.keys(moveOptions) as readonly (keyof typeof moveOptions)[];
const optionNames = COMMAND_KEYS.map((key) => `\`--${key}\``).join(", ");
export const AWAITING_HERMES = "Awaiting Hermes";

/** What Hermes writes after Autolinear's mention (or Leon after `/autolinear`), as Slack mrkdwn. */
export function commandUsage(lead: string): string {
  return [
    `\`${lead} move done\`: only once Leon has said it's done`,
    `\`${lead} move leon\`: Leon needs to see or do something`,
    `\`${lead} move trigger --who "Apple App Review"\`: waiting on someone else`,
    `\`${lead} move trigger --event "Rogers BYOD deal" --stop 2026-12-01\`: waiting for an event until a stop date`,
    `\`${lead} move date --start 2026-12-01T09:00:00-05:00\`: work starts later`,
    `\`${lead} move executing --until 2h\`: an agent is still working on it; if nothing happens here by then, it goes to Leon`,
    `\`${lead} stay\`: keep the status (after your :eyes:, the one from before it)`,
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
 * Splits Slack text into argv without shell expansion. Quoted tokens can follow an equals sign.
 * Returns null for an unclosed or misplaced quote.
 */
function tokens(text: string): string[] | null {
  const out: string[] = [];
  for (const [, prefix, quoted, singleQuoted, bare] of text.matchAll(
    /([^\s"'=]+=)?(?:"((?:[^"\\]|\\.)*)"|'([^']*)')(?=\s|$)|(\S+)/g,
  )) {
    if (bare?.includes('"') || (bare && /(?:^|=)'/.test(bare))) return null;
    out.push(bare ?? `${prefix ?? ""}${quoted?.replace(/\\(.)/g, "$1") ?? singleQuoted ?? ""}`);
  }
  return out;
}

const isOption = (arg: string) => arg.startsWith("-") || arg.includes("=");

/** Keep multiword statuses and adapt legacy `key=value` before handing argv to Citty. */
function parseMove(args: string[]): ParsedCommand {
  const firstOption = args.findIndex(isOption);
  const status = (firstOption < 0 ? args : args.slice(0, firstOption)).join(" ").trim();
  if (!status) return { ok: false, error: "`move` needs a status, such as `move done`" };
  const options = firstOption < 0 ? [] : args.slice(firstOption);
  const argv = [status];
  for (let index = 0; index < options.length; index++) {
    const arg = options[index]!;
    if (!isOption(arg))
      return { ok: false, error: `unexpected argument \`${arg}\`. Quote values with spaces` };
    const equal = arg.indexOf("=");
    const option = equal < 0 ? arg : arg.slice(0, equal);
    const key = option.replace(/^--/, "").toLowerCase();
    if (!Object.hasOwn(moveOptions, key)) {
      const label = option.startsWith("-") ? option : `--${option}`;
      return {
        ok: false,
        error: `unknown option \`${label}\`. Use ${optionNames}`,
      };
    }
    const value = equal < 0 ? options[index + 1] : arg.slice(equal + 1);
    if (!value?.trim() || (equal < 0 && value.startsWith("-")))
      return { ok: false, error: `\`--${key}\` has no value` };
    argv.push(`--${key}=${value.trim()}`);
    if (equal < 0) index++;
  }
  const parsed = parseArgs<typeof moveArgs>(argv, moveArgs);
  if (parsed._.length !== 1) return { ok: false, error: "couldn't read the move options" };
  const keys: Record<string, string> = {};
  for (const key of COMMAND_KEYS) {
    const value = parsed[key];
    if (value !== undefined) keys[key] = value;
  }
  if (matchStatus(parsed.status, [AWAITING_HERMES]))
    return { ok: false, error: "Awaiting Hermes is only available in Linear" };
  return { ok: true, command: { verb: "move", status: parsed.status, keys } };
}

/**
 * When a `--until` value ends (ms): a duration from `now` (`45m`, `2h`, `1h30m`), or null when it
 * isn't one. Times are read by the caller.
 */
export function untilDuration(value: string, now: number): number | null {
  const match = /^\s*(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?|s)?)?)?\s*$/i.exec(
    value,
  );
  if (!match || (match[1] === undefined && match[2] === undefined)) return null;
  return now + (Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)) * 60_000;
}

/** Reads a command's words (after the mention or `/autolinear`). Errors say what's wrong in a sentence. */
export function parseCommand(words: string): ParsedCommand {
  // Treat trailing sentence punctuation outside quotes as Slack prose.
  const list = tokens(
    unescape(words)
      .trim()
      .replace(/[.!]+$/, ""),
  );
  if (!list) return { ok: false, error: "a quote isn't closed" };
  const [verb = "", ...args] = list;
  const subcommand = verb.toLowerCase();
  if (
    (subcommand === "move" || subcommand === "stay") &&
    args.length === 1 &&
    (args[0] === "--help" || args[0] === "-h")
  )
    return { ok: true, command: { verb: "help" } };
  switch (subcommand) {
    case "stay":
      return args.length
        ? { ok: false, error: "`stay` takes nothing after it" }
        : { ok: true, command: { verb: "stay" } };
    case "help":
    case "--help":
    case "-h":
      return { ok: true, command: { verb: "help" } };
    case "move":
      return parseMove(args);
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
