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
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (day) return zonedMidnight(Number(day[1]), Number(day[2]), Number(day[3]), timeZone);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value.trim()))
    return null;
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? null : date;
}

function zonedMidnight(year: number, month: number, day: number, timeZone: string): Date {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  // Midnight local is UTC midnight shifted by the zone's offset, which is within ±14 hours.
  for (let offset = -14; offset <= 14; offset++) {
    const candidate = new Date(Date.UTC(year, month - 1, day, offset, 0));
    const parts = Object.fromEntries(format.formatToParts(candidate).map((p) => [p.type, p.value]));
    if (
      Number(parts.year) === year &&
      Number(parts.month) === month &&
      Number(parts.day) === day &&
      parts.hour === "00" &&
      parts.minute === "00"
    )
      return candidate;
  }
  return new Date(Date.UTC(year, month - 1, day));
}

/** `leon-205-switch-to-rogers`: prefix, issue number, then the title name, cut at a word. */
export function channelName(prefix: string, number: number, name: string, max: number): string {
  const head = `${prefix}-${number}`;
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return head;
  let out = `${head}-${slug}`;
  if (out.length <= max) return out;
  out = out.slice(0, max + 1);
  const cut = out.lastIndexOf("-");
  out = cut > head.length ? out.slice(0, cut) : out.slice(0, max);
  return out.replace(/-+$/, "");
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

const escapeSlack = (text: string) =>
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
