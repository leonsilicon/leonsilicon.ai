import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mainRevision, mirrorNames, syncMirror } from "#mirror";

test("mirrors publish standalone trees and advance only when their contents change", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "hermes-mirror-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const cwd = join(tmp, "source");
  const remote = join(tmp, "mirror.git");
  mkdirSync(cwd);
  const git = (args: string[], dir = cwd) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  git(["init", "--initial-branch=main"]);
  git(["init", "--bare", "--initial-branch=main", remote]);
  git(["config", "user.email", "test@example.test"]);
  git(["config", "user.name", "Test"]);
  git(["config", "commit.gpgsign", "false"]);
  const name = "hermes-plugin-autolinear";
  const path = join(cwd, "apps", name);
  mkdirSync(path, { recursive: true });
  const manifest = join(path, "plugin.yaml");
  writeFileSync(manifest, "name: autolinear\nversion: 1.0.0\n");
  const worker = join(cwd, "apps", "autolinear");
  mkdirSync(worker);
  writeFileSync(join(worker, "wrangler.jsonc"), "{}\n");

  const publish = () => {
    git(["add", "."]);
    git(["commit", "-m", "Update source"]);
    const source = git(["rev-parse", "HEAD"]);
    assert.deepEqual(mirrorNames(source, cwd), [name]);
    syncMirror({ source, name, fetchUrl: remote, pushUrl: remote, cwd });
    return mainRevision(remote, cwd)!;
  };

  const first = publish();
  assert.equal(git(["ls-tree", "--name-only", "HEAD"], remote), "plugin.yaml");
  assert.equal(git(["show", "HEAD:plugin.yaml"], remote), "name: autolinear\nversion: 1.0.0");
  assert.equal(git(["rev-parse", "HEAD^{tree}"], remote), git(["rev-parse", `HEAD:apps/${name}`]));
  writeFileSync(join(cwd, "other.txt"), "unrelated source change");
  assert.equal(publish(), first);
  writeFileSync(manifest, "name: autolinear\nversion: 1.0.1\n");
  assert.notEqual(publish(), first);
  assert.equal(git(["rev-parse", "HEAD^"], remote), first);
});
