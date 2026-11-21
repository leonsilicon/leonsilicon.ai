/**
 * Slack as the Gmail feed bot, through `fetch`. Its
 * scopes: chat:write, chat:write.public, channels:read, groups:read and channels:manage.
 */

export class SlackError extends Error {
  readonly code: string;

  constructor(method: string, code: string) {
    super(`Slack ${method}: ${code}`);
    this.name = "SlackError";
    this.code = code;
  }
}

/** The slice of Slack the feed uses, so tests can pass a fake. */
export interface SlackPoster {
  /** Posts with link and media previews off, so Slack never fetches a link from an email. */
  post(channel: string, text: string, threadTs?: string): Promise<{ ts: string }>;
  /**
   * The ID of a channel given its ID or name. A missing public channel is created (or unarchived)
   * with `purpose`, and `invite` are added to it.
   */
  ensureChannel(
    nameOrId: string,
    options: { create: boolean; purpose: string; invite: string[] },
  ): Promise<{ id: string; created: boolean; problems: string[] }>;
}

const CHANNEL_ID = /^[CG][A-Z0-9]{6,}$/;

type Params = Record<string, string | number | boolean | undefined>;
type SlackResponse = { ok: boolean; error?: string; [key: string]: unknown };

interface Conversation {
  id?: string;
  name?: string;
  is_archived?: boolean;
}

export function slackBot(token: string, fetchImpl: typeof fetch = fetch): SlackPoster {
  const call = async (method: string, params: Params, retried = false): Promise<SlackResponse> => {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params))
      if (value !== undefined) body.set(key, String(value));
    const response = await fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      body,
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 429) {
      const wait = Number(response.headers.get("retry-after") ?? "1");
      if (!retried && wait <= 10) {
        await new Promise((resolve) => setTimeout(resolve, wait * 1000));
        return call(method, params, true);
      }
      throw new SlackError(method, "ratelimited");
    }
    const data = (await response.json().catch(() => null)) as SlackResponse | null;
    if (!data) throw new SlackError(method, `http_${response.status}`);
    if (!data.ok) throw new SlackError(method, data.error ?? `http_${response.status}`);
    return data;
  };

  const find = async (name: string): Promise<Conversation | undefined> => {
    let cursor: string | undefined;
    do {
      const page = await call("conversations.list", {
        types: "public_channel,private_channel",
        exclude_archived: false,
        limit: 1000,
        cursor,
      });
      const match = (page.channels as Conversation[] | undefined)?.find(
        (channel) => channel.name?.toLowerCase() === name.toLowerCase(),
      );
      if (match) return match;
      cursor =
        (page.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || undefined;
    } while (cursor);
    return undefined;
  };

  return {
    async post(channel, text, threadTs) {
      const data = await call("chat.postMessage", {
        channel,
        text,
        thread_ts: threadTs,
        unfurl_links: false,
        unfurl_media: false,
      });
      if (typeof data.ts !== "string") throw new SlackError("chat.postMessage", "no_ts");
      return { ts: data.ts };
    },

    async ensureChannel(nameOrId, { create, purpose, invite }) {
      const wanted = nameOrId.trim().replace(/^#/, "");
      if (CHANNEL_ID.test(wanted)) return { id: wanted, created: false, problems: [] };
      const existing = await find(wanted);
      if (existing?.id && !existing.is_archived)
        return { id: existing.id, created: false, problems: [] };
      if (!create) throw new SlackError("conversations.list", `no channel #${wanted}`);
      let id: string;
      if (existing?.id) {
        await call("conversations.unarchive", { channel: existing.id });
        id = existing.id;
      } else {
        const created = await call("conversations.create", { name: wanted.toLowerCase() });
        id = (created.channel as Conversation | undefined)?.id ?? "";
        if (!id) throw new SlackError("conversations.create", "no_id");
      }
      const problems: string[] = [];
      const note = (what: string) => (error: unknown) =>
        problems.push(`${what}: ${error instanceof SlackError ? error.code : String(error)}`);
      await call("conversations.setPurpose", { channel: id, purpose }).catch(note("purpose"));
      const users = [...new Set(invite.filter(Boolean))];
      if (users.length)
        await call("conversations.invite", { channel: id, users: users.join(","), force: true })
          // Hermes's slack-auto-join plugin may have joined it already.
          .catch((error: unknown) => {
            if (!(error instanceof SlackError && error.code === "already_in_channel"))
              note("invite")(error);
          });
      return { id, created: true, problems };
    },
  };
}
