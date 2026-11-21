import os from "node:os";

export interface OrcaBridgeConfig {
  /** Bearer token clients must send (at least 40 characters). */
  token: string;
  port: number;
  /** The public origin; a browser request from any other Origin is refused. */
  publicOrigin: string;
  /** The `orca` CLI. */
  orcaBin: string;
  /** Where CLI calls run. */
  workingDirectory: string;
  /** Saved Orca environments `--environment` may name; without one, calls go to this machine's Orca. */
  environments: readonly string[];
  /** Longest a single call may take: stays under Hermes Cloud's 180 s MCP timeout. */
  maxCallMs: number;
  /** Environment for orca-mcp's tools (ORCA_MCP_ROOTS, ORCA_MCP_CLIENT, ORCA_BIN). */
  env: NodeJS.ProcessEnv;
  /**
   * Where these tools run: on the mini (this bridge, the default), or on Hermes Cloud's own Orca
   * device (`@-/ai.leonsilicon.services.orca-device`), which reaches both Macs directly.
   */
  host?: "mini" | "hermes-cloud";
}

export const DEFAULT_ORCA_BIN = "/Applications/Orca.app/Contents/Resources/bin/orca";

/** Reads the config from the environment (the LaunchAgent loads `~/.config/orca-bridge/env`). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): OrcaBridgeConfig {
  const token = env.ORCA_BRIDGE_TOKEN ?? "";
  if (token.length < 40)
    throw new Error("ORCA_BRIDGE_TOKEN must be a strong token (40+ characters)");
  return {
    token,
    port: Number(env.ORCA_BRIDGE_PORT ?? 18787),
    publicOrigin: new URL(env.ORCA_BRIDGE_PUBLIC_ORIGIN ?? "https://orca.leonsilicon.ai").origin,
    orcaBin: env.ORCA_BIN ?? DEFAULT_ORCA_BIN,
    workingDirectory: env.ORCA_BRIDGE_CWD ?? os.homedir(),
    environments: (env.ORCA_BRIDGE_ENVIRONMENTS ?? "MacBook")
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean),
    maxCallMs: Number(env.ORCA_BRIDGE_MAX_CALL_MS ?? 170_000),
    env: { ...env, ORCA_MCP_CLIENT: env.ORCA_MCP_CLIENT ?? "hermes-cloud" },
  };
}
