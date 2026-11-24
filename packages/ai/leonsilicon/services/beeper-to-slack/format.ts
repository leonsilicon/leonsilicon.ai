import type { JournalEntry, RoomInfo } from "@-/ai.leonsilicon.services.beeper-inbox";
import { escapeSlack, reasonLabel, type Verdict } from "@-/ai.leonsilicon.services.feed-common";

export const MAX_TEXT = 3_800;

function excerpt(value: string, limit: number): string {
  const escaped = escapeSlack(value.slice(0, limit));
  if (escaped.length <= limit && value.length <= limit) return escaped;
  return escaped.slice(0, limit - 1).replace(/&(?:[a-z]*)$/i, "") + "…";
}

export function mirrorText(
  message: JournalEntry,
  room: RoomInfo,
  sender: string,
  verdict: Verdict,
): string {
  const label =
    verdict.route === "safe"
      ? ""
      : `[${verdict.route === "spam" ? "Spam" : "Flagged"} · ${reasonLabel(verdict.reason)}] `;
  const title = excerpt((room.name ?? "Beeper conversation").replace(/\s+/g, " "), 160);
  const name = excerpt(sender.replace(/\s+/g, " "), 120);
  const origin = excerpt(room.network, 40);
  const header = `${label}${title} · ${origin} · ${name}`;
  const ids = `Chat \`${excerpt(message.roomId.replaceAll("`", "'"), 220)}\` · message \`${excerpt(message.eventId.replaceAll("`", "'"), 220)}\``;
  const attachments =
    message.attachments > 0 ? `\n${message.attachments} attachment(s) in Beeper` : "";
  const body = message.text.trim() || (message.attachments ? "[Attachment]" : "[No text]");
  return `${header}\n>>> ${excerpt(body, MAX_TEXT - header.length - ids.length - attachments.length - 10)}${attachments}\n${ids}`;
}
