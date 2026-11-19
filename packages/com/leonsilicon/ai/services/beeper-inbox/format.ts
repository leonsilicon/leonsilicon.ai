import type { MatrixAttachment, MatrixMessageEvent } from "#types";

/** Pure shaping of what the tools return, kept apart from I/O so it can be tested on its own. */

export interface AttachmentRef {
  index: number;
  kind: string;
  filename: string | null;
  content_type: string | null;
  size: number | null;
  encrypted: boolean;
  /** The media URI. For an encrypted file it identifies the ciphertext only: download through the tool. */
  mxc: string | null;
}

export interface FormattedMessage {
  event_id: string;
  room_id: string;
  sender: string;
  sender_name?: string;
  is_me: boolean;
  timestamp: string | null;
  ts: number | null;
  type: string;
  text: string;
  text_truncated?: boolean;
  html?: string;
  reply_to?: string;
  thread_root?: string;
  edited: boolean;
  encrypted: boolean;
  attachments: AttachmentRef[];
  reactions?: Array<{ key: string; count: number; senders: string[] }>;
}

export function attachmentRefs(attachments: readonly MatrixAttachment[]): AttachmentRef[] {
  return attachments.map((attachment, index) => ({
    index,
    kind: attachment.kind,
    filename: attachment.filename ?? null,
    content_type: attachment.contentType ?? null,
    size: typeof attachment.size === "number" ? attachment.size : null,
    encrypted: Boolean(attachment.encryptedFile),
    mxc: attachment.encryptedFile?.url ?? attachment.contentUri ?? null,
  }));
}

export function formatMessage(
  message: MatrixMessageEvent,
  options: { maxText: number; senderName?: string | undefined; includeHtml?: boolean },
): FormattedMessage {
  const text = message.text ?? "";
  const truncated = text.length > options.maxText;
  const ts = typeof message.timestamp === "number" ? message.timestamp : null;
  const out: FormattedMessage = {
    event_id: message.eventId,
    room_id: message.roomId,
    sender: message.sender.userId,
    is_me: message.sender.isMe,
    timestamp: ts === null ? null : new Date(ts).toISOString(),
    ts,
    type: message.messageType,
    text: truncated ? `${text.slice(0, options.maxText)}…` : text,
    edited: message.edited,
    encrypted: message.encrypted,
    attachments: attachmentRefs(message.attachments ?? []),
  };
  if (options.senderName) out.sender_name = options.senderName;
  if (truncated) out.text_truncated = true;
  if (options.includeHtml && message.html) out.html = message.html.slice(0, options.maxText);
  if (message.replyTo) out.reply_to = message.replyTo;
  if (message.threadRoot) out.thread_root = message.threadRoot;
  return out;
}

export interface RawEvent {
  event_id?: string;
  type?: string;
  sender?: string;
  origin_server_ts?: number;
  state_key?: string;
  content?: Record<string, unknown>;
  unsigned?: Record<string, unknown>;
}

export interface OmittedEvent {
  event_id: string;
  type: string;
  sender: string | null;
  timestamp: string | null;
  reason: "undecryptable" | "not_a_message" | "thread_reply" | "unsupported";
  error?: string;
}

export interface PageAccounting {
  undecryptable: OmittedEvent[];
  thread_replies: OmittedEvent[];
  other: OmittedEvent[];
  edits_merged: number;
  reactions: number;
  redacted: number;
  state_events: number;
  raw_events: number;
}

function relation(
  event: RawEvent,
): { rel_type?: string; event_id?: string; key?: string } | undefined {
  const rel = event.content?.["m.relates_to"];
  return rel && typeof rel === "object"
    ? (rel as { rel_type?: string; event_id?: string; key?: string })
    : undefined;
}

function omitted(event: RawEvent, reason: OmittedEvent["reason"], error?: string): OmittedEvent {
  const ts = typeof event.origin_server_ts === "number" ? event.origin_server_ts : null;
  const out: OmittedEvent = {
    event_id: event.event_id ?? "",
    type: event.type ?? "",
    sender: event.sender ?? null,
    timestamp: ts === null ? null : new Date(ts).toISOString(),
    reason,
  };
  if (error) out.error = error;
  return out;
}

/**
 * Accounts for every raw event of a history page against what Pickle returned, so nothing silently
 * vanishes: events Pickle couldn't decrypt are listed with the error it reported.
 */
export function accountPage(
  rawEvents: readonly RawEvent[],
  returnedIds: ReadonlySet<string>,
  decryptErrors: ReadonlyMap<string, string>,
): PageAccounting {
  const page: PageAccounting = {
    undecryptable: [],
    thread_replies: [],
    other: [],
    edits_merged: 0,
    reactions: 0,
    redacted: 0,
    state_events: 0,
    raw_events: rawEvents.length,
  };
  for (const event of rawEvents) {
    const id = event.event_id ?? "";
    if (returnedIds.has(id)) continue;
    if (event.state_key !== undefined) {
      page.state_events += 1;
      continue;
    }
    if (
      event.unsigned?.redacted_because ||
      (event.type === "m.room.encrypted" &&
        !event.content?.ciphertext &&
        Object.keys(event.content ?? {}).length === 0)
    ) {
      page.redacted += 1;
      continue;
    }
    const rel = relation(event);
    if (event.type === "m.reaction" || rel?.rel_type === "m.annotation") {
      page.reactions += 1;
      continue;
    }
    if (rel?.rel_type === "m.replace") {
      page.edits_merged += 1;
      continue;
    }
    if (rel?.rel_type === "m.thread") {
      page.thread_replies.push(omitted(event, "thread_reply"));
      continue;
    }
    const error = decryptErrors.get(id);
    if (event.type === "m.room.encrypted") {
      if (error) page.undecryptable.push(omitted(event, "undecryptable", error));
      else page.other.push(omitted(event, "not_a_message"));
      continue;
    }
    if (event.type === "m.room.message") {
      page.other.push(omitted(event, "unsupported"));
      continue;
    }
    page.other.push(omitted(event, "not_a_message"));
  }
  return page;
}

/** Unencrypted reactions in a page, grouped onto the messages they react to. */
export function reactionsByTarget(
  rawEvents: readonly RawEvent[],
): Map<string, Map<string, Set<string>>> {
  const out = new Map<string, Map<string, Set<string>>>();
  for (const event of rawEvents) {
    const rel = relation(event);
    if (
      event.type !== "m.reaction" ||
      rel?.rel_type !== "m.annotation" ||
      !rel.event_id ||
      !rel.key
    )
      continue;
    const byKey = out.get(rel.event_id) ?? new Map<string, Set<string>>();
    const senders = byKey.get(rel.key) ?? new Set<string>();
    senders.add(event.sender ?? "");
    byKey.set(rel.key, senders);
    out.set(rel.event_id, byKey);
  }
  return out;
}

/** A filename safe for one path segment, keeping the extension readable. */
export function safeFilename(name: string | null | undefined, fallback: string): string {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  let replaced = "";
  for (let i = 0; i < base.length; i += 1) {
    // Control characters are single UTF-16 units, so indexing by unit is safe here.
    const char = base.charAt(i);
    replaced += base.charCodeAt(i) < 0x20 || '<>:"|?*'.includes(char) ? "_" : char;
  }
  const cleaned = replaced.replace(/_{2,}/g, "_").replace(/^\.+/, "").trim().slice(-120);
  return cleaned || fallback;
}

const EXTENSION_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  wav: "audio/wav",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function contentTypeFor(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  return EXTENSION_TYPES[ext] ?? "application/octet-stream";
}

export function mediaKind(
  contentType: string,
  sendAs: "auto" | "file",
): "image" | "video" | "audio" | "file" {
  if (sendAs === "file") return "file";
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  return "file";
}

/**
 * Paths `send_file` refuses, so a steered agent can't mail out Hermes's own credentials: hidden files
 * and directories (`.env`, `.ssh`, `.config`), this service's state, and names that look like secrets.
 */
export function refusedUploadReason(realPath: string, stateDir: string): string | null {
  if (realPath === stateDir || realPath.startsWith(`${stateDir}/`))
    return "it is inside beeper-inbox's private state";
  const segments = realPath.split("/").filter(Boolean);
  if (segments.some((segment) => segment.startsWith(".")))
    return "hidden files and folders (such as .env or .ssh) can't be sent";
  const base = segments.at(-1) ?? "";
  if (
    /(token|secret|credential|password|passwd|private[-_]?key|id_rsa|id_ed25519|\.pem$|\.key$|\.p12$|config\.ya?ml|auth\.json|\.env)/i.test(
      base,
    )
  ) {
    return "the filename looks like a credential or configuration file";
  }
  if (segments.includes("mcp-tokens")) return "it is inside Hermes's MCP token store";
  return null;
}
