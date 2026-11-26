import { execFileSync } from "node:child_process";
import { mainRevision, mirrorNames } from "#mirror";

const organization = "leonsiliconAI";
const finished = new Set(["done", "installed", "failed"]);

export interface DeployPlugin {
  name: string;
  mirror: string;
  commit: string;
}

export interface DeployRecord {
  id: string;
  status: string;
  log: string[];
  steps?: { name: string; ok: boolean; error?: string | null; output?: string }[];
}

/** Each mirrored plugin's Hermes name, its mirror, and the commit on the mirror's `main`. */
export function deployPlugins(source: string, cwd: string): DeployPlugin[] {
  return mirrorNames(source, cwd).map((directory) => {
    const manifest = execFileSync("git", ["show", `${source}:apps/${directory}/plugin.yaml`], {
      cwd,
      encoding: "utf8",
    });
    const name = /^name:\s*(\S+)\s*$/m.exec(manifest)?.[1];
    if (!name) throw new Error(`apps/${directory}/plugin.yaml names no plugin`);
    const mirror = `https://github.com/${organization}/${directory}`;
    const commit = mainRevision(`${mirror}.git`, cwd);
    if (!commit) throw new Error(`${mirror} has no main branch`);
    return { name, mirror, commit };
  });
}

/**
 * Asks autodeploy on Hermes's dashboard to install `plugins`, then follows the deploy until it ends.
 * A status request that fails is tried again: the dashboard restarts after autodeploy itself moves.
 */
export async function deploy({
  url,
  token,
  plugins,
  source,
  run,
  fetch = globalThis.fetch,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  log = console.log,
  every = 10_000,
  timeout = 40 * 60_000,
  now = Date.now,
}: {
  url: string;
  token: string;
  plugins: DeployPlugin[];
  source: string;
  run?: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  every?: number;
  timeout?: number;
  now?: () => number;
}): Promise<DeployRecord> {
  const endpoint = `${url.replace(/\/+$/, "")}/api/plugins/autodeploy/deploy`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  for (const plugin of plugins) log(`${plugin.name}: ${plugin.mirror} at ${plugin.commit}`);
  const started = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ plugins, source, run }),
  });
  if (!started.ok)
    throw new Error(`Hermes refused the deploy (${started.status}): ${await started.text()}`);
  let record = (await started.json()) as DeployRecord;
  log(`deploy ${record.id}: ${record.status}`);
  let printed = 0;
  const deadline = now() + timeout;
  for (;;) {
    for (const line of record.log.slice(printed)) log(line);
    printed = record.log.length;
    if (finished.has(record.status)) break;
    if (now() > deadline)
      throw new Error(
        `deploy ${record.id} is still ${record.status} after ${timeout / 60_000} minutes`,
      );
    await sleep(every);
    try {
      const response = await fetch(`${endpoint}?id=${encodeURIComponent(record.id)}`, { headers });
      if (response.ok) record = (await response.json()) as DeployRecord;
      else log(`(status answered ${response.status}; asking again)`);
    } catch (error) {
      log(
        `(status failed: ${error instanceof Error ? error.message : String(error)}; asking again)`,
      );
    }
  }
  for (const step of record.steps ?? []) {
    if (!step.ok) log(`${step.name} failed: ${step.error}\n${(step.output ?? "").slice(-2000)}`);
  }
  log(`deploy ${record.id}: ${record.status}`);
  return record;
}
