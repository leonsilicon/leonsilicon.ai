import fs from "node:fs";
import BeeperDesktop from "@-/com.npmjs.beeper__desktop-api";
import type { BeeperFeedSource, BeeperSource, ChatMessage, FeedChat, FeedMessage } from "#types";

export interface BeeperSourceOptions {
  baseURL: string;
  /** JSON file holding `{ "token": "..." }`, read on every call so a rotated token needs no restart. */
  tokenFile: string;
  maxPages?: number;
}

/** Beeper Desktop through Beeper's official SDK. */
export function beeperSource({
  baseURL,
  tokenFile,
  maxPages = 5,
}: BeeperSourceOptions): BeeperSource & BeeperFeedSource {
  let cached: { token: string; client: BeeperDesktop } | null = null;
  const client = (): BeeperDesktop => {
    const token = readToken(tokenFile);
    if (cached?.token !== token)
      cached = {
        token,
        client: new BeeperDesktop({ baseURL, accessToken: token, timeout: 20_000, maxRetries: 1 }),
      };
    return cached.client;
  };

  return {
    async chat(chatID) {
      const chat = await client().chats.retrieve(chatID, { maxParticipantCount: 0 });
      return { id: chat.id, title: chat.title, network: chat.network, type: chat.type };
    },

    async messagesSince(chatID, sinceIso) {
      const since = Date.parse(sinceIso);
      const found = new Map<string, ChatMessage>();
      let page = await client().messages.list(chatID);
      for (let pages = 1; ; pages++) {
        let reachedOlder = false;
        for (const message of page.getPaginatedItems()) {
          if (Date.parse(message.timestamp) <= since) {
            reachedOlder = true;
            continue;
          }
          if (message.isDeleted || message.isHidden) continue;
          found.set(message.id, {
            id: message.id,
            senderName: message.senderName ?? message.senderID,
            isSender: message.isSender === true,
            text: message.text ?? "",
            type: message.type ?? "TEXT",
            timestamp: message.timestamp,
          });
        }
        if (reachedOlder || pages >= maxPages || !page.hasNextPage()) break;
        page = await page.getNextPage();
      }
      return [...found.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    },

    async accounts() {
      const accounts = await client().accounts.list();
      return accounts.map((account) => ({
        accountID: account.accountID,
        network: account.network ?? "",
      }));
    },

    async recentMessages(sinceIso, accountIDs, maxSearchPages = 25) {
      const messages = new Map<string, FeedMessage>();
      const chats: Record<string, FeedChat> = {};
      let cursor: string | null = null;
      let truncated = false;
      for (let pages = 0; ; pages++) {
        if (pages >= maxSearchPages) {
          truncated = true;
          break;
        }
        // Newest first; each page also carries the chats its messages are in.
        const page = await client().messages.search({
          dateAfter: sinceIso,
          accountIDs,
          excludeLowPriority: false,
          includeMuted: true,
          limit: 20,
          ...(cursor ? { cursor, direction: "before" } : {}),
        });
        const body = (page as unknown as { body?: { chats?: Record<string, RawChat> } }).body;
        for (const [id, chat] of Object.entries(body?.chats ?? {})) chats[id] = feedChat(id, chat);
        for (const message of page.items) {
          if (message.isDeleted || message.isHidden) continue;
          messages.set(message.id, {
            id: message.id,
            chatID: message.chatID,
            accountID: message.accountID,
            senderName: message.senderName ?? message.senderID,
            isSender: message.isSender === true,
            text: message.text ?? "",
            type: message.type ?? "TEXT",
            timestamp: message.timestamp,
          });
        }
        if (!page.hasMore || !page.oldestCursor) break;
        cursor = page.oldestCursor;
      }
      const sorted = [...messages.values()].sort(
        (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
      );
      return { messages: sorted, chats, truncated };
    },
  };
}

interface RawChat {
  accountID?: string;
  title?: string;
  network?: string;
  type?: string;
  isMuted?: boolean;
}

function feedChat(id: string, chat: RawChat): FeedChat {
  return {
    id,
    accountID: chat.accountID ?? "",
    title: chat.title ?? "(untitled chat)",
    network: chat.network ?? "",
    type: chat.type ?? "",
    isMuted: chat.isMuted === true,
  };
}

function readToken(file: string): string {
  let token: unknown;
  try {
    token = (JSON.parse(fs.readFileSync(file, "utf8")) as { token?: unknown }).token;
  } catch (error) {
    throw new Error(`Cannot read the Beeper token file ${file}: ${(error as Error).message}`);
  }
  if (typeof token !== "string" || !token)
    throw new Error(`The Beeper token file ${file} has no token`);
  return token;
}
