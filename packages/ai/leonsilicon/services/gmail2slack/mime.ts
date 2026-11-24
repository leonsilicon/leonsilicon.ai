/**
 * Turns a Gmail API message (`format=full`) into what the feed posts: the headers people read, the
 * body as plain text, and the attachments' names and sizes. Gmail has already undone the transfer
 * encoding (quoted-printable, base64); what's left is base64url bytes in the part's own charset.
 */

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GmailPart;
}

export interface Attachment {
  filename: string;
  mimeType: string;
  size: number;
}

/** The result of the sender's checks as Gmail recorded them (`Authentication-Results`). */
export interface SenderAuth {
  spf?: string;
  dkim?: string;
  dmarc?: string;
}

export interface Email {
  id: string;
  threadId: string;
  labelIds: string[];
  /** When Gmail received it (ms). */
  receivedAt: number;
  from: string;
  /** The bare address in From, lowercased, or "" when there isn't one. */
  fromAddress: string;
  replyTo: string;
  to: string[];
  cc: string[];
  subject: string;
  /** Present on mailing-list and bulk mail. */
  listId: string;
  unsubscribe: boolean;
  auth: SenderAuth;
  text: string;
  attachments: Attachment[];
}

/** A text part whose body Gmail left out of `format=full` (it's big): fetch it with attachments.get. */
export interface PendingPart {
  partId: string;
  attachmentId: string;
}

export function header(part: GmailPart | undefined, name: string): string {
  const wanted = name.toLowerCase();
  return part?.headers?.find((h) => h.name.toLowerCase() === wanted)?.value ?? "";
}

function headerAll(part: GmailPart | undefined, name: string): string[] {
  const wanted = name.toLowerCase();
  return (part?.headers ?? []).filter((h) => h.name.toLowerCase() === wanted).map((h) => h.value);
}

/** Base64url (Gmail's encoding, padding optional) to bytes. */
export function base64UrlBytes(data: string): Uint8Array {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function charsetOf(part: GmailPart): string {
  const type = header(part, "Content-Type");
  const match = /charset\s*=\s*"?([^";\s]+)"?/i.exec(type);
  return match ? match[1].toLowerCase() : "utf-8";
}

/** Decodes bytes in their declared charset, falling back to UTF-8 for one the runtime doesn't know. */
export function decodeText(bytes: Uint8Array, charset: string): string {
  const label = charset === "us-ascii" || charset === "ascii" ? "utf-8" : charset;
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

const isAttachment = (part: GmailPart): boolean =>
  Boolean(part.filename) || /^\s*attachment/i.test(header(part, "Content-Disposition"));

interface Collected {
  plain: string[];
  html: string[];
  attachments: Attachment[];
  pending: PendingPart[];
}

function walk(
  part: GmailPart,
  out: Collected,
  fetched: ReadonlyMap<string, string>,
  depth = 0,
): void {
  if (depth > 20) return;
  const type = (part.mimeType ?? "").toLowerCase();
  if (part.parts?.length) {
    for (const child of part.parts) walk(child, out, fetched, depth + 1);
    return;
  }
  if (isAttachment(part) || (!type.startsWith("text/plain") && !type.startsWith("text/html"))) {
    // Inline images without a name (signatures, tracking pixels) aren't worth listing.
    if (part.filename || type.startsWith("text/calendar"))
      out.attachments.push({
        filename: part.filename || "invite.ics",
        mimeType: type || "application/octet-stream",
        size: part.body?.size ?? 0,
      });
    return;
  }
  let data = part.body?.data;
  if (!data && part.body?.attachmentId) {
    data = fetched.get(part.partId ?? "");
    if (data === undefined) {
      out.pending.push({ partId: part.partId ?? "", attachmentId: part.body.attachmentId });
      return;
    }
  }
  if (!data) return;
  const text = decodeText(base64UrlBytes(data), charsetOf(part));
  (type.startsWith("text/html") ? out.html : out.plain).push(text);
}

/** Text parts that need fetching before `parseEmail` can show the whole body. */
export function pendingParts(message: GmailMessage): PendingPart[] {
  const out: Collected = { plain: [], html: [], attachments: [], pending: [] };
  if (message.payload) walk(message.payload, out, new Map());
  return out.pending;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  times: "×",
  divide: "÷",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  sect: "§",
  para: "¶",
  rarr: "→",
  larr: "←",
  zwnj: "",
  zwj: "",
  shy: "",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X"
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

// Invisible characters newsletters pad their preview text with.
const INVISIBLE = /͏|[​-‍⁠﻿­᠎]/g;

/** Tidies text for Slack: no CRs, no invisible padding, no runs of blank lines or trailing spaces. */
export function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(INVISIBLE, "")
    .replace(/ /g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** HTML mail as readable text: the words, list bullets and line breaks, and each link's address. */
export function htmlToText(html: string): string {
  const linked = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(head|style|script|title|noscript)\b[\s\S]*?<\/\1\s*>/gi, "")
    // Line breaks in HTML source are just spaces; only the markup below makes new lines.
    .replace(/\s+/g, " ")
    .replace(
      /<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
      (_whole, _q, dq?: string, sq?: string, bare?: string, inner = "") => {
        const href = decodeEntities((dq ?? sq ?? bare ?? "").trim());
        const label = tidy(decodeEntities(inner.replace(/<[^>]+>/g, " ")));
        if (!/^(https?:|mailto:|tel:)/i.test(href)) return label;
        const target = href.replace(/^mailto:/i, "");
        if (!label) return ` ${target} `;
        if (label === target || label === href) return label;
        return `${label} (${target})`;
      },
    )
    .replace(/<img\b[^>]*?\balt\s*=\s*"([^"]+)"[^>]*>/gi, " $1 ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<hr\b[^>]*>/gi, "\n———\n")
    .replace(
      /<\/?(p|div|tr|table|tbody|thead|ul|ol|h[1-6]|blockquote|section|article|header|footer|center|pre)\b[^>]*>/gi,
      "\n",
    )
    .replace(/<\/(td|th)\s*>/gi, "  ")
    .replace(/<[^>]+>/g, "");
  return tidy(decodeEntities(linked));
}

/** Parses a list of addresses as written in To or Cc into one entry each, quotes and all. */
export function splitAddresses(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let angle = 0;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "<") angle++;
    else if (!quoted && ch === ">") angle = Math.max(0, angle - 1);
    if (ch === "," && !quoted && angle === 0) {
      if (current.trim()) out.push(current.trim());
      current = "";
    } else current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** The address part of `"Name" <a@b.c>` or `a@b.c`, lowercased. */
export function bareAddress(value: string): string {
  const angled = /<([^<>\s]+@[^<>\s]+)>/.exec(value);
  if (angled) return angled[1].toLowerCase();
  const plain = /([^\s<>",;]+@[^\s<>",;]+)/.exec(value);
  return plain ? plain[1].toLowerCase() : "";
}

/** Gmail's own verdicts from the first `Authentication-Results` header (its own, at the top). */
export function senderAuth(part: GmailPart | undefined): SenderAuth {
  const results = headerAll(part, "Authentication-Results")[0] ?? "";
  const pick = (method: string) => {
    const match = new RegExp(`\\b${method}=([a-z]+)`, "i").exec(results);
    return match ? match[1].toLowerCase() : undefined;
  };
  const auth: SenderAuth = {};
  const spf = pick("spf");
  const dkim = pick("dkim");
  const dmarc = pick("dmarc");
  if (spf) auth.spf = spf;
  if (dkim) auth.dkim = dkim;
  if (dmarc) auth.dmarc = dmarc;
  return auth;
}

/** A plain part this short beside an HTML part is a "view it in your browser" stub. */
const STUB_LENGTH = 80;

/**
 * The email, given the message and any text parts fetched separately (`partId` → base64url data).
 * The body is the plain-text version, or the HTML one converted when there's no real plain one.
 */
export function parseEmail(
  message: GmailMessage,
  fetched: ReadonlyMap<string, string> = new Map(),
): Email {
  const payload = message.payload;
  const out: Collected = { plain: [], html: [], attachments: [], pending: [] };
  if (payload) walk(payload, out, fetched);
  const plain = tidy(out.plain.join("\n\n"));
  const html = out.html.length ? htmlToText(out.html.join("\n")) : "";
  let text = plain.length >= STUB_LENGTH || html.length <= plain.length ? plain || html : html;
  if (!text && message.snippet) text = tidy(decodeEntities(message.snippet));
  if (out.pending.length)
    text += "\n\n[Part of this email was too big to fetch; open it in Gmail.]";
  const from = header(payload, "From");
  return {
    id: message.id,
    threadId: message.threadId,
    labelIds: message.labelIds ?? [],
    receivedAt: Number(message.internalDate ?? Date.now()),
    from,
    fromAddress: bareAddress(from),
    replyTo: header(payload, "Reply-To"),
    to: splitAddresses(header(payload, "To")),
    cc: splitAddresses(header(payload, "Cc")),
    subject: header(payload, "Subject").replace(/\s+/g, " ").trim(),
    listId: header(payload, "List-Id"),
    unsubscribe: Boolean(header(payload, "List-Unsubscribe")),
    auth: senderAuth(payload),
    text,
    attachments: out.attachments,
  };
}
