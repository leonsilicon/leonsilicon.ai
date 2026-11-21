/**
 * Grok Bot's backend is Cursor's `aiserver.v1.GrokBotService` (Connect RPC on api2.cursor.sh). This
 * client calls it the way the Grok Bot desktop app does, with a Cursor session of Leon's own: one
 * sign-in made for this service (the CLI sign-in flow), separate from the desktop app's.
 */

export const API_ORIGIN = "https://api2.cursor.sh";
/** Cursor's public OAuth client ID for production sign-ins (the desktop app and CLI use it too). */
export const CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
const SERVICE = "aiserver.v1.GrokBotService";
/**
 * Refresh the access token when it has less than this left. A session token lasts 60 days, and a
 * refresh returns a new 60-day one, so the daily cron keeps the session alive with no sign-in.
 */
const REFRESH_MARGIN_MS = 30 * 86_400_000;

/** The headers the Grok Bot desktop app sends (`x-cursor-client-type: sand`). */
const CLIENT_HEADERS: Record<string, string> = {
  "x-cursor-client-type": "sand",
  "x-cursor-client-version": "1.2.3",
  "x-sand-box-namespace": "prod",
  "x-ghost-mode": "false",
};

export interface Session {
  accessToken: string;
  refreshToken: string;
}

/** Where the session lives. A refresh may rotate the refresh token, so it must be writable. */
export interface SessionStore {
  get(): Promise<Session | null>;
  put(session: Session): Promise<void>;
}

export class GrokBotApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "GrokBotApiError";
    this.status = status;
    this.code = code;
  }

  /** The session is signed out or revoked: someone has to sign in again. */
  get signedOut(): boolean {
    return this.status === 401 || this.code === "unauthenticated";
  }
}

/** The `exp` of a JWT in milliseconds, or null when the token isn't a JWT with one. */
export function jwtExpiryMs(token: string): number | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as {
      exp?: unknown;
    };
    return typeof json.exp === "number" ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

export interface GrokBotApiOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

export class GrokBotApi {
  private readonly store: SessionStore;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /** One refresh at a time per instance; concurrent calls share it. */
  private refreshing: Promise<Session> | undefined;

  constructor(store: SessionStore, options: GrokBotApiOptions = {}) {
    this.store = store;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
  }

  /** Calls one unary method of GrokBotService with a JSON body (Connect protocol). */
  async call<T>(method: string, body: object = {}): Promise<T> {
    let session = await this.session();
    let response = await this.post(method, body, session.accessToken);
    if (response.status === 401) {
      session = await this.refresh(session);
      response = await this.post(method, body, session.accessToken);
    }
    const text = await response.text();
    if (!response.ok) {
      let code: string | undefined;
      let message = text.slice(0, 300);
      try {
        const error = JSON.parse(text) as { code?: string; message?: string };
        code = error.code;
        message = error.message ?? message;
      } catch {}
      throw new GrokBotApiError(
        `${method} failed: HTTP ${response.status}${code ? ` ${code}` : ""}: ${message}`,
        response.status,
        code,
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Refreshes the session if it is due (the daily cron calls this). Returns the token's expiry. */
  async ensureFresh(): Promise<number | null> {
    const session = await this.session();
    return jwtExpiryMs(session.accessToken);
  }

  /** Whether the session works, without changing anything. */
  async sessionState(): Promise<"ok" | "signed_out" | "unknown"> {
    try {
      await this.call("ListGrokBotAgents", {});
      return "ok";
    } catch (error) {
      return error instanceof GrokBotApiError && error.signedOut ? "signed_out" : "unknown";
    }
  }

  private post(method: string, body: object, accessToken: string): Promise<Response> {
    return this.fetchImpl(`${API_ORIGIN}/${SERVICE}/${method}`, {
      method: "POST",
      headers: {
        ...CLIENT_HEADERS,
        "content-type": "application/json",
        "connect-protocol-version": "1",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });
  }

  private async session(): Promise<Session> {
    const session = await this.store.get();
    if (!session)
      throw new GrokBotApiError("No Grok Bot session is stored; sign in again (see README)", 401);
    const expiry = jwtExpiryMs(session.accessToken);
    if (expiry !== null && expiry - this.now() < REFRESH_MARGIN_MS) return this.refresh(session);
    return session;
  }

  private refresh(session: Session): Promise<Session> {
    this.refreshing ??= this.runRefresh(session).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async runRefresh(stale: Session): Promise<Session> {
    // Another instance may have refreshed already.
    const current = (await this.store.get()) ?? stale;
    if (current.accessToken !== stale.accessToken) {
      const expiry = jwtExpiryMs(current.accessToken);
      if (expiry === null || expiry - this.now() >= REFRESH_MARGIN_MS) return current;
    }
    // Cursor's session tokens refresh themselves: the refresh token is a session token too, and the
    // newest access token works as the next refresh token (checked 2026-11-21). Try the stored
    // refresh token first, then the newest access token.
    let lastStatus = 0;
    let lastError = "";
    for (const refreshToken of new Set([current.refreshToken, current.accessToken])) {
      const response = await this.fetchImpl(`${API_ORIGIN}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      });
      const json = (await response.json().catch(() => ({}))) as {
        access_token?: unknown;
        refresh_token?: unknown;
        error?: unknown;
        shouldLogout?: unknown;
      };
      lastStatus = response.status;
      lastError = typeof json.error === "string" ? json.error : "";
      if (!response.ok || typeof json.access_token !== "string" || !json.access_token) continue;
      const next: Session = {
        accessToken: json.access_token,
        refreshToken:
          typeof json.refresh_token === "string" && json.refresh_token
            ? json.refresh_token
            : json.access_token,
      };
      await this.store.put(next);
      return next;
    }
    throw new GrokBotApiError(
      `The Grok Bot session could not be refreshed (HTTP ${lastStatus}${lastError ? ` ${lastError}` : ""}); sign in again (see README)`,
      401,
      "unauthenticated",
    );
  }
}

export function memorySessionStore(initial: Session | null = null): SessionStore & {
  value: Session | null;
} {
  const store = {
    value: initial,
    get: async () => store.value,
    put: async (session: Session) => {
      store.value = session;
    },
  };
  return store;
}
