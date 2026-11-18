import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";

/** Login Keychain service holding the "Silicon Dot" 1Password service account token. */
export const KEYCHAIN_SERVICE = "silicon-dot-op-service-account";
/** The only vault the service account can read. */
export const VAULT = "Agents";
const REDACTED = "‹redacted›";

export interface Field {
  id: string;
  type: string;
  purpose?: string;
  label?: string;
  value?: string;
  totp?: string;
}

export interface Item {
  id: string;
  title: string;
  category: string;
  urls?: { href: string; primary?: boolean }[];
  fields?: Field[];
}

export interface FillOptions {
  submit?: boolean;
  click?: string;
}

let cachedToken: string | undefined;

function serviceAccountToken(): string {
  if (cachedToken) return cachedToken;
  const result = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-a", userInfo().username, "-s", KEYCHAIN_SERVICE, "-w"],
    { encoding: "utf8" },
  );
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(
      `No Silicon Dot service account token in the login Keychain (service "${KEYCHAIN_SERVICE}"). Run _install-agents-vault.`,
    );
  }
  cachedToken = result.stdout.trim();
  return cachedToken;
}

/** Environment for `op` that authenticates only as the service account, never as the desktop app's full account. */
export function opEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OP_SERVICE_ACCOUNT_TOKEN: serviceAccountToken(),
  };
  for (const name of Object.keys(env)) {
    if (/^OP_(SESSION_|ACCOUNT$|CONNECT_|BIOMETRIC_UNLOCK)/.test(name)) delete env[name];
  }
  return env;
}

/** Runs `op` as the service account. With `inherit`, output goes straight to the terminal. */
export function op(args: string[], { inherit = false } = {}): string {
  const result = spawnSync("op", args, {
    env: opEnv(),
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`op ${args.slice(0, 2).join(" ")} failed: ${(result.stderr ?? "").trim()}`);
  }
  return result.stdout ?? "";
}

let cachedItems: Item[] | undefined;

export function listItems(): Item[] {
  cachedItems ??= JSON.parse(op(["item", "list", "--vault", VAULT, "--format", "json"])) as Item[];
  return cachedItems;
}

/** Fetched fresh every time so one-time codes are current. */
export function getItem(id: string): Item {
  return JSON.parse(op(["item", "get", id, "--vault", VAULT, "--format", "json"])) as Item;
}

/** Finds one item by ID, exact title, or a case-insensitive title fragment such as "uoft". */
export function matchItem(items: Item[], query: string): Item {
  const q = query.trim().toLowerCase();
  const tiers = [
    items.filter((item) => item.id === query.trim()),
    items.filter((item) => item.title.toLowerCase() === q),
    items.filter((item) => item.title.toLowerCase().includes(q)),
  ];
  for (const matches of tiers) {
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new Error(
        `"${query}" matches ${matches.length} items: ${matches.map((m) => `${m.title} (${m.id})`).join(", ")}. Use the ID.`,
      );
    }
  }
  throw new Error(
    `No item matching "${query}" in the ${VAULT} vault. Items: ${items.map((i) => i.title).join(", ")}`,
  );
}

/** Selects a field by "username", "password", "otp", or a field label or ID. Notes are never selectable. */
export function selectField(item: Item, name: string): Field {
  const n = name.trim().toLowerCase();
  const fields = (item.fields ?? []).filter((f) => f.purpose !== "NOTES");
  let matches: Field[];
  if (n === "otp" || n === "totp" || n === "one-time password") {
    matches = fields.filter((f) => f.type === "OTP");
  } else if (n === "username" || n === "password") {
    matches = fields.filter((f) => f.purpose === n.toUpperCase());
  } else {
    matches = fields.filter((f) => f.id === name || f.label?.toLowerCase() === n);
  }
  if (matches.length === 1) return matches[0]!;
  const available = fields.map((f) => f.label ?? f.id).join(", ");
  if (matches.length > 1)
    throw new Error(`"${name}" matches several fields of ${item.title}: ${available}`);
  throw new Error(`${item.title} has no field "${name}". Fields: ${available}`);
}

export function fieldValue(item: Item, field: Field): string {
  const value = field.type === "OTP" ? field.totp : field.value;
  if (!value) throw new Error(`${item.title}'s "${field.label ?? field.id}" field is empty.`);
  return value;
}

/** Passwords, concealed fields and one-time codes must be submitted in the same step as they are filled. */
export function isSecret(field: Field): boolean {
  return field.type === "CONCEALED" || field.type === "OTP" || field.purpose === "PASSWORD";
}

/** True when the page is HTTPS and its host is one of the item's saved hosts or a subdomain of one. */
export function originAllowed(pageUrl: string, itemUrls: string[]): boolean {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return false;
  }
  if (page.protocol !== "https:") return false;
  return itemUrls.some((href) => {
    let host: string;
    try {
      host = new URL(href).hostname;
    } catch {
      return false;
    }
    return page.hostname === host || page.hostname.endsWith(`.${host}`);
  });
}

/** Removes secrets, including their JS-string-escaped forms, from text that may reach a transcript. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    const forms = new Set([
      secret,
      JSON.stringify(secret).slice(1, -1),
      secret.replaceAll("\\", "\\\\").replaceAll("'", "\\'"),
    ]);
    for (const form of forms) out = out.replaceAll(form, REDACTED);
  }
  return out;
}

/** Runs a camoufox-browser command for a session, returning redacted output and throwing on failure. */
export function browser(session: string, args: string[], secrets: string[] = []): string {
  const result = spawnSync("camoufox-browser", [`-s=${session}`, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const output = redact(`${result.stdout ?? ""}${result.stderr ?? ""}`, secrets);
  if (result.status !== 0 || /^### Error|is not open, please run open first/m.test(output)) {
    throw new Error(`camoufox-browser ${args[0]} failed:\n${output.trim()}`);
  }
  return output;
}

/** Evaluates a page function and returns its JSON value. Never pass secrets in `fn` unless listed in `secrets`. */
export function evaluate<T>(session: string, fn: string, secrets: string[] = []): T {
  const output = browser(session, ["--raw", "eval", fn], secrets).trim();
  return JSON.parse(output) as T;
}

export function pageUrl(session: string): string {
  return evaluate<string>(session, "() => location.href");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fills one vault field into a page element without printing the value.
 * The page must be on one of the item's saved websites. Secrets must be submitted in the same call,
 * because a page snapshot shows a filled field's contents; any copy still on the page afterwards is cleared.
 */
export async function fill(
  session: string,
  target: string,
  itemQuery: string,
  fieldName: string,
  { submit = false, click }: FillOptions = {},
): Promise<{ item: string; field: string; host: string; cleared: number }> {
  const item = getItem(matchItem(listItems(), itemQuery).id);
  const field = selectField(item, fieldName);
  const secret = isSecret(field);
  if (secret && !submit && !click) {
    throw new Error(
      `"${field.label ?? field.id}" is secret, so submit it in the same command with --submit or --click <target>. A snapshot would show it otherwise.`,
    );
  }
  const url = pageUrl(session);
  const saved = (item.urls ?? []).map((u) => u.href);
  if (!originAllowed(url, saved)) {
    throw new Error(
      `Refusing to fill ${item.title} into ${new URL(url).host}: it isn't one of the item's saved websites (${saved.join(", ") || "none"}). If the site is genuine, Leon has to add it to the 1Password item.`,
    );
  }
  const value = fieldValue(item, field);
  browser(session, ["fill", target, value, ...(submit ? ["--submit"] : [])], [value]);
  if (click) browser(session, ["click", click], [value]);
  let cleared = 0;
  if (secret) {
    await sleep(3000);
    try {
      cleared = evaluate<number>(
        session,
        `() => { let n = 0; for (const input of document.querySelectorAll("input, textarea")) if (input.value === ${JSON.stringify(value)}) { input.value = ""; n++; } return n; }`,
        [value],
      );
    } catch {
      // The page was still navigating, so the field is gone.
    }
  }
  return { item: item.title, field: field.label ?? field.id, host: new URL(url).host, cleared };
}
