export interface RosterConfig {
  /** Bearer token MCP clients must send (at least 40 characters). */
  token: string;
  /** The public origin; a browser request from any other Origin is refused. */
  publicOrigin: string;
}

/** Reads the config from the Worker's secrets and vars (or any string map). */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): RosterConfig {
  const token = env.GROK_BOT_ROSTER_MCP_TOKEN ?? "";
  if (token.length < 40)
    throw new Error("GROK_BOT_ROSTER_MCP_TOKEN must be a strong token (40+ characters)");
  return {
    token,
    publicOrigin: new URL(
      env.GROK_BOT_ROSTER_PUBLIC_ORIGIN ?? "https://grokbot-admin.leonsilicon.ai",
    ).origin,
  };
}
