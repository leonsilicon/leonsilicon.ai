import type { ExtensionJournal, JournalEntry } from "@-/ai.leonsilicon.services.beeper-inbox";
import type { GrokBackend, GrokBot, GrokLive, GrokMessage } from "#types";

/** Runs one of the Beeper inbox's tools; inside the inbox daemon this is a direct call. */
export type InboxTool = (
  name: string,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** The inbox's short name for Beeper's "Grok Bot" network (bridge protocol `grokbot`). */
export const GROK_NETWORK = "grok";
/**
 * The most events one history read asks for. A page costs about half a second per event, and the
 * inbox reads one page at a time, so a large one holds everything else up.
 */
export const HISTORY_MAX = 20;

/**
 * Orders a chat's messages by time, with the event ID breaking ties, and compares as a plain string:
 * timestamps keep 13 digits until the year 2286.
 */
export function sortKeyOf(ts: number, eventId: string): string {
  return `${String(ts).padStart(13, "0")}:${eventId}`;
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
      )
    : [];
}

function fromJournal(entry: JournalEntry): GrokMessage {
  return {
    id: entry.eventId,
    chatID: entry.roomId,
    sortKey: sortKeyOf(entry.ts, entry.eventId),
    isSender: entry.isMe,
    text: entry.text,
    timestamp: new Date(entry.ts).toISOString(),
    ...(entry.type && entry.type !== "m.text" ? { type: entry.type } : {}),
    ...(entry.redacted ? { isDeleted: true } : {}),
  };
}

function liveFrom(journal: ExtensionJournal): GrokLive {
  return {
    coveredSince: () => journal.coveredSince(),
    latest: async (chatID, count) => (await journal.latest(chatID, count)).map(fromJournal),
    since: async (chatID, sinceMs) => (await journal.since(chatID, sinceMs)).map(fromJournal),
    cursor: () => journal.head(),
    changes: async (chatID, cursor, waitMs) => {
      const page = await journal.changes({ after: cursor, roomId: chatID, waitMs });
      return { messages: page.entries.map(fromJournal), cursor: page.cursor };
    },
  };
}

/**
 * The relay's reads and sends through Hermes's Beeper inbox: Matrix, with no Beeper Desktop. With the
 * inbox's journal it follows chats live.
 */
export function inboxBackend(tool: InboxTool, journal?: ExtensionJournal): GrokBackend {
  return {
    ...(journal ? { live: liveFrom(journal) } : {}),

    async bots({ refresh = false } = {}) {
      const bots: GrokBot[] = [];
      let offset = 0;
      for (let page = 0; page < 10; page++) {
        const result = await tool("list_conversations", {
          network: GROK_NETWORK,
          direct_only: true,
          limit: 100,
          offset,
          ...(refresh && page === 0 ? { refresh: true } : {}),
        });
        for (const room of records(result.conversations)) {
          if (typeof room.room_id !== "string") continue;
          bots.push({
            name: typeof room.name === "string" && room.name ? room.name : room.room_id,
            chatID: room.room_id,
            lastActivity: typeof room.last_activity === "string" ? room.last_activity : null,
          });
        }
        if (typeof result.next_offset !== "number") break;
        offset = result.next_offset;
      }
      return bots;
    },

    async messages(chatID, wanted = HISTORY_MAX) {
      const found = new Map<string, GrokMessage>();
      {
        const result = await tool("list_messages", {
          room_id: chatID,
          limit: Math.min(Math.max(Math.trunc(wanted), 1), HISTORY_MAX),
        });
        for (const message of records(result.messages)) {
          const { event_id: id, ts, timestamp, type } = message;
          if (typeof id !== "string" || typeof ts !== "number" || typeof timestamp !== "string")
            continue;
          found.set(id, {
            id,
            chatID,
            sortKey: sortKeyOf(ts, id),
            isSender: message.is_me === true,
            text: typeof message.text === "string" ? message.text : "",
            timestamp,
            ...(typeof type === "string" && type !== "m.text" ? { type } : {}),
          });
        }
      }
      return [...found.values()];
    },

    async send(chatID, text, key) {
      const result = await tool("send_message", {
        room_id: chatID,
        text,
        idempotency_key: key,
      });
      const id = result.event_id;
      if (typeof id !== "string" || !id)
        throw new Error("Beeper accepted the message but gave no event ID for it");
      const bridge = (result.bridge_status ?? {}) as { status?: unknown; message?: unknown };
      if (typeof bridge.status === "string" && /fail/i.test(bridge.status)) {
        throw new Error(
          `The message reached Beeper but the Grok Bot bridge reported ${bridge.status}${typeof bridge.message === "string" ? `: ${bridge.message.slice(0, 200)}` : ""}. The bot may not have received it.`,
        );
      }
      return { id };
    },
  };
}
