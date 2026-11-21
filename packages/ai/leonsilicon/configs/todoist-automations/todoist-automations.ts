export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const isObject = (value: Json): value is { [key: string]: Json } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The file a manifest is kept in, `@assets/<slug>.json`, from the automation's name: "Mirror Linear
 * tasks to Todoist" is `mirror-linear-tasks-to-todoist`. The name is what ties the file to the
 * automation in Todoist, whose id changes whenever it is recreated.
 */
export function slug(name: string): string {
  const result = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!result)
    throw new Error(`Can't make a file name from the automation name ${JSON.stringify(name)}`);
  return result;
}

/** The manifest's `name`, which identifies its automation in Todoist. */
export function manifestName(manifest: Json): string {
  const name = isObject(manifest) ? manifest.name : undefined;
  if (typeof name !== "string" || !name.trim()) throw new Error("The manifest has no name");
  return name;
}

/** `{ "$env": "NAME" }`, a stand-in for a value from `.env.schema` that this public repo can't hold. */
function envRef(value: Json): string | undefined {
  if (!isObject(value)) return undefined;
  const name = value.$env;
  return Object.keys(value).length === 1 && typeof name === "string" ? name : undefined;
}

function walk(value: Json, visit: (value: Json) => Json | undefined): Json {
  const replaced = visit(value);
  if (replaced !== undefined) return replaced;
  if (Array.isArray(value)) return value.map((item) => walk(item, visit));
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, visit)]));
  }
  return value;
}

/** The `$env` names a manifest refers to, sorted. */
export function envNames(manifest: Json): string[] {
  const names = new Set<string>();
  walk(manifest, (value) => {
    const name = envRef(value);
    if (name !== undefined) names.add(name);
    return undefined;
  });
  return [...names].sort();
}

/** The manifest Todoist runs: every `{ "$env": NAME }` replaced by `values[NAME]`. */
export function fillEnv(manifest: Json, values: Readonly<Record<string, string>>): Json {
  return walk(manifest, (value) => {
    const name = envRef(value);
    if (name === undefined) return undefined;
    const filled = values[name];
    if (filled === undefined) throw new Error(`No value for $env ${name}`);
    return filled;
  });
}

/**
 * The reverse of `fillEnv`, for a manifest fetched from Todoist: every string equal to one of the
 * values becomes `{ "$env": NAME }`. Throws when a value is still there afterwards (inside a longer
 * string, or as a key), rather than return a manifest that would put it in this public repo.
 */
export function toEnvRefs(manifest: Json, values: Readonly<Record<string, string>>): Json {
  const entries = Object.entries(values).filter(([, value]) => value !== "");
  const result = walk(manifest, (value) => {
    if (typeof value !== "string") return undefined;
    const match = entries.find(([, v]) => v === value);
    return match ? { $env: match[0] } : undefined;
  });
  const text = JSON.stringify(result);
  for (const [name, value] of entries) {
    if (text.includes(value)) {
      throw new Error(
        `${name}'s value is part of a longer string or a key in the manifest, where { "$env": "${name}" } can't stand in for it`,
      );
    }
  }
  return result;
}

/**
 * The text with every value replaced by `$NAME`, for anything printed: the Deploy workflow's logs are
 * public, like this repo.
 */
export function redact(text: string, values: Readonly<Record<string, string>>): string {
  return Object.entries(values)
    .filter(([, value]) => value !== "")
    .sort(([, a], [, b]) => b.length - a.length)
    .reduce((result, [name, value]) => result.split(value).join(`$${name}`), text);
}

/** The value with object keys sorted, so two manifests compare equal whatever their key order. */
export function sortKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key] as Json)]),
    );
  }
  return value;
}

export const sameManifest = (a: Json, b: Json): boolean =>
  JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));

export interface Pairing<Here, Live> {
  /** Kept here and live in Todoist under the same name. */
  both: { name: string; here: Here; live: Live }[];
  /** Kept here, with no automation of that name in Todoist. */
  hereOnly: { name: string; here: Here }[];
  /** Live in Todoist, with no manifest here. */
  liveOnly: { name: string; live: Live }[];
}

/** Pairs the manifests here with the automations in Todoist by name. Throws on a name used twice. */
export function pairByName<Here, Live>(
  here: readonly Here[],
  live: readonly Live[],
  nameOf: { here: (item: Here) => string; live: (item: Live) => string },
): Pairing<Here, Live> {
  const index = <T>(items: readonly T[], nameOfItem: (item: T) => string, where: string) => {
    const byName = new Map<string, T>();
    for (const item of items) {
      const name = nameOfItem(item);
      if (byName.has(name))
        throw new Error(`Two automations ${where} are named ${JSON.stringify(name)}`);
      byName.set(name, item);
    }
    return byName;
  };
  const hereByName = index(here, nameOf.here, "here");
  const liveByName = index(live, nameOf.live, "in Todoist");
  const pairing: Pairing<Here, Live> = { both: [], hereOnly: [], liveOnly: [] };
  for (const [name, item] of hereByName) {
    const liveItem = liveByName.get(name);
    if (liveItem === undefined) pairing.hereOnly.push({ name, here: item });
    else pairing.both.push({ name, here: item, live: liveItem });
  }
  for (const [name, item] of liveByName) {
    if (!hereByName.has(name)) pairing.liveOnly.push({ name, live: item });
  }
  return pairing;
}
