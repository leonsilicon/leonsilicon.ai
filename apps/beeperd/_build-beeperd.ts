#!/usr/bin/env node
/**
 * Builds dist/beeperd.tgz for Hermes Cloud: one static linux/amd64 binary, with its checksums and
 * installer. Needs Go (any version that can fetch the toolchain go.mod names) and a C compiler that
 * links against musl, because SQLite is C: `x86_64-linux-musl-gcc` on a Mac (`brew install
 * FiloSottile/musl-cross/musl-cross`), `musl-gcc` on Linux (`apt install musl-tools`), or whatever
 * $BEEPERD_CC names. Run from anywhere:
 *
 *   node apps/beeperd/_build-beeperd.ts
 */
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const out = join(root, "dist", "beeperd");

const run = (command: string, args: string[], options: ExecFileSyncOptions = {}): string =>
  String(
    execFileSync(command, args, { stdio: ["ignore", "pipe", "inherit"], ...options }) ?? "",
  ).trim();
const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const compiler =
  process.env.BEEPERD_CC ?? (process.platform === "linux" ? "musl-gcc" : "x86_64-linux-musl-gcc");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
run(
  "go",
  [
    "build",
    // goolm: Olm and Megolm in pure Go, so the only C in the binary is SQLite.
    "-tags=goolm",
    "-trimpath",
    "-ldflags=-s -w -linkmode external -extldflags -static",
    "-o",
    join(out, "beeperd"),
    ".",
  ],
  {
    cwd: here,
    stdio: "inherit",
    env: { ...process.env, CGO_ENABLED: "1", GOOS: "linux", GOARCH: "amd64", CC: compiler },
  },
);
cpSync(join(here, "@assets", "install.sh"), join(out, "install.sh"));

const repoHead = run("git", ["-C", root, "rev-parse", "HEAD"]);
const dirty = run("git", ["-C", root, "status", "--porcelain", "--", here]).length > 0;
writeFileSync(
  join(out, "BUILD.json"),
  `${JSON.stringify(
    {
      service: "beeperd",
      builtAt: new Date().toISOString(),
      source: { repository: "leonsilicon/leonsilicon.ai", commit: repoHead, dirty },
      go: run("go", ["version"], { cwd: here }),
      compiler,
    },
    null,
    2,
  )}\n`,
);
const files = ["BUILD.json", "beeperd", "install.sh"];
writeFileSync(
  join(out, "SHA256SUMS"),
  files.map((file) => `${sha256(join(out, file))}  ${file}\n`).join(""),
);

const tarball = join(root, "dist", "beeperd.tgz");
run("tar", ["-czf", tarball, "-C", join(root, "dist"), "beeperd"], {
  env: { ...process.env, COPYFILE_DISABLE: "1" },
});
process.stdout.write(
  `${JSON.stringify({ tarball, bytes: statSync(tarball).size, binaryBytes: statSync(join(out, "beeperd")).size, sha256: sha256(tarball) }, null, 2)}\n`,
);
