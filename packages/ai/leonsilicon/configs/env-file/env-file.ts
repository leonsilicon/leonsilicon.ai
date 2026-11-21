const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * An env file for `node --env-file`, one `KEY='value'` line per defined value. Single quotes keep
 * the value literal; a value that contains one gets backticks (also literal), and double quotes only
 * as a last resort, for a value without backslashes (Node expands escapes inside double quotes).
 * Throws rather than write a value Node would read back differently.
 */
export function formatEnvFile(values: Readonly<Record<string, unknown>>, header?: string): string {
  const lines = header ? header.split("\n").map((line) => `# ${line}`) : [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    if (!KEY.test(key)) throw new Error(`Not an env var name: ${JSON.stringify(key)}`);
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (/[\r\n]/.test(text)) throw new Error(`${key} spans more than one line`);
    const quote = ["'", "`", ...(text.includes("\\") ? [] : ['"'])].find((q) => !text.includes(q));
    if (!quote) throw new Error(`${key} can't be quoted for an env file`);
    lines.push(`${key}=${quote}${text}${quote}`);
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}
