/** Leon's Slack web session: the `xoxc-` token from app.slack.com and its `d` cookie. */
export interface SlackSession {
  token: string;
  cookie: string;
}

export type SlackParams = Record<string, string | number | boolean | undefined>;

export interface SlackResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

/** One Slack Web API call; throws `SlackError` when Slack answers `ok: false`. */
export type SlackCall = (method: string, params?: SlackParams) => Promise<SlackResponse>;

export class SlackError extends Error {
  readonly method: string;
  readonly code: string;

  constructor(method: string, code: string) {
    super(`Slack ${method} failed: ${code}`);
    this.name = "SlackError";
    this.method = method;
    this.code = code;
  }
}

const MAX_RETRY_AFTER_SECONDS = 10;

/**
 * Calls Slack's Web API as Leon's browser session does: the token in the form body and the `d`
 * cookie in the Cookie header. Posts made this way carry no `bot_id` or `app_id`, unlike posts
 * made with any app's user token (`xoxp-`). One retry after a short 429.
 */
export function sessionClient(session: SlackSession, fetchImpl: typeof fetch = fetch): SlackCall {
  const call = async (method: string, params: SlackParams = {}, retried = false) => {
    const body = new URLSearchParams({ token: session.token });
    for (const [key, value] of Object.entries(params))
      if (value !== undefined) body.set(key, String(value));
    const response = await fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      body,
      headers: { Cookie: `d=${session.cookie}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 429) {
      const wait = Number(response.headers.get("retry-after") ?? "1");
      if (!retried && wait <= MAX_RETRY_AFTER_SECONDS) {
        await new Promise((resolve) => setTimeout(resolve, wait * 1000));
        return call(method, params, true);
      }
      throw new SlackError(method, "ratelimited");
    }
    let data: SlackResponse;
    try {
      data = (await response.json()) as SlackResponse;
    } catch {
      throw new SlackError(method, `http_${response.status}`);
    }
    if (!data.ok) throw new SlackError(method, data.error ?? `http_${response.status}`);
    return data;
  };
  return (method, params) => call(method, params);
}
