import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { unsnoozePatch } from "@-/ai.leonsilicon.configs.patching.codemods.unsnooze";

const patches: Record<string, typeof unsnoozePatch> = { unsnooze: unsnoozePatch };

function prepare(name: string, packageRoot?: string) {
  const definition = Object.hasOwn(patches, name) ? patches[name]! : undefined;
  if (!definition)
    throw new Error(`Unknown patch: ${name}. Available: ${Object.keys(patches).join(", ")}`);
  const root = resolve(
    packageRoot || join(homedir(), ".bun/install/global/node_modules", definition.npmPackage),
  );
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
  };
  if (
    manifest.name !== definition.npmPackage ||
    !manifest.version ||
    !/^[\w.+-]+$/.test(manifest.version)
  ) {
    throw new Error(
      `Expected an installed ${definition.npmPackage} package with a valid version at ${root}`,
    );
  }
  return { definition, root, version: manifest.version };
}

export function applyPatch(
  name: string,
  packageRoot?: string,
  options: { backupDir?: string } = {},
): string[] {
  const { definition, root, version } = prepare(name, packageRoot);
  // Validate every transformation before mutating any bundle.
  const changes = definition.bundles.flatMap((bundle) => {
    const file = join(root, bundle);
    const after = definition.transform(readFileSync(file, "utf8"));
    return after === null ? [] : [{ file, bundle, after }];
  });
  if (!changes.length) return [];
  const backupDir =
    options.backupDir || join(homedir(), ".local/share/leonsilicon-ai/patch-backups");
  const backupRoot = join(backupDir, `${name}@${version}-${Date.now()}-${randomUUID()}`);
  for (const { file, bundle, after } of changes) {
    const backup = join(backupRoot, bundle);
    mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
    copyFileSync(file, backup);
    const temporary = `${file}.patch-${randomUUID()}`;
    try {
      writeFileSync(temporary, after, { mode: statSync(file).mode });
      renameSync(temporary, file);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  console.log(`Patched ${name}@${version}; originals saved to ${backupRoot}`);
  return changes.map((change) => change.file);
}

export function verifyPatch(name: string, packageRoot?: string): void {
  const { definition, root } = prepare(name, packageRoot);
  const result = spawnSync(process.execPath, ["--test", definition.integrationTest], {
    stdio: "inherit",
    env: { ...process.env, UNSNOOZE_TEST_ROOT: root },
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${name} integration tests failed (${result.status ?? result.signal})`);
}

export function generatePatch(
  name: string,
  packageRoot: string,
  outputDir = resolve("patches.gen"),
): string {
  const { definition, root, version } = prepare(name, packageRoot);
  const temporary = mkdtempSync(join(tmpdir(), "leonsilicon-ai-patches-"));
  try {
    const chunks = definition.bundles.map((bundle, i) => {
      const before = readFileSync(join(root, bundle), "utf8");
      const after = definition.transform(before);
      if (after === null)
        throw new Error(`${bundle} is already patched; generation needs a pristine installation`);
      const originalFile = join(temporary, `before-${i}`);
      const patchedFile = join(temporary, `after-${i}`);
      writeFileSync(originalFile, before);
      writeFileSync(patchedFile, after);
      const diff = spawnSync(
        "diff",
        ["-u", "--label", `a/${bundle}`, "--label", `b/${bundle}`, originalFile, patchedFile],
        { encoding: "utf8" },
      );
      if (diff.error) throw diff.error;
      if (diff.status !== 1)
        throw new Error(
          `Cannot generate ${bundle}: ${diff.stderr || `diff exited ${diff.status}`}`,
        );
      return diff.stdout;
    });
    mkdirSync(outputDir, { recursive: true });
    const output = join(
      outputDir,
      `${definition.npmPackage.replaceAll("/", "%2F")}@${version}.patch`,
    );
    writeFileSync(output, chunks.join(""));
    return output;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
