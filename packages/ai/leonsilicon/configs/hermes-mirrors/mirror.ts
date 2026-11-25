import { execFileSync } from "node:child_process";

const APPS = "apps";
const SHARED = "packages/ai/leonsilicon/configs/hermes-mirrors";
const sharedPackage = "@-/ai.leonsilicon.configs.hermes-mirrors";
const PLUGIN_APP_PREFIX = "hermes-plugin-";

function git(args: string[], cwd: string, env = process.env, input?: string): string {
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  }).trim();
}

export function mainRevision(url: string, cwd: string): string | undefined {
  return git(["ls-remote", "--refs", url, "refs/heads/main"], cwd).split(/\s+/)[0] || undefined;
}

export function mirrorNames(source: string, cwd: string): string[] {
  return git(["ls-tree", "-d", "--name-only", `${source}:${APPS}`], cwd)
    .split("\n")
    .filter((name) => name.startsWith(PLUGIN_APP_PREFIX));
}

interface Manifest {
  devDependencies?: Record<string, string>;
  imports?: Record<string, string>;
}

function standaloneTree(source: string, directory: string, cwd: string): string {
  const entries = new Map(
    git(["ls-tree", "-z", directory], cwd)
      .split("\0")
      .filter(Boolean)
      .map((entry) => [entry.slice(entry.indexOf("\t") + 1), entry]),
  );
  if (!entries.has("package.json")) return git(["rev-parse", directory], cwd);

  const manifest = JSON.parse(git(["show", `${directory}/package.json`], cwd)) as Manifest;
  if (!manifest.devDependencies?.[sharedPackage]) return git(["rev-parse", directory], cwd);

  function addFile(name: string, blob: string): void {
    entries.set(name, `100644 blob ${blob}\t${name}`);
  }

  function addShared(name: string, path: string): void {
    addFile(name, git(["rev-parse", `${source}:${SHARED}/${path}`], cwd));
  }

  // These are committed inputs to the Vite+ build. Publish their exact bytes so
  // the mirrored bundle can load in Hermes and the project can rebuild on its own.
  addShared("vite.config.ts", "plugin-config.ts");
  addShared("_pythonmonkey.py", "_pythonmonkey.py");
  if (manifest.imports?.["#slack"] === sharedPackage + "/slack") {
    addShared("slack.ts", "slack.ts");
    manifest.imports["#slack"] = "./slack.ts";
  }
  delete manifest.devDependencies[sharedPackage];
  const manifestBlob = git(
    ["hash-object", "-w", "--stdin"],
    cwd,
    process.env,
    JSON.stringify(manifest, null, 2) + "\n",
  );
  addFile("package.json", manifestBlob);

  return git(["mktree", "-z"], cwd, process.env, [...entries.values()].join("\0") + "\0");
}

export function syncMirror({
  source,
  name,
  fetchUrl,
  pushUrl,
  cwd,
  env,
}: {
  source: string;
  name: string;
  fetchUrl: string;
  pushUrl: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const directory = `${source}:${APPS}/${name}`;
  git(["cat-file", "-e", `${directory}/plugin.yaml`], cwd);
  const tree = standaloneTree(source, directory, cwd);
  const existing = mainRevision(fetchUrl, cwd);
  let parent: string | undefined;
  if (existing) {
    git(["fetch", "--no-tags", fetchUrl, "refs/heads/main"], cwd);
    parent = git(["rev-parse", "FETCH_HEAD"], cwd);
    if (git(["rev-parse", `${parent}^{tree}`], cwd) === tree) {
      // A dry-run push still asks the server for push access, so a token that can't push fails now
      // instead of on the plugin's next change.
      git(["push", "--dry-run", pushUrl, `${parent}:refs/heads/main`], cwd, env);
      return `Unchanged ${name} at ${parent}`;
    }
  }

  const subject = git(["show", "-s", "--format=%s", source], cwd);
  const timestamp = git(["show", "-s", "--format=%cI", source], cwd);
  const commit = git(
    [
      "commit-tree",
      tree,
      ...(parent ? ["-p", parent] : []),
      "-m",
      subject,
      "-m",
      `Source: https://github.com/leonsilicon/leonsilicon.ai/commit/${source}`,
    ],
    cwd,
    {
      ...process.env,
      GIT_AUTHOR_NAME: "leonsilicon.ai mirrors",
      GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
      GIT_COMMITTER_NAME: "leonsilicon.ai mirrors",
      GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
      GIT_AUTHOR_DATE: timestamp,
      GIT_COMMITTER_DATE: timestamp,
    },
  );
  // Preserve the mirror's history so existing Hermes checkouts can pull with --ff-only.
  git(["push", pushUrl, `${commit}:refs/heads/main`], cwd, env);
  return `Published ${name} at ${commit}`;
}
