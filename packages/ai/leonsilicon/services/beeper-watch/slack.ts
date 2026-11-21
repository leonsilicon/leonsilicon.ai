import { WebClient } from "@-/com.npmjs.slack__web-api";
import type { SlackChannel, SlackPoster } from "#types";

const CHANNEL_ID = /^[CG][A-Z0-9]{6,}$/;

interface Conversation {
  id?: string;
  name?: string;
  is_private?: boolean;
  is_member?: boolean;
  is_archived?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
}

/** Slack as the Beeper Watch bot, through Slack's official Web API client. */
export function slackPoster(
  token: string,
): SlackPoster & { identity(): Promise<{ userId: string; team: string; teamId: string }> } {
  const client = new WebClient(token, { retryConfig: { retries: 3 } });

  const shape = (channel: Conversation): SlackChannel => {
    if (!channel.id || !channel.name)
      throw new Error("Slack returned a conversation without an ID or name");
    return {
      id: channel.id,
      name: channel.name,
      isPrivate: channel.is_private === true,
      isMember: channel.is_member === true,
    };
  };

  const byId = async (id: string): Promise<SlackChannel> => {
    const info = await client.conversations.info({ channel: id });
    const channel = info.channel as Conversation | undefined;
    if (!channel || channel.is_im || channel.is_mpim) throw new Error(`${id} is not a channel`);
    return shape(channel);
  };

  /** The channel with this name that the bot can see, archived ones too when asked. */
  const find = async (name: string, archived: boolean): Promise<Conversation | undefined> => {
    let cursor: string | undefined;
    do {
      const page = await client.conversations.list({
        types: "public_channel,private_channel",
        exclude_archived: !archived,
        limit: 1000,
        cursor,
      });
      const match = (page.channels as Conversation[] | undefined)?.find(
        (channel) => channel.name?.toLowerCase() === name.toLowerCase(),
      );
      if (match) return match;
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return undefined;
  };

  const problem = (what: string, error: unknown): string =>
    `${what}: ${(error as { data?: { error?: string } }).data?.error ?? (error as Error).message}`;

  return {
    async identity() {
      const auth = await client.auth.test();
      if (!auth.user_id) throw new Error("Slack auth.test returned no user ID");
      return { userId: auth.user_id, team: auth.team ?? "", teamId: auth.team_id ?? "" };
    },

    async channel(nameOrId) {
      const wanted = nameOrId.trim().replace(/^#/, "");
      if (CHANNEL_ID.test(wanted)) return byId(wanted);
      const match = await find(wanted, false);
      if (match) return shape(match);
      throw new Error(
        `No Slack channel named #${wanted} that Beeper Watch can see. Private channels need /invite @Beeper Watch first.`,
      );
    },

    async ensureChannel(nameOrId, { invite, purpose }) {
      const wanted = nameOrId.trim().replace(/^#/, "");
      if (CHANNEL_ID.test(wanted)) return byId(wanted);
      const existing = await find(wanted, true);
      if (existing && !existing.is_archived) return shape(existing);
      let channel: Conversation;
      if (existing) {
        await client.conversations.unarchive({ channel: existing.id ?? "" });
        channel = { ...existing, is_archived: false };
      } else {
        const created = await client.conversations.create({ name: wanted.toLowerCase() });
        channel = created.channel as Conversation;
      }
      const id = channel.id ?? "";
      const problems: string[] = [];
      if (purpose)
        await client.conversations
          .setPurpose({ channel: id, purpose })
          .catch((error: unknown) => problems.push(problem("purpose", error)));
      const users = [...new Set(invite.filter(Boolean))];
      if (users.length > 0)
        await client.conversations
          .invite({ channel: id, users: users.join(","), force: true })
          .catch((error: unknown) => {
            // Hermes may have joined on its own already (its slack-auto-join plugin does).
            if ((error as { data?: { error?: string } }).data?.error !== "already_in_channel")
              problems.push(problem("invite", error));
          });
      return { ...shape({ ...channel, is_member: true }), created: true, problems };
    },

    async post(channel, text, threadTs) {
      const result = await client.chat.postMessage({
        channel,
        text,
        thread_ts: threadTs,
        unfurl_links: false,
        unfurl_media: false,
      });
      if (!result.ts) throw new Error("Slack accepted the message but returned no ts");
      return { ts: result.ts };
    },
  };
}
