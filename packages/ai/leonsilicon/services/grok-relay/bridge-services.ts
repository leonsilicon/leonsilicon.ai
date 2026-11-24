import type { BridgeServices, RosterBot } from "#slack22grokbot";

export function bridgeServices(env: Record<string, string | undefined>): BridgeServices {
  function required(key: string): string {
    const value = env[key]?.trim();
    if (!value) throw new Error(`slack22grokbot needs ${key}`);
    return value;
  }
  const slack = required("SLACK_AS_LEON_PUBLIC_ORIGIN");
  const slackToken = required("SLACK_AS_LEON_MCP_TOKEN");
  const roster = required("GROK_BOT_ROSTER_PUBLIC_ORIGIN");
  const rosterToken = required("GROK_BOT_ROSTER_MCP_TOKEN");

  async function request<T>(url: string, token: string, body: unknown): Promise<T> {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(45_000),
    });
    const result = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(result.error || `Bridge HTTP ${response.status}`);
    return result;
  }

  async function rosterCall(name: string, args: Record<string, unknown>) {
    const envelope = await request<{
      result?: { content: { text: string }[] };
    }>(`${roster}/mcp`, rosterToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const value = JSON.parse(envelope.result?.content[0]?.text ?? "{}") as {
      ok?: boolean;
      error?: string;
      refused?: string;
      bots?: RosterBot[];
    };
    if (!value.ok)
      throw new Error(value.error ?? value.refused ?? `Grok Bot admin refused ${name}`);
    return value;
  }

  return {
    slack: {
      thread: (thread, after) =>
        request(`${slack}/slack22grokbot/thread`, slackToken, { ...thread, after }),
      mirror: (thread, message) =>
        request(`${slack}/slack22grokbot/message`, slackToken, { ...thread, ...message }),
    },
    roster: {
      async list() {
        const value = await rosterCall("grok_bots_list", {});
        if (!Array.isArray(value.bots)) throw new Error("Grok Bot admin returned no roster");
        return value.bots;
      },
      async delete(bot) {
        await rosterCall("grok_bot_delete", { bot });
      },
    },
  };
}
