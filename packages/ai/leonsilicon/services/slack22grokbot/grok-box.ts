import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import type { RelayLog } from "#types";

/**
 * Keeps grok-box-browser (apps/hermes-plugin-grok-box-browser) set up in the Grok Bot cloud
 * computer. Every Grok bot runs in that machine, so while its broker is down the relay adds the
 * verified setup command to the next message it sends a bot. When Hermes's browser finds the box
 * down and no message is going out, the plugin leaves a repair request and the keeper sends the
 * setup to the parent bot on its own, at most once an hour.
 */

const HEALTH_CACHE_MS = 60_000;
/** After asking for the setup, give it this long before asking again. */
const UPKEEP_EVERY_MS = 30 * 60_000;
const REPAIR_EVERY_MS = 60 * 60_000;
/** A repair counts as failed if the broker isn't healthy this long after it was sent. */
const VERIFY_AFTER_MS = 5 * 60_000;
const RETRY_AFTER_MS = 5 * 60_000;
const MIRROR = "https://raw.githubusercontent.com/leonsiliconAI/hermes-plugin-grok-box-browser";
export const REPAIR_BOT = "Grok Bot";

export interface BoxSettings {
  token: string;
  host: string;
  port: number;
  tailscale: string;
  socket: string;
  oauthId: string;
  oauthSecret: string;
  /** Hermes's install of the plugin, whose box files the setup pins. */
  pluginDir: string;
  /** Where the plugin and the keeper leave each other the repair request and status. */
  shared: string;
}

/** The settings, from Hermes's own `.env` (the plugin reads the same keys), or null when unset. */
export function boxSettings(processEnv: NodeJS.ProcessEnv = process.env): BoxSettings | null {
  const hermesHome = processEnv.HERMES_HOME || "/opt/data";
  let env: Record<string, string | undefined> = {};
  try {
    env = parseEnv(readFileSync(processEnv.GROK_BOX_ENV_FILE || join(hermesHome, ".env"), "utf8"));
  } catch {
    return null;
  }
  const token = env.GROK_BOX_BROWSER_TOKEN?.trim();
  if (!token) return null;
  return {
    token,
    host: env.GROK_BOX_BROWSER_HOST?.trim() || "grok-box",
    port: Number(env.GROK_BOX_BROWSER_PORT || 9400),
    tailscale:
      env.GROK_BOX_TAILSCALE?.trim() || join(hermesHome, "orca-device/tailscale/bin/tailscale"),
    socket:
      env.GROK_BOX_TAILSCALE_SOCKET?.trim() ||
      join(hermesHome, "orca-device/tailscale/tailscaled.sock"),
    oauthId: env.GROK_BOX_TS_OAUTH_CLIENT_ID?.trim() ?? "",
    oauthSecret: env.GROK_BOX_TS_OAUTH_CLIENT_SECRET?.trim() ?? "",
    pluginDir: join(hermesHome, "plugins/grok-box-browser"),
    shared: join(hermesHome, "grok-box-browser"),
  };
}

export interface Release {
  commit: string;
  up: string;
  broker: string;
}

/** The setup a bot runs in its terminal: download the pinned box files, check them, run up.sh. */
export function setupCommand(release: Release, token: string, joinKey?: string): string {
  const key = joinKey ? `; printf %s '${joinKey}' > ../tailscale-authkey` : "";
  return [
    "bash -euo pipefail <<'SETUP'",
    "mkdir -p /workspace/hermes-browsers/box && cd /workspace/hermes-browsers/box",
    `base=${MIRROR}/${release.commit}/box`,
    'curl -fsSLO "$base/up.sh"; curl -fsSLO "$base/broker.mjs"',
    `printf '%s  up.sh\\n%s  broker.mjs\\n' ${release.up} ${release.broker} | sha256sum -c -`,
    `umask 077; printf %s '${token}' > ../token${key}`,
    "bash up.sh",
    "SETUP",
  ].join("\n");
}

/** Put before a message's own text while the box is down. */
export function upkeepBlock(command: string): string {
  return [
    "[Before anything else, yourself] Hermes's browser service in this cloud computer is down. Run this in your own terminal first and include its last line in your reply. Don't print the token or key files.",
    "```bash",
    command,
    "```",
  ].join("\n");
}

/** The parent bot's message when only the repair is needed. */
export function repairMessage(command: string): string {
  return [
    "Run this in your own cloud computer's terminal and reply with only its last five lines. It restarts my browser service in /workspace/hermes-browsers. Don't print the token or key files.",
    "```bash",
    command,
    "```",
  ].join("\n");
}

export interface BoxDeps {
  /** Runs a command and returns its stdout. */
  exec(file: string, args: readonly string[]): Promise<string>;
  /** Sends `request` over a `tailscale nc` connection and returns what came back. */
  nc(settings: BoxSettings, request: string, timeoutMs: number): Promise<string>;
  fetch: typeof fetch;
  readFile(path: string): string;
  now(): number;
}

export const defaultBoxDeps: BoxDeps = {
  exec: (file, args) =>
    new Promise((resolve, reject) =>
      execFile(file, [...args], { timeout: 20_000, maxBuffer: 4 << 20 }, (error, stdout) =>
        error ? reject(error) : resolve(stdout),
      ),
    ),
  nc: (settings, request, timeoutMs) =>
    new Promise((resolve) => {
      const child = spawn(
        settings.tailscale,
        [`--socket=${settings.socket}`, "nc", settings.host, String(settings.port)],
        { stdio: ["pipe", "pipe", "ignore"] },
      );
      let out = "";
      const done = () => {
        clearTimeout(timer);
        child.kill();
        resolve(out);
      };
      const timer = setTimeout(done, timeoutMs);
      child.stdout.on("data", (data: Buffer) => {
        out += data.toString("utf8");
      });
      child.on("close", done);
      child.on("error", done);
      child.stdin.end(request);
    }),
  fetch: (input, init) => fetch(input, init),
  readFile: (path) => readFileSync(path, "utf8"),
  now: () => Date.now(),
};

export async function boxHealthy(settings: BoxSettings, deps: BoxDeps): Promise<boolean> {
  const answer = await deps.nc(
    settings,
    "GET /health HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    8000,
  );
  return /^HTTP\/1\.[01] 200/.test(answer) && answer.includes('"ok":true');
}

/** Whether the box is on the tailnet: false means a fresh join key is needed. */
export async function boxOnline(settings: BoxSettings, deps: BoxDeps): Promise<boolean | null> {
  try {
    const status = JSON.parse(
      await deps.exec(settings.tailscale, [`--socket=${settings.socket}`, "status", "--json"]),
    ) as { Peer?: Record<string, { HostName?: string; DNSName?: string; Online?: boolean }> };
    const peers = Object.values(status.Peer ?? {});
    const box = peers.find(
      (peer) => peer.HostName === settings.host || peer.DNSName?.split(".")[0] === settings.host,
    );
    return box ? Boolean(box.Online) : false;
  } catch {
    return null;
  }
}

/** The installed plugin's commit and the sha256 of its box files, which the mirror serves at that commit. */
export async function installedRelease(settings: BoxSettings, deps: BoxDeps): Promise<Release> {
  const commit = (await deps.exec("git", ["-C", settings.pluginDir, "rev-parse", "HEAD"])).trim();
  if (!/^[0-9a-f]{40}$/.test(commit))
    throw new Error("grok-box-browser isn't installed from its mirror");
  const sha = (file: string) =>
    createHash("sha256")
      .update(deps.readFile(join(settings.pluginDir, "box", file)))
      .digest("hex");
  return { commit, up: sha("up.sh"), broker: sha("broker.mjs") };
}

/** A one-time, pre-approved join key for tag:grok-box, from the Tailscale OAuth client. */
export async function mintJoinKey(settings: BoxSettings, deps: BoxDeps): Promise<string> {
  if (!settings.oauthId || !settings.oauthSecret) throw new Error("no Tailscale OAuth client");
  const tokenResponse = await deps.fetch("https://api.tailscale.com/api/v2/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: settings.oauthId,
      client_secret: settings.oauthSecret,
      grant_type: "client_credentials",
    }),
  });
  const { access_token: access } = (await tokenResponse.json()) as { access_token?: string };
  if (!tokenResponse.ok || !access)
    throw new Error(`Tailscale OAuth answered ${tokenResponse.status}`);
  const keyResponse = await deps.fetch("https://api.tailscale.com/api/v2/tailnet/-/keys", {
    method: "POST",
    headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
    body: JSON.stringify({
      description: "grok-box repair",
      expirySeconds: 3600,
      capabilities: {
        devices: {
          create: {
            reusable: false,
            ephemeral: false,
            preauthorized: true,
            tags: ["tag:grok-box"],
          },
        },
      },
    }),
  });
  const { key } = (await keyResponse.json()) as { key?: string };
  if (!keyResponse.ok || !key)
    throw new Error(`Tailscale key creation answered ${keyResponse.status}`);
  return key;
}

interface KeeperState {
  upkeepAt?: number;
  repairAt?: number;
  verifyAt?: number;
  retryAt?: number;
  failures?: number;
  result?: "ok" | "failed" | "sent" | "skipped";
  detail?: string;
}

export interface BoxKeeper {
  /** Text to put before an outgoing Grok message: empty unless the box needs its setup. */
  upkeep(): Promise<string>;
  /** Handles a repair request from the plugin and checks a sent repair. */
  tick(send: (bot: string, text: string) => Promise<void>): Promise<void>;
  status(): KeeperState & { configured: boolean };
}

export function createBoxKeeper(options: {
  stateFile: string;
  log: RelayLog;
  settings?: () => BoxSettings | null;
  deps?: BoxDeps;
}): BoxKeeper {
  const deps = options.deps ?? defaultBoxDeps;
  const settingsOf = options.settings ?? (() => boxSettings());
  let state: KeeperState = {};
  try {
    state = JSON.parse(readFileSync(options.stateFile, "utf8")) as KeeperState;
  } catch {}
  let health: { at: number; ok: boolean } | null = null;

  function save(settings: BoxSettings | null) {
    mkdirSync(dirname(options.stateFile), { recursive: true });
    writeFileSync(`${options.stateFile}.tmp`, JSON.stringify(state));
    renameSync(`${options.stateFile}.tmp`, options.stateFile);
    if (!settings) return;
    // What the plugin tells Hermes when its browser can't reach the box.
    mkdirSync(settings.shared, { recursive: true });
    writeFileSync(
      join(settings.shared, "repair-status.json"),
      JSON.stringify({
        repairAt: state.repairAt ?? null,
        failures: state.failures ?? 0,
        result: state.result ?? null,
        detail: state.detail ?? null,
      }),
    );
  }

  async function healthy(settings: BoxSettings, fresh = false): Promise<boolean> {
    if (!fresh && health && deps.now() - health.at < HEALTH_CACHE_MS) return health.ok;
    health = { at: deps.now(), ok: await boxHealthy(settings, deps).catch(() => false) };
    return health.ok;
  }

  async function command(settings: BoxSettings): Promise<string> {
    const release = await installedRelease(settings, deps);
    let key: string | undefined;
    if ((await boxOnline(settings, deps)) === false) {
      try {
        key = await mintJoinKey(settings, deps);
      } catch (error) {
        options.log({ event: "grok_box_key_error", message: String((error as Error).message) });
      }
    }
    return setupCommand(release, settings.token, key);
  }

  return {
    async upkeep() {
      const settings = settingsOf();
      if (!settings) return "";
      try {
        if (state.upkeepAt && deps.now() - state.upkeepAt < UPKEEP_EVERY_MS) return "";
        if (await healthy(settings)) return "";
        const block = upkeepBlock(await command(settings));
        state.upkeepAt = deps.now();
        save(settings);
        options.log({ event: "grok_box_upkeep" });
        return block;
      } catch (error) {
        options.log({ event: "grok_box_upkeep_error", message: String((error as Error).message) });
        return "";
      }
    },

    async tick(send) {
      const settings = settingsOf();
      if (!settings) return;
      const now = deps.now();
      if (state.verifyAt && now >= state.verifyAt) {
        const ok = await healthy(settings, true);
        state.verifyAt = undefined;
        state.failures = ok ? 0 : (state.failures ?? 0) + 1;
        state.result = ok ? "ok" : "failed";
        save(settings);
        options.log({
          event: ok ? "grok_box_repaired" : "grok_box_repair_error",
          failures: state.failures,
        });
      }
      const requestFile = join(settings.shared, "repair-request.json");
      let requested: number;
      try {
        requested = Number((JSON.parse(deps.readFile(requestFile)) as { at?: number }).at);
      } catch {
        return;
      }
      if (!Number.isFinite(requested) || (state.repairAt && requested <= state.repairAt)) return;
      if (state.repairAt && now - state.repairAt < REPAIR_EVERY_MS) return;
      if (state.retryAt && now < state.retryAt) return;
      if (await healthy(settings, true)) {
        rmSync(requestFile, { force: true });
        return;
      }
      try {
        await send(REPAIR_BOT, repairMessage(await command(settings)));
        state = {
          ...state,
          repairAt: now,
          verifyAt: now + VERIFY_AFTER_MS,
          retryAt: undefined,
          result: "sent",
          detail: undefined,
        };
        options.log({ event: "grok_box_repair_sent", bot: REPAIR_BOT });
      } catch (error) {
        // Not sent (the bot is busy, the budget is used up): try again in a few minutes.
        state = {
          ...state,
          retryAt: now + RETRY_AFTER_MS,
          result: "skipped",
          detail: String((error as Error).message).slice(0, 300),
        };
        options.log({ event: "grok_box_repair_error", message: state.detail });
      }
      save(settings);
    },

    status() {
      return { configured: Boolean(settingsOf()), ...state };
    },
  };
}
