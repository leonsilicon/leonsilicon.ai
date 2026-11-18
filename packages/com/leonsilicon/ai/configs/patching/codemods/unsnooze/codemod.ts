const additions = [
  {
    anchor: "    /Retrying in\\b/i,",
    addition: "    /Waiting for API response\\b/i,",
  },
  {
    anchor: "    /API Error:?\\s*\\(?429/i,",
    addition: [
      "    // A dropped stream has no HTTP status. Match Claude's error line, not",
      "    // quoted examples; the rest of the message may wrap onto another row.",
      "    /^\\s*(?:[⏺●•]\\s*)?API Error:?\\s*Connection lost\\b/i,",
    ].join("\n"),
  },
] as const;

/** Return null when already patched; reject upstream drift before any write. */
export function patchClaudeAdapter(source: string): string | null {
  let text = source;
  for (const { anchor, addition } of additions) {
    if (text.includes(addition)) continue;
    if (text.split(anchor).length !== 2) {
      throw new Error(`Unsupported Claude adapter layout: expected one ${anchor.trim()}`);
    }
    text = text.replace(anchor, `${anchor}\n${addition}`);
  }
  return text === source ? null : text;
}
