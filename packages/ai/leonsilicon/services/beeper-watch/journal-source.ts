import type { InboxAccess, JournalEntry, RoomInfo } from "#inbox";
import type {
  BeeperFeedSource,
  BeeperSource,
  ChatInfo,
  ChatMessage,
  FeedChat,
  FeedMessage,
  Logger,
} from "#types";

/**
 * Beeper as Hermes Cloud's inbox sees it: Matrix, with no Beeper Desktop and none of Leon's
 * computers. New messages come from the inbox's journal, which sync fills as they arrive; room names,
 * networks and mutes come from its directory.
 *
 * A chat ID is the Matrix room ID, as it already was in every #feed- post. A message ID is the Matrix
 * event ID; Beeper Desktop's were its own numbers, so state saved from that source can't be reused.
 */

/** The feed's page limit, as a number of messages. */
const RECENT_LIMIT = 2000;
/** The one page of history read for a watch that began before the journal did. */
const BACKFILL_EVENTS = 20;
const ROOM_TTL_MS = 2 * 60_000;
const LOOKUP_EVERY_MS = 10 * 60_000;

/** Message types as Beeper Desktop named them, which the watcher and the feed tell apart. */
const TYPES: Record<string, string> = {
  "m.text": "TEXT",
  "m.emote": "TEXT",
  "m.notice": "NOTICE",
  "m.image": "IMAGE",
  "m.video": "VIDEO",
  "m.audio": "AUDIO",
  "m.file": "FILE",
  "m.location": "LOCATION",
  "m.sticker": "STICKER",
};

export function typeOf(msgtype: string): string {
  return TYPES[msgtype] ?? (msgtype.replace(/^m\./, "").toUpperCase() || "TEXT");
}

/**
 * The connection a room belongs to, shaped like a Beeper Desktop account ID (`whatsapp.…`,
 * `slackgo.<team ID>`): the bridge's name, then the network's own ID where the bridge gives one. A
 * plain Matrix room is `matrix.`, Beeper's own chats.
 */
export function accountOf(room: { protocolId: string | null; networkId: string | null }): string {
  return `${room.protocolId ?? "matrix"}.${room.networkId ?? ""}`;
}

function feedChat(room: RoomInfo): FeedChat {
  return {
    id: room.roomId,
    accountID: accountOf(room),
    title: room.name ?? "(untitled chat)",
    network: room.networkName ?? (room.protocolId ? room.network : "Beeper"),
    type: room.isDirect ? "single" : "group",
    isMuted: room.isMuted,
  };
}

export function journalSource(
  inbox: InboxAccess,
  log: Logger,
  now: () => number = Date.now,
): BeeperSource & BeeperFeedSource {
  const known = new Map<string, { room: RoomInfo; at: number }>();
  const lookedUp = new Map<string, number>();
  // History read once for a watch that began before the journal did; cleared when coverage restarts.
  const backfilled = new Map<string, ChatMessage[]>();
  let backfilledFor = 0;

  /** Rooms by ID, from the inbox's directory. A room it doesn't have yet makes it refresh, at most every ten minutes per room. */
  async function rooms(roomIds: readonly string[]): Promise<Map<string, RoomInfo>> {
    const at = now();
    const wanted = [...new Set(roomIds)];
    const stale = wanted.filter((id) => at - (known.get(id)?.at ?? 0) > ROOM_TTL_MS);
    if (stale.length) {
      for (const room of await inbox.rooms(stale)) known.set(room.roomId, { room, at });
      for (const id of stale) {
        if (known.has(id) && at - (known.get(id)?.at ?? 0) <= ROOM_TTL_MS) continue;
        if (at - (lookedUp.get(id) ?? 0) < LOOKUP_EVERY_MS) continue;
        lookedUp.set(id, at);
        try {
          // A room joined since the directory was built: asking for it makes the inbox rebuild it.
          await inbox.tool("get_conversation", { room_id: id });
          for (const room of await inbox.rooms([id])) known.set(room.roomId, { room, at });
        } catch (error) {
          log("warn", "a chat isn't in the inbox's directory", { error: (error as Error).message });
        }
      }
    }
    const out = new Map<string, RoomInfo>();
    for (const id of wanted) {
      const room = known.get(id)?.room;
      if (room) out.set(id, room);
    }
    return out;
  }

  async function shaped(
    entries: readonly JournalEntry[],
    titles: Map<string, RoomInfo>,
  ): Promise<Array<ChatMessage & { roomId: string }>> {
    const names = await inbox.senderNames([
      ...new Set(entries.filter((entry) => !entry.isMe).map((entry) => entry.sender)),
    ]);
    return entries
      .filter((entry) => !entry.redacted)
      .map((entry) => ({
        roomId: entry.roomId,
        id: entry.eventId,
        senderName: entry.isMe
          ? "Leon"
          : (names[entry.sender] ??
            (titles.get(entry.roomId)?.isDirect ? titles.get(entry.roomId)?.name : null) ??
            entry.sender),
        isSender: entry.isMe,
        text: entry.text,
        type: typeOf(entry.type),
        timestamp: new Date(entry.ts).toISOString(),
      }));
  }

  return {
    async chat(chatID): Promise<ChatInfo> {
      const room = (await rooms([chatID])).get(chatID);
      if (!room) throw new Error(`Beeper has no chat ${chatID}`);
      const chat = feedChat(room);
      return { id: chat.id, title: chat.title, network: chat.network, type: chat.type };
    },

    async messagesSince(chatID, sinceIso) {
      const since = Date.parse(sinceIso);
      const covered = await inbox.journal.coveredSince();
      if (covered !== backfilledFor) {
        backfilled.clear();
        backfilledFor = covered;
      }
      if (since < covered && !backfilled.has(chatID)) {
        // The watch began before the journal did. Read the gap from history once; a page costs
        // about half a second per event, so this must never happen on every poll.
        backfilled.set(chatID, []);
        try {
          const page = await inbox.tool("list_messages", {
            room_id: chatID,
            limit: BACKFILL_EVENTS,
          });
          const messages = Array.isArray(page.messages)
            ? (page.messages as Array<Record<string, unknown>>)
            : [];
          backfilled.set(
            chatID,
            messages.flatMap((message): ChatMessage[] =>
              typeof message.event_id === "string" && typeof message.timestamp === "string"
                ? [
                    {
                      id: message.event_id,
                      senderName:
                        typeof message.sender_name === "string"
                          ? message.sender_name
                          : typeof message.sender === "string"
                            ? message.sender
                            : "",
                      isSender: message.is_me === true,
                      text: typeof message.text === "string" ? message.text : "",
                      type: typeOf(typeof message.type === "string" ? message.type : "m.text"),
                      timestamp: message.timestamp,
                    },
                  ]
                : [],
            ),
          );
        } catch (error) {
          backfilled.delete(chatID); // try again on a later poll
          throw error;
        }
      }
      const live = await shaped(
        (await inbox.journal.since(chatID, since)).filter((entry) => entry.ts > since),
        await rooms([chatID]),
      );
      const found = new Map<string, ChatMessage>();
      for (const message of backfilled.get(chatID) ?? [])
        if (Date.parse(message.timestamp) > since) found.set(message.id, message);
      for (const { roomId: _room, ...message } of live) found.set(message.id, message);
      return [...found.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    },

    async accounts() {
      const seen = new Map<string, string>();
      for (const connection of await inbox.connections())
        seen.set(accountOf(connection), connection.name ?? (connection.protocolId ? "" : "Beeper"));
      return [...seen].map(([accountID, network]) => ({ accountID, network }));
    },

    async recentMessages(sinceIso, accountIDs) {
      const entries = await inbox.journal.recent(Date.parse(sinceIso), RECENT_LIMIT);
      const found = await rooms(entries.map((entry) => entry.roomId));
      const allowed = new Set(accountIDs);
      const chats: Record<string, FeedChat> = {};
      const messages: FeedMessage[] = [];
      for (const { roomId, ...message } of await shaped(entries, found)) {
        const room = found.get(roomId);
        if (!room) continue;
        const chat = feedChat(room);
        if (!allowed.has(chat.accountID)) continue;
        chats[roomId] = chat;
        messages.push({ ...message, chatID: roomId, accountID: chat.accountID });
      }
      return { messages, chats, truncated: entries.length >= RECENT_LIMIT };
    },
  };
}
