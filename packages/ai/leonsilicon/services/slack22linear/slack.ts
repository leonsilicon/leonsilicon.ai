import { SlackError } from "@-/ai.leonsilicon.services.slack-as-leon";
import type {
  SlackCall,
  SlackParams,
  SlackResponse,
} from "@-/ai.leonsilicon.services.slack-as-leon";

export { SlackError };
export type { SlackCall, SlackParams, SlackResponse };

const MAX_RETRY_AFTER_SECONDS = 10;

/** Slack's Web API with a bot token (`xoxb-`), form-encoded. One retry after a short 429. */
export function botClient(token: string, fetchImpl: typeof fetch = fetch): SlackCall {
  const call = async (method: string, params: SlackParams = {}, retried = false) => {
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
      if (!retried && wait <= MAX_RETRY_AFTER_SECONDS) {
        await new Promise((resolve) => setTimeout(resolve, wait * 1000));
        return call(method, params, true);
      }
      throw new SlackError(method, "ratelimited");
    }
    let data: SlackResponse;
    try {
      data = (await response.json()) as SlackResponse;
    } catch {
      throw new SlackError(method, `http_${response.status}`);
    }
    if (!data.ok) throw new SlackError(method, data.error ?? `http_${response.status}`);
    return data;
  };
  return (method, params) => call(method, params);
}

/** Runs a call and treats the listed Slack error codes as success. */
export async function tolerate(
  call: Promise<SlackResponse>,
  codes: string[],
): Promise<SlackResponse | null> {
  try {
    return await call;
  } catch (error) {
    if (error instanceof SlackError && codes.includes(error.code)) return null;
    throw error;
  }
}

export interface Section {
  id: string;
  name: string;
  type: string;
  next: string | null;
  channelIds: string[];
}

/**
 * Leon's personal sidebar sections, through the web client's own `users.channelSections.*`
 * methods. Slack has no public API for these, so they need his web session (`xoxc-` + `d`).
 */
export class Sidebar {
  readonly #session: SlackCall;

  constructor(session: SlackCall) {
    this.#session = session;
  }

  /** Sections in sidebar order, top to bottom. */
  async list(): Promise<Section[]> {
    const data = await this.#session("users.channelSections.list");
    const raw = data.channel_sections as {
      channel_section_id: string;
      name: string;
      type: string;
      next_channel_section_id: string | null;
      channel_ids_page?: { channel_ids?: string[] };
    }[];
    const sections = raw.map((s) => ({
      id: s.channel_section_id,
      name: s.name,
      type: s.type,
      next: s.next_channel_section_id || null,
      channelIds: s.channel_ids_page?.channel_ids ?? [],
    }));
    const byId = new Map(sections.map((s) => [s.id, s]));
    const pointedTo = new Set(sections.map((s) => s.next));
    const ordered: Section[] = [];
    let current = sections.find((s) => !pointedTo.has(s.id));
    while (current && !ordered.includes(current)) {
      ordered.push(current);
      current = current.next ? byId.get(current.next) : undefined;
    }
    for (const s of sections) if (!ordered.includes(s)) ordered.push(s);
    return ordered;
  }

  /**
   * Makes sure a custom section exists for each wanted name, placed by `order` so the managed
   * sections form one block. A missing one goes next to its nearest existing neighbour in `order`,
   * or at the top when none exist yet. Returns the sections after any changes.
   */
  async ensure(order: string[], wanted: string[] = order): Promise<Section[]> {
    let sections = await this.list();
    const custom = () =>
      new Map(sections.filter((s) => s.type === "standard").map((s) => [s.name, s]));
    for (let i = 0; i < order.length; i++) {
      const name = order[i]!;
      if (!wanted.includes(name) || custom().has(name)) continue;
      const existing = custom();
      const after = order.slice(i + 1).find((n) => existing.has(n));
      const before = order
        .slice(0, i)
        .reverse()
        .find((n) => existing.has(n));
      let next: string | null;
      if (after) next = existing.get(after)!.id;
      else if (before) next = existing.get(before)!.next;
      else next = sections[0]?.id ?? null;
      const params: SlackParams = { name, emoji: "" };
      if (next) params.next_channel_section_id = next;
      const created = await this.#session("users.channelSections.create", params);
      // `create` can't put a section above the topmost one; `set` moves it in front of any section.
      if (next)
        await this.#session("users.channelSections.set", {
          channel_section_id: created.channel_section_id as string,
          next_channel_section_id: next,
        });
      sections = await this.list();
    }
    return sections;
  }

  /**
   * Puts a channel in a custom section, taking it out of every other custom section. Managed
   * sections (`managed` names) left empty by the move are deleted, so no empty headers linger.
   */
  async move(
    channelId: string,
    name: string,
    sections: Section[],
    managed: string[],
  ): Promise<void> {
    const target = sections.find((s) => s.type === "standard" && s.name === name);
    if (!target) throw new Error(`no sidebar section named ${name}`);
    const holding = sections.filter(
      (s) => s.type === "standard" && s.id !== target.id && s.channelIds.includes(channelId),
    );
    if (!target.channelIds.includes(channelId) || holding.length) {
      const params: SlackParams = {
        insert: JSON.stringify([{ channel_section_id: target.id, channel_ids: [channelId] }]),
      };
      if (holding.length)
        params.remove = JSON.stringify(
          holding.map((s) => ({ channel_section_id: s.id, channel_ids: [channelId] })),
        );
      await this.#session("users.channelSections.channels.bulkUpdate", params);
    }
    await this.#dropEmpty(holding, managed);
  }

  /** Takes a channel out of every custom section, deleting managed sections it leaves empty. */
  async release(channelId: string, managed: string[]): Promise<void> {
    const holding = (await this.list()).filter(
      (s) => s.type === "standard" && s.channelIds.includes(channelId),
    );
    if (!holding.length) return;
    await this.#session("users.channelSections.channels.bulkUpdate", {
      remove: JSON.stringify(
        holding.map((s) => ({ channel_section_id: s.id, channel_ids: [channelId] })),
      ),
    });
    await this.#dropEmpty(holding, managed);
  }

  async #dropEmpty(left: Section[], managed: string[]): Promise<void> {
    for (const s of left)
      if (managed.includes(s.name) && s.channelIds.length === 1)
        await this.#session("users.channelSections.delete", { channel_section_id: s.id });
  }
}
