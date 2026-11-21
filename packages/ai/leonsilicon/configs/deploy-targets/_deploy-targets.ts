#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { affectedWorkers, readWorkspace } from "#deploy-targets";

// Prints the Workers to deploy as a JSON array: those affected by the files changed between --base
// and --head (default HEAD), or every Worker when there's no usable base (first deploy, force-push)
// or --all. With --github-output it also writes `workers=<json>` to $GITHUB_OUTPUT.
const args = process.argv.slice(2);
const value = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const workspace = readWorkspace(root);
const all = workspace.workers.map((worker) => worker.app);
const git = (...gitArgs: string[]): string =>
  execFileSync("git", ["-C", root, ...gitArgs], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

let workers: string[];
let reason: string;
const only = value("--only");
const base = value("--base");
const head = value("--head") ?? "HEAD";
if (args.includes("--all") || only === "all") {
  workers = all;
  reason = "all requested";
} else if (only) {
  const asked = only
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const unknown = asked.filter((name) => !all.includes(name));
  if (unknown.length) {
    console.error(`Unknown Worker(s): ${unknown.join(", ")}. Workers: ${all.join(", ")}`);
    process.exit(2);
  }
  workers = asked;
  reason = "requested";
} else {
  let changed: string[] | null = null;
  if (base && !/^0+$/.test(base)) {
    try {
      git("cat-file", "-e", `${base}^{commit}`);
      changed = git("diff", "--name-only", base, head).split("\n").filter(Boolean);
    } catch {
      changed = null;
    }
  }
  if (changed === null) {
    workers = all;
    reason = base ? `base ${base.slice(0, 12)} isn't in this history` : "no earlier deploy";
  } else {
    workers = affectedWorkers(workspace, changed);
    reason = `${changed.length} file(s) changed since ${base?.slice(0, 12)}`;
  }
}
console.error(`deploy-targets: ${workers.length ? workers.join(", ") : "nothing"} (${reason})`);
process.stdout.write(`${JSON.stringify(workers)}\n`);
if (args.includes("--github-output") && process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `workers=${JSON.stringify(workers)}\n`);
}
