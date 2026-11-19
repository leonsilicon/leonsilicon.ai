#!/usr/bin/env node
/**
 * Builds dist/beeper-inbox.tgz for Hermes Cloud: the app bundled into one file, plus Pickle built from
 * the revision pinned in @assets/pickle.json, vendored as node_modules/@beeper/*. Needs git, Go (any
 * version that can fetch the pinned toolchain), pnpm and bun. Run from anywhere:
 *
 *   node apps/beeper-inbox/_build-beeper-inbox.ts
 */
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

interface Pin {
  repository: string;
  revision: string;
  packages: Record<string, { dir: string; version: string }>;
  toolchain: { go: string; pnpm: string };
  goflags: string;
  build: string[];
  recoveredGoModules: Array<{ module: string; version: string; commit: string }>;
  artifacts: Record<string, string>;
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const pin = JSON.parse(readFileSync(join(here, "@assets", "pickle.json"), "utf8")) as Pin;
const cache =
  process.env.BEEPER_INBOX_BUILD_CACHE ??
  join(homedir(), ".cache", "leonsilicon-ai", "beeper-inbox");
const src = join(cache, `pickle-${pin.revision.slice(0, 12)}`);
const goproxy = join(cache, "goproxy");
const out = join(root, "dist", "beeper-inbox");

const run = (command: string, args: string[], options: ExecFileSyncOptions = {}): string =>
  String(
    execFileSync(command, args, { stdio: ["ignore", "pipe", "inherit"], ...options }) ?? "",
  ).trim();
const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const step = (message: string) => process.stderr.write(`\n▸ ${message}\n`);

function fetchCommit(dir: string, repository: string, commit: string): void {
  if (existsSync(join(dir, ".git")) && run("git", ["-C", dir, "rev-parse", "HEAD"]) === commit)
    return;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  run("git", ["-C", dir, "init", "-q"]);
  run("git", ["-C", dir, "remote", "add", "origin", repository]);
  run("git", ["-C", dir, "fetch", "-q", "--depth", "1", "origin", commit]);
  run("git", ["-C", dir, "checkout", "-q", "FETCH_HEAD"]);
  const head = run("git", ["-C", dir, "rev-parse", "HEAD"]);
  if (head !== commit) throw new Error(`${repository}: expected ${commit}, got ${head}`);
}

step(`Pickle ${pin.revision} from ${pin.repository}`);
fetchCommit(src, pin.repository, pin.revision);

const goEnv = {
  ...process.env,
  GOTOOLCHAIN: pin.toolchain.go,
  GOFLAGS: pin.goflags,
  GOPROXY: `file://${goproxy},https://proxy.golang.org`,
};
for (const mod of pin.recoveredGoModules) {
  const dir = join(goproxy, mod.module, "@v");
  const zip = join(dir, `${mod.version}.zip`);
  if (existsSync(zip)) continue;
  step(`recovering ${mod.module}@${mod.version} from commit ${mod.commit}`);
  const checkout = join(cache, "recovered", mod.commit);
  fetchCommit(checkout, `https://${mod.module}.git`, mod.commit);
  const tree = join(cache, "recovered", `${mod.commit}-tree`);
  rmSync(tree, { recursive: true, force: true });
  mkdirSync(tree, { recursive: true });
  execFileSync("sh", ["-c", `git -C "$1" archive HEAD | tar -x -C "$2"`, "sh", checkout, tree], {
    stdio: "inherit",
  });
  mkdirSync(dir, { recursive: true });
  run("go", ["run", ".", mod.module, mod.version, zip, tree], {
    cwd: join(here, "@assets", "modzip"),
    env: { ...process.env, GOTOOLCHAIN: pin.toolchain.go },
  });
  cpSync(join(tree, "go.mod"), join(dir, `${mod.version}.mod`));
  writeFileSync(join(dir, `${mod.version}.info`), JSON.stringify({ Version: mod.version }));
  writeFileSync(join(dir, "list"), `${mod.version}\n`);
}

step("building Pickle (Go checks the recovered module against Pickle's go.sum)");
run("pnpm", ["install", "--frozen-lockfile"], { cwd: src, stdio: "inherit", env: goEnv });
for (const pkg of Object.values(pin.packages))
  run("pnpm", ["--dir", pkg.dir, "build"], { cwd: src, stdio: "inherit", env: goEnv });

const pickleDir = join(src, pin.packages["@beeper/pickle"]?.dir ?? "packages/pickle");
for (const [file, expected] of Object.entries(pin.artifacts)) {
  if (!file.startsWith("dist/")) continue;
  const actual = sha256(join(pickleDir, file));
  if (actual !== expected) {
    throw new Error(
      `${file} is ${actual}, but the pinned build is ${expected}; the toolchain or sources differ (see @assets/pickle.json)`,
    );
  }
}

step(`staging ${relative(root, out)}`);
rmSync(out, { recursive: true, force: true });
for (const [name, pkg] of Object.entries(pin.packages)) {
  const from = join(src, pkg.dir);
  const to = join(out, "node_modules", name);
  mkdirSync(to, { recursive: true });
  for (const entry of ["package.json", "README.md", "LICENSE", "dist"]) {
    if (existsSync(join(from, entry)))
      cpSync(join(from, entry), join(to, entry), { recursive: true });
  }
}
run(
  "bun",
  [
    "build",
    join(here, "_beeper-inbox.ts"),
    "--target=node",
    "--format=esm",
    `--outfile=${join(out, "app", "beeper-inbox.mjs")}`,
  ],
  { cwd: root, stdio: "inherit" },
);
cpSync(join(here, "@assets", "install.sh"), join(out, "install.sh"));
cpSync(join(here, "@assets", "pickle.json"), join(out, "pickle.json"));

const files: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(relative(out, path));
  }
};
walk(out);
const repoHead = run("git", ["-C", root, "rev-parse", "HEAD"]);
const dirty = run("git", ["-C", root, "status", "--porcelain"]).length > 0;
writeFileSync(
  join(out, "BUILD.json"),
  `${JSON.stringify(
    {
      service: "beeper-inbox",
      builtAt: new Date().toISOString(),
      source: { repository: "leonsilicon/leonsilicon.ai", commit: repoHead, dirty },
      pickle: { revision: pin.revision, toolchain: pin.toolchain },
      node: process.version,
      bun: run("bun", ["--version"]),
    },
    null,
    2,
  )}\n`,
);
writeFileSync(
  join(out, "SHA256SUMS"),
  files.map((file) => `${sha256(join(out, file))}  ${file}\n`).join(""),
);

const tarball = join(root, "dist", "beeper-inbox.tgz");
run("tar", ["-czf", tarball, "-C", join(root, "dist"), "beeper-inbox"], {
  env: { ...process.env, COPYFILE_DISABLE: "1" },
});
process.stdout.write(
  `${JSON.stringify({ tarball, bytes: statSync(tarball).size, sha256: sha256(tarball), files: files.length }, null, 2)}\n`,
);
