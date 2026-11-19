import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A deployable Cloudflare Worker: an app with a wrangler.jsonc and a `deploy:<app>` task. */
export interface WorkerApp {
  app: string;
  dir: string;
}

export interface Workspace {
  workers: WorkerApp[];
  /** Workspace package name → its directory, relative to the root. */
  dirs: Map<string, string>;
  /** Workspace package name → the workspace packages it depends on. */
  deps: Map<string, string[]>;
  /** App directory → its package name. */
  appPackages: Map<string, string>;
}

/**
 * Files outside any package that every Worker's build reads: the pages (www/ is built into each
 * Worker's assets), the lockfile and root config, the env schema varlock reads at deploy time, and
 * the deploy workflow itself.
 */
export const ROOT_INPUTS = [
  "www/",
  "bun.lock",
  "package.json",
  "vite.config.ts",
  "tsconfig.json",
  ".env.schema",
  ".github/workflows/deploy.yml",
];

/** Files in a package that never reach a build: docs and tests. */
const NOT_BUILT = /(\.md$|\/__tests__\/)/;

function packageDirs(root: string, dir: string): string[] {
  const out: string[] = [];
  const full = join(root, dir);
  if (!existsSync(full)) return out;
  if (existsSync(join(full, "package.json"))) out.push(dir);
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      entry.name === "node_modules" ||
      entry.name.startsWith(".") ||
      entry.name === "__tests__"
    )
      continue;
    out.push(...packageDirs(root, `${dir}/${entry.name}`));
  }
  return out;
}

/** Reads the workspace: every package under apps/ and packages/, and the apps that are Workers. */
export function readWorkspace(root: string): Workspace {
  const dirs = new Map<string, string>();
  const deps = new Map<string, string[]>();
  const appPackages = new Map<string, string>();
  for (const dir of [...packageDirs(root, "apps"), ...packageDirs(root, "packages")]) {
    const manifest = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")) as {
      name?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    if (!manifest.name) continue;
    dirs.set(manifest.name, dir);
    const all = { ...manifest.dependencies, ...manifest.devDependencies };
    deps.set(
      manifest.name,
      Object.entries(all)
        .filter(([, range]) => range.startsWith("workspace:"))
        .map(([name]) => name),
    );
    if (dir.startsWith("apps/")) appPackages.set(dir, manifest.name);
  }
  const workers = [...appPackages.keys()]
    .filter((dir) => existsSync(join(root, dir, "wrangler.jsonc")))
    .map((dir) => ({ app: dir.slice("apps/".length), dir }))
    .sort((a, b) => a.app.localeCompare(b.app));
  return { workers, dirs, deps, appPackages };
}

/** Directories whose files end up in a Worker's build: its app and every workspace package it reaches. */
export function workerInputs(workspace: Workspace, worker: WorkerApp): string[] {
  const start = workspace.appPackages.get(worker.dir);
  const seen = new Set<string>();
  const stack = start ? [start] : [];
  while (stack.length) {
    const name = stack.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    stack.push(...(workspace.deps.get(name) ?? []));
  }
  const dirs = [...seen]
    .map((name) => workspace.dirs.get(name))
    .filter((dir): dir is string => Boolean(dir));
  return [...new Set([worker.dir, ...dirs])].sort();
}

/** The Workers that `changed` (paths relative to the root) can affect. */
export function affectedWorkers(workspace: Workspace, changed: readonly string[]): string[] {
  const out: string[] = [];
  for (const worker of workspace.workers) {
    const inputs = workerInputs(workspace, worker).map((dir) => `${dir}/`);
    const hit = changed.some(
      (file) =>
        (!NOT_BUILT.test(file) && inputs.some((dir) => file.startsWith(dir))) ||
        ROOT_INPUTS.some((input) =>
          input.endsWith("/") ? file.startsWith(input) : file === input,
        ),
    );
    if (hit) out.push(worker.app);
  }
  return out;
}
