#!/usr/bin/env node
/**
 * Builds dist/orca-device.tgz for Hermes Cloud from the Orca.app installed on this Mac: Orca's Linux
 * runtime bundle (the `linux-x64-glibc` target of its `orcad-template`, every file checked against
 * `orcad-template.json`), this app bundled with bun, the `orca` wrapper and the installer. Node and
 * Tailscale are fetched on Hermes by `install.sh`, checked against the hashes recorded in BUILD.json.
 *
 *   node apps/orca-device/_build-orca-device.ts
 *
 * Rebuild and reinstall after Orca updates on the Macs, so Hermes's CLI keeps their version.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const TARGET = "linux-x64-glibc";
const TAILSCALE_VERSION = "1.104.7";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const resources = process.env.ORCA_RESOURCES ?? "/Applications/Orca.app/Contents/Resources";
const template = join(resources, "orcad-template");
const out = join(root, "dist", "orca-device");
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

const manifest = JSON.parse(readFileSync(join(template, "orcad-template.json"), "utf8")) as {
  commonSha256: Record<string, string>;
  targets: Record<string, { files: Record<string, string> }>;
};
const orcaVersion =
  (
    JSON.parse(
      readFileSync(join(resources, "app.asar.unpacked", "out", "package.json"), "utf8"),
    ) as { version?: string }
  ).version ??
  (JSON.parse(readFileSync(join(template, "out", "package.json"), "utf8")) as { version: string })
    .version;

rmSync(out, { recursive: true, force: true });
const bundle = join(out, "bundle");
const copyChecked = (from: string, rel: string, want: string) => {
  if (sha256(from) !== want) throw new Error(`${rel} doesn't match orcad-template.json`);
  const to = join(bundle, rel);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  if (/^bin\/|\/rg$|spawn-helper$/.test(rel)) chmodSync(to, 0o755);
};
for (const [rel, want] of Object.entries(manifest.commonSha256))
  copyChecked(join(template, rel), rel, want);
const target = manifest.targets[TARGET];
if (!target) throw new Error(`no ${TARGET} target in this Orca build`);
for (const [rel, want] of Object.entries(target.files)) {
  const inTemplate = join(template, "targets", TARGET, rel);
  // The app keeps Linux ripgrep beside the template rather than in it.
  copyChecked(existsSync(inTemplate) ? inTemplate : join(resources, rel), rel, want);
}

// Orca pins the Node it runs on: archive and executable hashes, from its launcher.
const launcher = readFileSync(join(template, "orcad.js"), "utf8");
const pin = new RegExp(
  `"${TARGET}":\\{source:"official",archive:"([^"]+)",archiveSha256:"([0-9a-f]{64})",executableSha256:"([0-9a-f]{64})"`,
).exec(launcher);
if (!pin) throw new Error("couldn't find Orca's pinned Node for the target");
const [, nodeArchive, nodeArchiveSha256, nodeExecutableSha256] = pin;
if (readFileSync(join(bundle, ".runtime-node"), "utf8").trim() !== nodeExecutableSha256)
  throw new Error(".runtime-node disagrees with the launcher's pin");

mkdirSync(join(out, "app"), { recursive: true });
execFileSync(
  "bun",
  [
    "build",
    join(here, "_orca-device.ts"),
    "--target=node",
    "--format=esm",
    `--outfile=${join(out, "app", "orca-device.mjs")}`,
  ],
  { cwd: root, stdio: "inherit" },
);
for (const asset of ["orca", "install.sh", "device.example.json"])
  cpSync(join(here, "@assets", asset), join(out, asset));
chmodSync(join(out, "orca"), 0o755);
chmodSync(join(out, "install.sh"), 0o755);
writeFileSync(
  join(out, "BUILD.json"),
  `${JSON.stringify(
    {
      service: "orca-device",
      builtAt: new Date().toISOString(),
      orcaVersion,
      target: TARGET,
      node: {
        archive: nodeArchive,
        archiveSha256: nodeArchiveSha256,
        executableSha256: nodeExecutableSha256,
      },
      tailscale: { version: TAILSCALE_VERSION },
      source: { commit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"]).toString().trim() },
    },
    null,
    2,
  )}\n`,
);

const files: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(relative(out, path));
  }
};
walk(out);
writeFileSync(
  join(out, "SHA256SUMS"),
  files.map((file) => `${sha256(join(out, file))}  ${file}\n`).join(""),
);
const tarball = join(root, "dist", "orca-device.tgz");
execFileSync("tar", ["-czf", tarball, "-C", join(root, "dist"), "orca-device"], {
  env: { ...process.env, COPYFILE_DISABLE: "1" },
});
process.stdout.write(
  `${JSON.stringify({ tarball, orcaVersion, bytes: statSync(tarball).size, sha256: sha256(tarball), files: files.length }, null, 2)}\n`,
);
