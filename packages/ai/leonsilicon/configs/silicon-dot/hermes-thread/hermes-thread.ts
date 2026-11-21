import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";

/**
 * The Codex sessions Silicon Dot starts on Leon's MacBook (inside the ChatGPT app) reach
 * slack-puppet's agent tools through this: a stdio MCP server Codex launches, which forwards every
 * message to slack-puppet over HTTPS with the Codex token. The token lives in the login Keychain,
 * never in Codex's config or an environment variable.
 */

export const SLACK_PUPPET_URL = "https://slack-puppet.leonsilicon.ai/mcp";
/** Login Keychain service holding slack-puppet's Codex token (`SLACK_AS_LEON_CODEX_TOKEN`). */
export const KEYCHAIN_SERVICE = "silicon-dot-slack-puppet";
/** The server's name in `~/.codex/config.toml`, and so in Codex's tool names. */
export const SERVER_NAME = "slack-puppet";

/** The token from the login Keychain, or null when it isn't there. */
export function keychainToken(): string | null {
  const found = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-a", userInfo().username, "-s", KEYCHAIN_SERVICE, "-w"],
    { encoding: "utf8" },
  );
  const token = found.status === 0 ? found.stdout.trim() : "";
  return token || null;
}

/**
 * Forwards one JSON-RPC message (a line from Codex) and returns the lines to write back: none for a
 * notification, the answer otherwise. A failure becomes a JSON-RPC error for a request with an id,
 * so Codex reports it instead of waiting.
 */
export async function forward(
  line: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
  url = SLACK_PUPPET_URL,
): Promise<string[]> {
  let id: unknown = null;
  try {
    const message = JSON.parse(line) as { id?: unknown };
    id = message?.id ?? null;
  } catch {
    return [];
  }
  const failure = (text: string) =>
    id === null || id === undefined
      ? []
      : [JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: text } })];
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: line,
    });
  } catch (error) {
    return failure(`slack-puppet is unreachable: ${(error as Error).message}`);
  }
  if (response.status === 202 || response.status === 204) return [];
  const body = await response.text();
  if (!response.ok)
    return failure(
      response.status === 401
        ? "slack-puppet refused the Codex token; rerun the hermes-thread installer (see its README)"
        : `slack-puppet answered HTTP ${response.status}: ${body.slice(0, 200)}`,
    );
  if ((response.headers.get("content-type") ?? "").includes("text/event-stream"))
    return body
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => l.slice(6).trim())
      .filter(Boolean);
  return body.trim() ? [body.trim()] : [];
}

/** `~/.codex/config.toml` with this server's section added or replaced, and everything else kept. */
export function withServerSection(toml: string, nodePath: string, scriptPath: string): string {
  const lines = toml.split("\n");
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      const name = header[1]?.trim() ?? "";
      skipping =
        name === `mcp_servers.${SERVER_NAME}` || name.startsWith(`mcp_servers.${SERVER_NAME}.`);
    }
    if (!skipping) kept.push(line);
  }
  while (kept.length && kept.at(-1)?.trim() === "") kept.pop();
  const section = [
    `[mcp_servers.${SERVER_NAME}]`,
    "# Talk to Hermes in a task's Slack thread (leonsilicon.ai: configs/silicon-dot/hermes-thread).",
    `command = ${JSON.stringify(nodePath)}`,
    `args = [${JSON.stringify(scriptPath)}]`,
    "startup_timeout_sec = 20",
    // hermes_thread_send and _read wait up to 150 s for Hermes.
    "tool_timeout_sec = 180",
  ];
  return `${kept.join("\n")}\n\n${section.join("\n")}\n`;
}
