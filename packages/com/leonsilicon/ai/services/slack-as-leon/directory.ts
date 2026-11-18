import type { SlackCall } from "#slack";

export interface SlackUser {
  id: string;
  /** Display name, falling back to the real name and then the handle. */
  name: string;
  /** Every name Slack shows for the user, for lookups. */
  names: readonly string[];
  isBot: boolean;
}

interface RawUser {
  id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: { display_name?: string; real_name?: string };
}

interface RawConversation {
  id?: string;
  name?: string;
  user?: string;
  is_archived?: boolean;
}

interface Cached<T> {
  at: number;
  value: T;
}

const TTL_MS = 10 * 60_000;

function shapeUser(raw: RawUser): SlackUser | null {
  if (!raw.id || raw.deleted) return null;
  const names = [raw.profile?.display_name, raw.real_name, raw.profile?.real_name, raw.name]
    .map((n) => n?.trim() ?? "")
    .filter(Boolean);
  return {
    id: raw.id,
    name: names[0] ?? raw.id,
    names: [...new Set(names)],
    isBot: raw.is_bot === true || raw.id === "USLACKBOT",
  };
}

async function paginate<T>(
  slack: SlackCall,
  method: string,
  key: string,
  params: Record<string, string | number | boolean>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor = "";
  for (let page = 0; page < 20; page++) {
    const data = await slack(method, { ...params, ...(cursor ? { cursor } : {}) });
    items.push(...((data[key] as T[] | undefined) ?? []));
    cursor = (data.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "";
    if (!cursor) break;
  }
  return items;
}

/** Leon's view of the workspace's people, bots and conversations, cached for ten minutes. */
export class Directory {
  readonly #slack: SlackCall;
  readonly #now: () => number;
  #users?: Cached<Map<string, SlackUser>>;
  #channels?: Cached<RawConversation[]>;
  #ims?: Cached<Map<string, string>>;

  constructor(slack: SlackCall, now: () => number = Date.now) {
    this.#slack = slack;
    this.#now = now;
  }

  #fresh<T>(cached: Cached<T> | undefined): T | undefined {
    return cached && this.#now() - cached.at < TTL_MS ? cached.value : undefined;
  }

  async users(): Promise<Map<string, SlackUser>> {
    const cached = this.#fresh(this.#users);
    if (cached) return cached;
    const raw = await paginate<RawUser>(this.#slack, "users.list", "members", { limit: 200 });
    const users = new Map<string, SlackUser>();
    for (const user of raw.map(shapeUser)) if (user) users.set(user.id, user);
    this.#users = { at: this.#now(), value: users };
    return users;
  }

  async user(id: string): Promise<SlackUser | undefined> {
    const known = (await this.users()).get(id);
    if (known) return known;
    try {
      const data = await this.#slack("users.info", { user: id });
      const user = shapeUser(data.user as RawUser);
      if (user) (await this.users()).set(user.id, user);
      return user ?? undefined;
    } catch {
      return undefined;
    }
  }

  async bots(): Promise<SlackUser[]> {
    return [...(await this.users()).values()].filter((u) => u.isBot && u.id !== "USLACKBOT");
  }

  /** A person or bot by any of their names (case-insensitive, exact). */
  async userByName(name: string): Promise<SlackUser | undefined> {
    const wanted = name.trim().toLowerCase();
    return [...(await this.users()).values()].find((u) =>
      u.names.some((n) => n.toLowerCase() === wanted),
    );
  }

  /** A channel Leon can see, by name without the `#`. */
  async channelByName(name: string): Promise<string | undefined> {
    let channels = this.#fresh(this.#channels);
    if (!channels) {
      channels = await paginate<RawConversation>(this.#slack, "conversations.list", "channels", {
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 1000,
      });
      this.#channels = { at: this.#now(), value: channels };
    }
    const wanted = name.trim().replace(/^#/, "").toLowerCase();
    return channels.find((c) => c.name?.toLowerCase() === wanted)?.id;
  }

  /** Leon's existing DM channel with each user, by user ID. */
  async ims(): Promise<Map<string, string>> {
    const cached = this.#fresh(this.#ims);
    if (cached) return cached;
    const raw = await paginate<RawConversation>(this.#slack, "conversations.list", "channels", {
      types: "im",
      limit: 1000,
    });
    const ims = new Map<string, string>();
    for (const c of raw) if (c.id && c.user) ims.set(c.user, c.id);
    this.#ims = { at: this.#now(), value: ims };
    return ims;
  }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Turns plain-text `@Task Bot` into a real `<@U…>` mention for bots only, longest names first.
 * A plain "@name" in an API post reaches nobody, and the Grok bots only answer real mentions.
 */
export function linkBotMentions(text: string, bots: readonly SlackUser[]): string {
  const names = bots
    .flatMap((bot) => bot.names.map((name) => ({ id: bot.id, name })))
    .filter(({ name }) => name.length >= 3)
    .sort((a, b) => b.name.length - a.name.length);
  let out = text;
  for (const { id, name } of names)
    out = out.replace(
      new RegExp(`(^|[\\s(\\[,;:])@${escapeRegExp(name)}(?![\\p{L}\\p{N}_-])`, "giu"),
      `$1<@${id}>`,
    );
  return out;
}
