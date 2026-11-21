import { parse as parseYaml } from "@-/com.npmjs.yaml";

export type TitleMeta = Record<string, string>;

/** An issue title split into its name and the YAML metadata at its end. */
export interface ParsedTitle {
  name: string;
  meta: TitleMeta;
}

// Leon's rule (2026-11-18): status metadata ends the title as a YAML flow mapping in backticks,
// e.g. "switch to rogers `{event: Rogers unlimited BYOD deal, stop: 2026-12-01}`".
const META_AT_END = /\s*`(\{[^`]*\})`\s*$/;

/** Splits a title into its name and metadata. A title whose ending doesn't parse keeps it all. */
export function parseTitle(title: string): ParsedTitle {
  const match = META_AT_END.exec(title);
  if (!match) return { name: title.trim(), meta: {} };
  let value: unknown;
  try {
    value = parseYaml(match[1]!);
  } catch {
    return { name: title.trim(), meta: {} };
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { name: title.trim(), meta: {} };
  const meta: TitleMeta = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === null || item === undefined) continue;
    meta[key] =
      item instanceof Date
        ? item.toISOString()
        : typeof item === "object"
          ? JSON.stringify(item)
          : String(item as string | number | boolean);
  }
  return { name: title.slice(0, match.index).trim(), meta };
}

const NEEDS_QUOTES = /[,:{}[\]#"'`&*!|>%@]|^\s|\s$|^$/;

/** Writes the metadata back as a flow mapping, quoting values that YAML would misread. */
export function formatTitle(name: string, meta: TitleMeta): string {
  const entries = Object.entries(meta);
  if (entries.length === 0) return name;
  const body = entries
    .map(([key, value]) => `${key}: ${NEEDS_QUOTES.test(value) ? JSON.stringify(value) : value}`)
    .join(", ");
  return `${name} \`{${body}}\``;
}

/**
 * The instant a metadata date means. A bare `YYYY-MM-DD` is midnight at the start of that day in
 * `timeZone`; anything else must be an RFC 3339 time with an offset. Null when it isn't a date.
 */
export function metaInstant(value: string, timeZone: string): Date | null {
  const day = BARE_DATE.exec(value.trim());
  if (day) return zonedTime(Number(day[1]), Number(day[2]), Number(day[3]), 0, 0, timeZone);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value.trim()))
    return null;
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? null : date;
}

const BARE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether a metadata date has a time of day; a bare `YYYY-MM-DD` doesn't. */
export const hasTime = (value: string) => !BARE_DATE.test(value.trim());

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock reading of `instant` (ms) in `timeZone`. */
function localParts(instant: number, timeZone: string): LocalParts {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(instant)
      .map((p) => [p.type, Number(p.value)]),
  ) as unknown as LocalParts;
  return parts;
}

/** The instant a wall-clock time in `timeZone` names. */
function zonedTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const local = Date.UTC(year, month - 1, day, hour, minute);
  // The zone's offset is within ±14 hours, in steps of 15 minutes.
  for (let offset = -14 * 60; offset <= 14 * 60; offset += 15) {
    const candidate = local - offset * 60_000;
    const p = localParts(candidate, timeZone);
    if (
      p.year === year &&
      p.month === month &&
      p.day === day &&
      p.hour === hour &&
      p.minute === minute
    )
      return new Date(candidate);
  }
  return new Date(local);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `instant` as RFC 3339 in `timeZone`'s wall-clock time, with its offset: `2026-11-20T17:00:00-05:00`. */
export function zonedIso(instant: number, timeZone: string): string {
  const seconds = Math.floor(instant / 1000) * 1000;
  const p = localParts(seconds, timeZone);
  const offset = Math.round(
    (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - seconds) / 60_000,
  );
  const abs = Math.abs(offset);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${
    offset < 0 ? "-" : "+"
  }${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * A metadata date moved to `day` (`YYYY-MM-DD`) at the same wall-clock time in `timeZone`, written
 * as RFC 3339; a bare date becomes `day` itself. Null when either doesn't parse.
 */
export function withDay(value: string, day: string, timeZone: string): string | null {
  const at = metaInstant(value, timeZone);
  const target = BARE_DATE.exec(day);
  if (!at || !target) return null;
  if (!hasTime(value)) return day;
  const { hour, minute } = localParts(at.getTime(), timeZone);
  const moved = zonedTime(
    Number(target[1]),
    Number(target[2]),
    Number(target[3]),
    hour,
    minute,
    timeZone,
  );
  return zonedIso(moved.getTime(), timeZone);
}

/** The day `n` days after `day`, both `YYYY-MM-DD`. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** `Fri, Nov 20` or, with `time`, `Fri, Nov 20, 5:00 PM`, in `timeZone`. */
export function localLabel(instant: number, timeZone: string, time: boolean): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(time ? { hour: "numeric", minute: "2-digit" } : {}),
  })
    .format(instant)
    .replace(/ /g, " "); // newer ICU puts a narrow no-break space before AM/PM
}

/** Lowercase words joined by hyphens, accents dropped: what Slack allows in a channel name. */
const slugify = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** `head` + `-` + `slug`, cut at a hyphen so it fits in `max`, never shorter than `head`. */
function joinCut(head: string, slug: string, max: number): string {
  if (!slug) return head;
  let out = `${head}-${slug}`;
  if (out.length <= max) return out;
  out = out.slice(0, max + 1);
  const cut = out.lastIndexOf("-");
  out = cut > head.length ? out.slice(0, cut) : out.slice(0, max);
  return out.replace(/-+$/, "");
}

/** `leon-205-switch-to-rogers`: prefix, issue number, then the title name, cut at a word. */
export function channelName(prefix: string, number: number, name: string, max: number): string {
  return joinCut(`${prefix}-${number}`, slugify(name), max);
}

/**
 * The day a project is for, as `YYYY-MM-DD`, when its whole name is a calendar date: `20261119` (the
 * name Hermes's 05:00 Toronto job gives each day's project) or `2026-11-19`. Null for any other name.
 */
export function projectDay(name: string): string | null {
  const match = /^(\d{4})(-?)(\d{2})\2(\d{2})$/.exec(name.trim());
  if (!match) return null;
  const [, y, , m, d] = match as unknown as [string, string, string, string, string];
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) return null;
  return `${y}-${m}-${d}`;
}

/** The calendar day `instant` (ms) falls on in `timeZone`, as `YYYY-MM-DD`. */
export function localDay(instant: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/**
 * `project-uoft-creators-club`: Linear's project channel prefix (which ends in a hyphen) and the project
 * name, cut at a word. A project named after a day gets `project-2026-11-19`, whichever way the name
 * writes the date.
 */
export function projectChannelName(prefix: string, name: string, max: number): string {
  const day = projectDay(name);
  if (day) return `${prefix}${day}`;
  const slug = slugify(name) || "project";
  const out = `${prefix}${slug}`;
  return out.length <= max ? out : joinCut(prefix.replace(/-+$/, ""), slug, max);
}

/** The number in a channel name made by `channelName`, or null. */
export function channelNumber(prefix: string, name: string): number | null {
  const match = new RegExp(`^${prefix}-(\\d+)(?:-|$)`).exec(name);
  return match ? Number(match[1]) : null;
}

const TOPIC_MAX = 250;

/** The channel topic: status, metadata and the issue link. */
export function channelTopic(stateName: string, meta: TitleMeta, url: string): string {
  const parts = [stateName, ...Object.entries(meta).map(([k, v]) => `${k}: ${v}`)];
  const tail = ` · ${url}`;
  let head = parts.join(" · ");
  if (head.length + tail.length > TOPIC_MAX)
    head = `${head.slice(0, TOPIC_MAX - tail.length - 1)}…`;
  return head + tail;
}

/** Whether Slack message text mentions the user: `<@U…>`, or `<@U…|name>` from older clients. */
export const mentions = (text: string, userId: string) =>
  text.includes(`<@${userId}>`) || text.includes(`<@${userId}|`);

export const escapeSlack = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Pulls code spans and blocks out so the other rewrites leave them alone. */
function protectCode(text: string, transform: (code: string) => string) {
  const saved: string[] = [];
  const hold = (code: string) => `\uE000${saved.push(transform(code)) - 1}\uE000`;
  const rest = text.replace(/```[\s\S]*?```/g, hold).replace(/`[^`\n]+`/g, hold);
  const restore = (out: string) =>
    out.replace(/\uE000(\d+)\uE000/g, (_, i: string) => saved[Number(i)]!);
  return { rest, restore };
}

/** Linear Markdown to Slack mrkdwn. */
export function linearToSlack(markdown: string): string {
  const { rest, restore } = protectCode(markdown.replace(/\r\n/g, "\n"), escapeSlack);
  let out = escapeSlack(rest);
  out = out
    .replace(
      /!\[([^\]]*)\]\(([^)\s]+)\)/g,
      (_, alt: string, url: string) => `<${url}|${alt || "image"}>`,
    )
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) => `<${url}|${label}>`)
    .replace(/&lt;(https?:\/\/[^\s&]+(?:&amp;[^\s&]+)*)&gt;/g, "<$1>")
    // A Slack user mention written into Linear (`<@U…>`, maybe Markdown-escaped) stays one, so an
    // agent's comment can ping Leon. In code it stays text.
    .replace(/\\?&lt;@([UW][A-Z0-9]+)\\?&gt;/g, "<@$1>")
    .replace(/^(\s*)[*-]\s+/gm, "$1• ")
    .replace(/^#{1,6}\s+(.+?)\s*#*\s*$/gm, "\uE001$1\uE001")
    .replace(/\*\*([^*\n]+)\*\*/g, "\uE001$1\uE001")
    .replace(/__([^_\n]+)__/g, "\uE001$1\uE001")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, "$1_$2_")
    .replace(/~~([^~\n]+)~~/g, "~$1~")
    .replace(/^&gt;\s?/gm, "> ")
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, "──────────")
    .replace(/\uE001/g, "*");
  return restore(out);
}

/** Resolves a Slack user ID to a display name, for mentions. */
export type NameOf = (userId: string) => string;

/** Slack mrkdwn to Linear Markdown. */
export function slackToLinear(text: string, nameOf: NameOf): string {
  const { rest, restore } = protectCode(text, (code) =>
    code.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"),
  );
  const out = rest
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id: string) => `@${nameOf(id)}`)
    .replace(/<#[CG][A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, label?: string) => label ?? "@group")
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, "[$2]($1)")
    .replace(/<((?:https?|mailto):[^>]+)>/g, "$1")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/gm, "$1**$2**")
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/gm, "$1*$2*")
    .replace(/(^|[\s(])~([^~\n]+)~(?=$|[\s).,!?:;])/gm, "$1~~$2~~")
    .replace(/^(\s*)•\s+/gm, "$1- ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  return restore(out);
}

/**
 * A title for an issue made from a Slack message (in Linear Markdown, as `slackToLinear` gives
 * it): its first line of text, as plain words, cut at a word boundary. Backticks go, so the line
 * can't end in what `parseTitle` would read as status metadata. `fallback` names a message
 * without text, such as a file on its own.
 */
export function intakeTitle(markdown: string, fallback: string, max = 80): string {
  const line =
    markdown
      .split("\n")
      .map((l) =>
        l
          .replace(/^\s*(?:>+|[-*+•]|#{1,6}|\d+[.)])\s+/, "")
          .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
          .replace(/\*\*|__|~~|`/g, "")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .find(Boolean) ?? "";
  const title = line || fallback;
  if (title.length <= max) return title;
  const cut = title.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
