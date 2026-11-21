import type { GrokBackend, GrokBot, GrokMessage } from "#types";

/** Runs one of the Beeper inbox's tools; inside the inbox daemon this is a direct call. */
export type InboxTool = (
  name: string,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** The inbox's short name for Beeper's "Grok Bot" network (bridge protocol `grokbot`). */
export const GROK_NETWORK = "grok";
/** Each page is up to 100 raw events; a bot that edits its replies as it writes uses many per message. */
const MAX_PAGES = 3;

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

/** The relay's reads and sends through Hermes's Beeper inbox: Matrix, with no Beeper Desktop. */
export function inboxBackend(tool: InboxTool): GrokBackend {
  return {
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

    async messages(chatID, wanted = 30) {
      const found = new Map<string, GrokMessage>();
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await tool("list_messages", {
          room_id: chatID,
          limit: 100,
          ...(cursor ? { cursor } : {}),
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
        cursor = typeof result.next_cursor === "string" ? result.next_cursor : null;
        if (found.size >= wanted || !cursor) break;
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
