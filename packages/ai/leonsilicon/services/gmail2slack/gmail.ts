import type { GmailMessage } from "#mime";

/**
 * Gmail's REST API with an OAuth refresh token, through `fetch` (no Google SDK, so it runs in a
 * Worker). Read-only: the feed needs only `gmail.readonly`.
 */

export class GmailError extends Error {
  readonly status: number;
  readonly reason: string;

  constructor(what: string, status: number, reason: string) {
    super(`${what}: ${status} ${reason}`);
    this.name = "GmailError";
    this.status = status;
    this.reason = reason;
  }
}

export interface GmailCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface HistoryPage {
  historyId: string;
  messageIds: string[];
  nextPageToken?: string;
}

export interface GmailLabel {
  id: string;
  name: string;
  type?: string;
}

/** The slice of Gmail the feed uses, so tests can pass a fake. */
export interface GmailApi {
  profile(): Promise<{ emailAddress: string; historyId: string }>;
  /** One page of `messageAdded` history after `startHistoryId`. A 404 means it's too old. */
  history(startHistoryId: string, pageToken?: string): Promise<HistoryPage>;
  /** Message IDs matching a search, spam and trash included, one page at a time. */
  list(query: string, pageToken?: string): Promise<{ ids: string[]; nextPageToken?: string }>;
  message(id: string): Promise<GmailMessage>;
  /** A part's body that `format=full` left out, as base64url. */
  attachment(messageId: string, attachmentId: string): Promise<string>;
  labels(): Promise<GmailLabel[]>;
}

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export function isHistoryId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{1,20}$/.test(value);
}

export class GmailClient implements GmailApi {
  readonly #credentials: GmailCredentials;
  readonly #fetch: typeof fetch;
  #token: { value: string; expiresAt: number } | null = null;

  constructor(credentials: GmailCredentials, fetchImpl: typeof fetch = fetch) {
    this.#credentials = credentials;
    // Called through a wrapper: Workers' fetch throws "Illegal invocation" with any other `this`.
    this.#fetch = (input, init) => fetchImpl(input, init);
  }

  async #accessToken(): Promise<string> {
    if (this.#token && this.#token.expiresAt > Date.now() + 60_000) return this.#token.value;
    const response = await this.#fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.#credentials.clientId,
        client_secret: this.#credentials.clientSecret,
        refresh_token: this.#credentials.refreshToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!response.ok || !data.access_token)
      throw new GmailError("token", response.status, data.error ?? "no access token");
    this.#token = {
      value: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
    return data.access_token;
  }

  async #request<T>(
    what: string,
    path: string,
    params: Record<string, string | string[]> = {},
    payload?: Record<string, string>,
  ) {
    const url = new URL(`${API}${path}`);
    for (const [key, value] of Object.entries(params))
      for (const one of Array.isArray(value) ? value : [value]) url.searchParams.append(key, one);
    for (let attempt = 0; ; attempt++) {
      const response = await this.#fetch(url, {
        headers: {
          authorization: `Bearer ${await this.#accessToken()}`,
          ...(payload && { "content-type": "application/json" }),
        },
        ...(payload && { method: "POST", body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return (await response.json()) as T;
      const body = (await response.json().catch(() => ({}))) as {
        error?: { message?: string; errors?: Array<{ reason?: string }> };
      };
      const reason = body.error?.errors?.[0]?.reason ?? body.error?.message ?? "error";
      if (response.status === 401 && attempt === 0) {
        this.#token = null;
        continue;
      }
      // Gmail reports its per-user rate limits as 403 rateLimitExceeded / userRateLimitExceeded.
      const limited =
        response.status === 429 || (response.status === 403 && /ratelimit/i.test(reason));
      if ((limited || response.status >= 500) && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        continue;
      }
      throw new GmailError(what, response.status, reason);
    }
  }

  async profile() {
    const data = await this.#request<{ emailAddress: string; historyId: string }>(
      "profile",
      "/profile",
    );
    return { emailAddress: data.emailAddress, historyId: String(data.historyId) };
  }

  async watch(topicName: string): Promise<{ historyId: string; expiration: number }> {
    const data = await this.#request<{ historyId?: unknown; expiration?: string }>(
      "watch",
      "/watch",
      {},
      { topicName },
    );
    const expiration = Number(data.expiration);
    if (!isHistoryId(data.historyId) || !Number.isSafeInteger(expiration) || expiration <= 0)
      throw new Error("invalid Gmail watch response");
    return { historyId: data.historyId, expiration };
  }

  async history(startHistoryId: string, pageToken?: string): Promise<HistoryPage> {
    const data = await this.#request<{
      historyId: string;
      nextPageToken?: string;
      history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>;
    }>("history", "/history", {
      startHistoryId,
      historyTypes: "messageAdded",
      maxResults: "500",
      ...(pageToken ? { pageToken } : {}),
    });
    const messageIds: string[] = [];
    for (const record of data.history ?? [])
      for (const added of record.messagesAdded ?? []) messageIds.push(added.message.id);
    return {
      historyId: String(data.historyId),
      messageIds,
      ...(data.nextPageToken ? { nextPageToken: data.nextPageToken } : {}),
    };
  }

  async list(query: string, pageToken?: string) {
    const data = await this.#request<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(
      "list",
      "/messages",
      {
        q: query,
        includeSpamTrash: "true",
        maxResults: "500",
        ...(pageToken ? { pageToken } : {}),
      },
    );
    return {
      ids: (data.messages ?? []).map((m) => m.id),
      ...(data.nextPageToken ? { nextPageToken: data.nextPageToken } : {}),
    };
  }

  message(id: string) {
    return this.#request<GmailMessage>("message", `/messages/${encodeURIComponent(id)}`, {
      format: "full",
    });
  }

  async attachment(messageId: string, attachmentId: string) {
    const data = await this.#request<{ data?: string }>(
      "attachment",
      `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
    return data.data ?? "";
  }

  async labels() {
    const data = await this.#request<{ labels?: GmailLabel[] }>("labels", "/labels");
    return data.labels ?? [];
  }
}
