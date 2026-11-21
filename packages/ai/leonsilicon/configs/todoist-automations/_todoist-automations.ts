#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fillEnv,
  manifestName,
  pairByName,
  redact,
  sameManifest,
  slug,
  sortKeys,
  toEnvRefs,
  type Json,
} from "#todoist-automations";

const USAGE = `Usage: _todoist-automations <command>

  check                 Compare the manifests here with the automations in Todoist; exits 1 unless
                        every one matches.
  pull                  Write each automation in Todoist to @assets/<name>.json, to keep an edit
                        made in Todoist before the next deploy overwrites it.
  push [name] [--yes]   Publish @assets/<name>.json, or every manifest here: as an edit of the
                        automation with its name, or as a new one. Without --yes, only a preview.`;

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const assets = fileURLToPath(new URL("@assets/", import.meta.url));
// The workspace's pinned tda, rather than whichever one is installed globally.
const tdaBin = join(
  dirname(createRequire(import.meta.url).resolve("@todoist/automations-cli/package.json")),
  "dist/index.js",
);
const TOKEN = "TODOIST_API_TOKEN";
const inActions = process.env.GITHUB_ACTIONS === "true";

interface Env {
  /** What `{ "$env": NAME }` stands for in the manifests. */
  values: Record<string, string>;
  /** Every value loaded, the token included: never printed. */
  secrets: Record<string, string>;
  token: string | undefined;
}
interface Here {
  file: string;
  manifest: Json;
}
interface Live {
  id: string;
  enabled: boolean;
  manifest: Json;
}

// The items tagged #todoist-automations in the root .env.schema, resolved by varlock from Infisical.
// They stay in memory, and in GitHub Actions they're masked in the log.
function loadEnv(): Env {
  let json: string;
  try {
    json = execFileSync(
      join(root, "node_modules/.bin/varlock"),
      ["load", "--path", root, "--filter", "#todoist-automations", "--format", "json", "--compact"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1 << 20 },
    );
  } catch {
    throw new Error(
      "Could not resolve #todoist-automations from .env.schema; is Infisical access set up in .env?",
    );
  }
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(JSON.parse(json) as Record<string, unknown>)) {
    if (typeof value === "string" && value !== "") secrets[key] = value;
  }
  if (inActions) for (const value of Object.values(secrets)) console.log(`::add-mask::${value}`);
  const { [TOKEN]: token, ...values } = secrets;
  if (process.env.CI && token === undefined) {
    throw new Error(
      `No ${TOKEN} in Infisical /todoist-automations: add a Todoist personal API token (Settings → Integrations → Developer) there`,
    );
  }
  return { values, secrets, token };
}

/**
 * Runs `tda --json`, which prints one JSON document, an error included. A signed-in tda uses its own
 * login; one that isn't (CI) uses the token.
 */
function tda<T>(env: Env, args: string[], input?: Json): T {
  const result = spawnSync(process.execPath, [tdaBin, "--json", "--no-spinner", ...args], {
    encoding: "utf8",
    env: env.token === undefined ? process.env : { ...process.env, [TOKEN]: env.token },
    input: input === undefined ? undefined : JSON.stringify(input),
    maxBuffer: 16 << 20,
  });
  const fail = (message: string) =>
    new Error(redact(`tda ${args.slice(0, 2).join(" ")}: ${message}`, env.secrets));
  if (result.error) throw fail(result.error.message);
  let output: { status?: string; message?: string };
  try {
    output = JSON.parse(result.stdout) as typeof output;
  } catch {
    throw fail(`no JSON (exit ${result.status}) ${result.stderr.trim()}`);
  }
  if (result.status !== 0 || output.status === "error") {
    throw fail(output.message ?? `exit ${result.status}`);
  }
  return output as T;
}

const readHere = (): Here[] =>
  readdirSync(assets)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({
      file,
      manifest: JSON.parse(readFileSync(join(assets, file), "utf8")) as Json,
    }));

// Every automation in the personal space, with its manifest; private values become { "$env": NAME }.
function readLive(env: Env): Live[] {
  const { data } = tda<{ data: Live[] }>(env, [
    "automation",
    "list",
    "--personal",
    "--all",
    "--full",
  ]);
  return data.map((automation) => ({
    id: automation.id,
    enabled: automation.enabled,
    manifest: toEnvRefs(automation.manifest, env.values),
  }));
}

const pair = (here: Here[], live: Live[]) =>
  pairByName(here, live, {
    here: (item) => manifestName(item.manifest),
    live: (item) => manifestName(item.manifest),
  });

const disabled = (live: Live): string => (live.enabled ? "" : ", disabled in Todoist");

function warn(message: string): void {
  console.log(inActions ? `::warning title=Todoist Automations::${message}` : `! ${message}`);
}

function printDiff(file: string, live: Live, here: Json): void {
  // Both sides hold { "$env": NAME } rather than the private values.
  const dir = mkdtempSync(join(tmpdir(), "todoist-automations-"));
  try {
    const pretty = (manifest: Json) => `${JSON.stringify(sortKeys(manifest), null, 2)}\n`;
    writeFileSync(join(dir, "here.json"), pretty(here));
    writeFileSync(join(dir, "live.json"), pretty(live.manifest));
    const labels = ["--label", `Todoist ${live.id}`, "--label", `@assets/${file}`];
    const diff = spawnSync(
      "diff",
      ["-u", ...labels, join(dir, "live.json"), join(dir, "here.json")],
      {
        encoding: "utf8",
      },
    );
    process.stdout.write(diff.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function check(): void {
  const env = loadEnv();
  const { both, hereOnly, liveOnly } = pair(readHere(), readLive(env));
  for (const { name, here, live } of both) {
    if (sameManifest(here.manifest, live.manifest)) {
      console.log(`✓ ${name}: @assets/${here.file} matches ${live.id}${disabled(live)}`);
    } else {
      process.exitCode = 1;
      console.log(`✗ ${name}: @assets/${here.file} differs from ${live.id}${disabled(live)}`);
      printDiff(here.file, live, here.manifest);
    }
  }
  for (const { name, here } of hereOnly) {
    process.exitCode = 1;
    console.log(`✗ ${name}: @assets/${here.file} has no automation in Todoist (push creates it)`);
  }
  for (const { name, live } of liveOnly) {
    process.exitCode = 1;
    console.log(`✗ ${name}: ${live.id} is in Todoist but not here (pull adds it)`);
  }
}

function pull(): void {
  const env = loadEnv();
  const here = readHere();
  const { both, hereOnly, liveOnly } = pair(here, readLive(env));
  const write = (name: string, file: string, live: Live) => {
    const path = join(assets, file);
    // Formatted like the rest of the workspace, so `vp check` passes on the result.
    const formatted = execFileSync(
      join(root, "node_modules/.bin/vp"),
      ["fmt", `--stdin-filepath=${relative(root, path)}`],
      { cwd: root, encoding: "utf8", input: `${JSON.stringify(live.manifest, null, 2)}\n` },
    );
    writeFileSync(path, formatted);
    console.log(`↓ ${name}: wrote @assets/${file} from ${live.id}${disabled(live)}`);
  };
  for (const { name, here: item, live } of both) {
    if (sameManifest(item.manifest, live.manifest))
      console.log(`✓ ${name}: @assets/${item.file} matches`);
    else write(name, item.file, live);
  }
  for (const { name, live } of liveOnly) {
    const file = `${slug(name)}.json`;
    if (here.some((item) => item.file === file)) {
      throw new Error(`@assets/${file} already holds another automation; rename one of them`);
    }
    write(name, file, live);
  }
  for (const { name, here: item } of hereOnly) {
    console.log(`· ${name}: kept @assets/${item.file}; it has no automation in Todoist`);
  }
}

interface Summary {
  validation: { state: string; issues: Json[] };
  connections: { isValid: boolean; missing: Json[] };
}
interface Published {
  automation: { id: string };
  verification?: { status: string };
}

/** Publishes one manifest through a draft: an edit of `live`, or a new automation. */
function publish(env: Env, item: Here, live: Live | undefined, confirmed: boolean): void {
  const name = manifestName(item.manifest);
  const manifest = fillEnv(item.manifest, env.values);
  const target = live ? ["--automation", live.id] : ["--personal"];
  const { draft } = tda<{ draft: { id: string } }>(
    env,
    ["draft", "create", ...target, "--stdin"],
    manifest,
  );
  let published = false;
  try {
    // A new automation needs the Linear and Todoist connections bound; an edit keeps its own.
    if (!live) tda(env, ["draft", "connect", draft.id, "--auto"]);
    const { summary } = tda<{ summary: Summary }>(
      env,
      ["draft", "publish", draft.id, "--stdin"],
      manifest,
    );
    if (summary.validation.state !== "ready" || !summary.connections.isValid) {
      const problems = {
        validation: summary.validation,
        missingConnections: summary.connections.missing,
      };
      throw new Error(redact(`Todoist won't publish it: ${JSON.stringify(problems)}`, env.secrets));
    }
    if (!confirmed) {
      console.log(
        `  ready to publish ${live ? `over ${live.id}` : "as a new automation"}; --yes does it`,
      );
      return;
    }
    const result = tda<Published>(
      env,
      ["draft", "publish", draft.id, "--yes", "--stdin"],
      manifest,
    );
    published = true;
    const verification = result.verification?.status ?? "unavailable";
    console.log(`↑ ${name}: published ${result.automation.id} (verification: ${verification})`);
    if (verification === "mismatched") {
      throw new Error("Todoist's copy doesn't match what was sent; run check to see how");
    }
  } finally {
    // The draft only carried the manifest; one left open would block the next edit.
    if (!published) tda(env, ["draft", "delete", draft.id, "--yes"]);
  }
}

function push(names: string[], confirmed: boolean): void {
  const here = readHere();
  const selected = names.map((name) => {
    const item = here.find((candidate) => candidate.file === `${name}.json`);
    if (!item) throw new Error(`No @assets/${name}.json\n\n${USAGE}`);
    return item;
  });
  const env = loadEnv();
  const { both, hereOnly, liveOnly } = pair(here, readLive(env));
  const chosen = (item: Here) => selected.length === 0 || selected.includes(item);
  const pending: { item: Here; live?: Live }[] = [];
  for (const { name, here: item, live } of both) {
    if (!chosen(item)) continue;
    if (sameManifest(item.manifest, live.manifest)) {
      console.log(`✓ ${name}: ${live.id} already matches @assets/${item.file}${disabled(live)}`);
    } else {
      console.log(`~ ${name}: ${live.id} differs from @assets/${item.file}${disabled(live)}`);
      printDiff(item.file, live, item.manifest);
      pending.push({ item, live });
    }
  }
  for (const { name, here: item } of hereOnly) {
    if (!chosen(item)) continue;
    console.log(`+ ${name}: not in Todoist; @assets/${item.file} becomes a new automation`);
    pending.push({ item });
  }
  for (const { item, live } of pending) {
    try {
      publish(env, item, live, confirmed);
    } catch (error) {
      process.exitCode = 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`✗ ${manifestName(item.manifest)}: ${redact(message, env.secrets)}`);
    }
  }
  if (selected.length === 0) {
    for (const { name, live } of liveOnly) {
      warn(`${name} (${live.id}) is in Todoist but not in the repo; left alone. pull adds it.`);
    }
  }
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "check") check();
  else if (command === "pull") pull();
  else if (command === "push") {
    push(
      args.filter((arg) => arg !== "--yes"),
      args.includes("--yes"),
    );
  } else {
    console.error(USAGE);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
