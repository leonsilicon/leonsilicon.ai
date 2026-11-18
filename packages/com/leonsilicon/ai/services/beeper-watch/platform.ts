/**
 * Which platform a Beeper connection is, as the short name its feed channel uses: `whatsapp` for
 * #feed-whatsapp (2026-11-18, one feed channel per connection instead of one for all of Beeper).
 *
 * Beeper account IDs start with the bridge's name (`whatsapp.1914…`, `instagramgo.1105…`,
 * `imessage_ecdb…`), which stays the same when Beeper renames a network for display. The `go`
 * suffix of Beeper's Go bridges is dropped, and a few bridge names map to what people call them.
 */
const ALIASES: Record<string, string> = {
  matrix: "beeper",
  hungryserv: "beeper",
  "chatgpt-dots": "chatgpt",
  grokbot: "grok",
  twitter: "x",
  facebook: "messenger",
  gmessages: "sms",
  gvoice: "google-voice",
  googlechat: "google-chat",
};

export function platformOf(accountID: string, network = ""): string {
  let bridge = (accountID.split(/[._]/)[0] ?? "").toLowerCase().replace(/^local-/, "");
  bridge = bridge.replace(/^(.{3,})go$/, "$1");
  const name = ALIASES[bridge] ?? slug(bridge);
  return name || slug(network) || "other";
}

/** A Slack channel name: lowercase letters, digits and hyphens, at most 80 characters. */
export function channelName(prefix: string, platform: string): string {
  return `${prefix}${platform}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .slice(0, 80);
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
