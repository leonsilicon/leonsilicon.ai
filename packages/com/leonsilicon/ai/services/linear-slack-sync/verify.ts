const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
  return [...signature].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const MAX_SKEW_MS = 5 * 60_000;

/** Slack's request signing: `v0=` + HMAC-SHA256 of `v0:{timestamp}:{body}`, within five minutes. */
export async function verifySlack(
  secret: string,
  timestamp: string | null,
  signature: string | null,
  body: string,
  now: number,
): Promise<boolean> {
  if (!timestamp || !signature) return false;
  if (Math.abs(now - Number(timestamp) * 1000) > MAX_SKEW_MS) return false;
  return equal(signature, `v0=${await hmacHex(secret, `v0:${timestamp}:${body}`)}`);
}

/**
 * Linear's webhook signing: `Linear-Signature` is the hex HMAC-SHA256 of the raw body, and the
 * body's `webhookTimestamp` (ms) must be recent.
 */
export async function verifyLinear(
  secret: string,
  signature: string | null,
  body: string,
  now: number,
): Promise<boolean> {
  if (!signature) return false;
  if (!equal(signature, await hmacHex(secret, body))) return false;
  let sent: unknown;
  try {
    sent = (JSON.parse(body) as { webhookTimestamp?: unknown }).webhookTimestamp;
  } catch {
    return false;
  }
  return typeof sent === "number" && Math.abs(now - sent) <= MAX_SKEW_MS;
}

export { hmacHex };
