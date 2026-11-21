import type { GrokBotApi } from "#api";

/** A bot as `ListGrokBotAgents` returns it (the fields used here). */
export interface ApiBot {
  /** The numeric ID the API takes, as a string. */
  id: string;
  /** The bot's UUID, which a bot sees as its own ID. */
  agentId?: string;
  name?: string;
  description?: string;
  createdAtMs?: string;
  kind?: string;
  viewerIsOwner?: boolean;
  sharedWithOthers?: boolean;
  visibility?: unknown;
}

export interface Bot {
  id: string;
  agent_id: string | null;
  name: string;
  created_at: string | null;
}

export interface DeleteArgs {
  /** The bot's ID or agent ID (UUID). */
  bot: string;
}

/** A refused request, with a message written for the bot that asked. */
export class Refused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refused";
  }
}

export interface RosterOptions {
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/** Leon's Grok Bot bots: lists them and deletes any of them. */
export class Roster {
  private readonly api: GrokBotApi;
  private readonly log: (event: string, fields: Record<string, unknown>) => void;

  constructor(api: GrokBotApi, options: RosterOptions = {}) {
    this.api = api;
    this.log =
      options.log ?? ((event, fields) => console.log(JSON.stringify({ event, ...fields })));
  }

  private async apiBots(): Promise<ApiBot[]> {
    const response = await this.api.call<{ agents?: ApiBot[] }>("ListGrokBotAgents", {});
    return response.agents ?? [];
  }

  async list(): Promise<Bot[]> {
    return (await this.apiBots()).map(view);
  }

  async delete(args: DeleteArgs): Promise<{ ok: true; deleted: Bot }> {
    const wanted = args.bot.trim();
    if (!wanted) throw new Refused("Say which bot: its ID or agent ID (grok_bots_list has both).");
    const bot = (await this.apiBots()).find((b) => b.id === wanted || b.agentId === wanted);
    if (!bot)
      throw new Refused(
        `No bot has the ID ${JSON.stringify(wanted)}. Call grok_bots_list for the current IDs.`,
      );
    const name = bot.name ?? "";
    await this.api.call("DeleteGrokBotAgent", { id: bot.id });
    this.log("deleted", { id: bot.id, agent_id: bot.agentId ?? null, name });
    return { ok: true, deleted: view(bot) };
  }
}

function view(bot: ApiBot): Bot {
  const created = Number(bot.createdAtMs);
  return {
    id: bot.id,
    agent_id: bot.agentId ?? null,
    name: bot.name ?? "",
    created_at: Number.isFinite(created) && created > 0 ? new Date(created).toISOString() : null,
  };
}
