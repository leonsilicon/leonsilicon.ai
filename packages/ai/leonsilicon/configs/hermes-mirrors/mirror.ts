import { execFileSync } from "node:child_process";

export const PLUGINS = "packages/com/leonsilicon/hermes/plugins";

function git(args: string[], cwd: string, env = process.env): string {
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function mainRevision(url: string, cwd: string): string | undefined {
  return git(["ls-remote", "--refs", url, "refs/heads/main"], cwd).split(/\s+/)[0] || undefined;
}

export function pluginNames(source: string, cwd: string): string[] {
  return git(["ls-tree", "-d", "--name-only", `${source}:${PLUGINS}`], cwd).split("\n");
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
  const directory = `${source}:${PLUGINS}/${name}`;
  git(["cat-file", "-e", `${directory}/plugin.yaml`], cwd);
  const tree = git(["rev-parse", "--verify", directory], cwd);
  const existing = mainRevision(fetchUrl, cwd);
  let parent: string | undefined;
  if (existing) {
    git(["fetch", "--no-tags", fetchUrl, "refs/heads/main"], cwd);
    parent = git(["rev-parse", "FETCH_HEAD"], cwd);
    if (git(["rev-parse", `${parent}^{tree}`], cwd) === tree) {
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
