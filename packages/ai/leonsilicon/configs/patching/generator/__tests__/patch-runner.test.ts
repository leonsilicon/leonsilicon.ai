import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { applyPatch, generatePatch } from "#patch-runner";

// A small upstream-shaped adapter; tests never touch the global installation.
const before = String.raw`export const patterns = {
  busyPatterns: [
    /Retrying in\b/i,
  ],
  overloadPatterns: [
    /API Error:?\s*\(?429/i,
  ],
};
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "leonsilicon-ai-patch-runner-"));
  const file = join(root, "src/agents/claude.js");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "unsnooze", version: "1.21.1" }),
  );
  writeFileSync(file, before);
  return { root, file, backupDir: join(root, "@backups") };
}

test("applying preserves the original and repeating makes no new changes", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  assert.deepEqual(applyPatch("unsnooze", f.root, { backupDir: f.backupDir }), [f.file]);
  assert.ok(existsSync(f.backupDir));
  assert.match(readFileSync(f.file, "utf8"), /Waiting for API response/);
  assert.deepEqual(applyPatch("unsnooze", f.root, { backupDir: f.backupDir }), []);
});

test("upstream drift and a wrong target package fail without changing the adapter", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const drifted = before.replace("429", "430");
  writeFileSync(f.file, drifted);
  assert.throws(
    () => applyPatch("unsnooze", f.root, { backupDir: f.backupDir }),
    /Unsupported Claude adapter/,
  );
  assert.equal(readFileSync(f.file, "utf8"), drifted);
  assert.equal(existsSync(f.backupDir), false);
  writeFileSync(
    join(f.root, "package.json"),
    JSON.stringify({ name: "another-tool", version: "1.0.0" }),
  );
  assert.throws(() => applyPatch("unsnooze", f.root), /Expected an installed unsnooze/);
  assert.equal(readFileSync(f.file, "utf8"), drifted);
});

test("generation leaves upstream untouched and emits an applicable versioned diff", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const output = generatePatch("unsnooze", f.root, join(f.root, "patches.gen"));
  assert.equal(output, join(f.root, "patches.gen/unsnooze@1.21.1.patch"));
  assert.equal(readFileSync(f.file, "utf8"), before);
  const patch = readFileSync(output, "utf8");
  assert.match(patch, /^--- a\/src\/agents\/claude\.js\n\+\+\+ b\/src\/agents\/claude\.js/m);
  const result = spawnSync("patch", ["-p1"], { cwd: f.root, input: patch, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(applyPatch("unsnooze", f.root), []);
  assert.throws(() => generatePatch("unsnooze", f.root), /already patched/);
});
