import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "@-/com.npmjs.jose";
import { isHistoryId } from "#gmail";

const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export async function authorizePubSub(
  authorization: string | null,
  account: string,
  audience: string,
  keys: JWTVerifyGetKey = googleKeys,
): Promise<boolean> {
  const token = authorization?.match(/^Bearer (\S+)$/i)?.[1];
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, keys, {
      algorithms: ["RS256"],
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience,
      requiredClaims: ["exp", "iat", "email", "email_verified"],
    });
    return payload.email === account && payload.email_verified === true;
  } catch {
    // Pub/Sub retries non-2xx responses, including when Google's key endpoint is unavailable.
    return false;
  }
}

export function parseGmailNotification(envelope: unknown) {
  const data = (envelope as { message?: { data?: unknown } } | null)?.message?.data;
  if (typeof data !== "string" || data.length > 4096) return null;
  try {
    const bytes = Uint8Array.from(atob(data.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
      c.charCodeAt(0),
    );
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
      emailAddress?: unknown;
      historyId?: unknown;
    } | null;
    return typeof parsed?.emailAddress === "string" && isHistoryId(parsed.historyId)
      ? { emailAddress: parsed.emailAddress, historyId: parsed.historyId }
      : null;
  } catch {
    return null;
  }
}
