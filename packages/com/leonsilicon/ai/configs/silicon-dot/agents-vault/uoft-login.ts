import { browser, evaluate, fill } from "#agents-vault";

/** Title fragment of the Agents vault item holding the UTORid login and the Duo passcode seed. */
export const UOFT_ITEM = "UofT";

export interface UoftLoginOptions {
  /** camoufox-browser session. The default "uoft" is a persistent profile that Duo trusts. */
  session?: string;
  /** Page to end up on. */
  url?: string;
  /** Keep the profile on disk and tell Duo the device is trusted. */
  persistent?: boolean;
  timeoutMs?: number;
  log?: (line: string) => void;
}

interface PageState {
  href: string;
  host: string;
  title: string;
  ready: string;
  text: string;
  password: boolean;
  loginForm: boolean;
  passcode: string | null;
  buttons: string[];
}

// Reads only page structure and visible text; input values never leave the page.
const STATE = String.raw`() => {
  const visible = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const squash = (s) => (s || "").replace(/\s+/g, " ").trim();
  const passcode = [...document.querySelectorAll("input")].find((i) =>
    visible(i) && /passcode/i.test([i.name, i.id, i.getAttribute("aria-label"), i.labels && i.labels[0] && i.labels[0].innerText].join(" ")));
  return {
    href: location.href,
    host: location.hostname,
    title: document.title,
    ready: document.readyState,
    text: squash(document.body && document.body.innerText).slice(0, 2000),
    password: !!document.querySelector("input[type=password]"),
    loginForm: [...document.querySelectorAll("input[type=password], input[type=email]")].some(visible),
    passcode: passcode ? (passcode.id ? "#" + CSS.escape(passcode.id) : passcode.name ? 'input[name="' + passcode.name + '"]' : null) : null,
    buttons: [...document.querySelectorAll("button, [role=button]")].filter(visible)
      .map((b) => squash(b.innerText || b.getAttribute("aria-label"))).filter(Boolean),
  };
}`;

const INTERMEDIATE =
  /(^|\.)login\.instructure\.com$|^sso\.canvaslms\.com$|^idpz\.utorauth\.utoronto\.ca$|\.duosecurity\.com$/;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function clickButton(session: string, prefix: string): boolean {
  return evaluate<boolean>(
    session,
    String.raw`() => { const b = [...document.querySelectorAll("button, [role=button]")].find((e) => (e.innerText || "").replace(/\s+/g, " ").trim().startsWith(${JSON.stringify(prefix)})); if (!b) return false; b.click(); return true; }`,
  );
}

function openSession(session: string, url: string, persistent: boolean) {
  try {
    browser(session, ["goto", url]);
  } catch (error) {
    if (!/is not open/.test(String(error))) throw error;
    browser(session, ["open", url, ...(persistent ? ["--persistent"] : [])]);
  }
}

/**
 * Signs in to a UofT site through UTORid weblogin and Duo, using the Agents vault's UofT item.
 * Duo is answered with a passcode from the item's one-time password, never a push.
 */
export async function uoftLogin({
  session = "uoft",
  url = "https://q.utoronto.ca",
  persistent = true,
  timeoutMs = 150_000,
  log = () => {},
}: UoftLoginOptions = {}): Promise<{ href: string; title: string }> {
  openSession(session, url, persistent);
  const deadline = Date.now() + timeoutMs;
  let passwordTries = 0;
  let passcodeTries = 0;
  let lastPasscodeWindow = -1;
  let settled = 0;
  let state: PageState | undefined;

  while (Date.now() < deadline) {
    await sleep(1500);
    try {
      state = evaluate<PageState>(session, STATE);
    } catch {
      continue; // Navigating.
    }

    if (state.host === "idpz.utorauth.utoronto.ca") {
      settled = 0;
      if (!state.password) continue;
      if (passwordTries > 0) {
        throw new Error(
          `UofT weblogin didn't accept the vault's UTORid password. Page: ${state.text.slice(0, 300)}`,
        );
      }
      log("weblogin: entering UTORid and password");
      await fill(session, "#username", UOFT_ITEM, "username");
      await fill(session, "#password", UOFT_ITEM, "password", { submit: true });
      passwordTries++;
      continue;
    }

    if (state.host.endsWith(".duosecurity.com")) {
      settled = 0;
      if (state.passcode) {
        // A Duo passcode is single-use, so a retry waits for the next 30-second code.
        const window = Math.floor(Date.now() / 30_000);
        if (window === lastPasscodeWindow) continue;
        if (passcodeTries >= 3) {
          throw new Error(
            `Duo rejected ${passcodeTries} passcodes. Page: ${state.text.slice(0, 300)}`,
          );
        }
        log(passcodeTries ? "duo: retrying with the next passcode" : "duo: entering passcode");
        await fill(session, state.passcode, UOFT_ITEM, "otp", { submit: true });
        passcodeTries++;
        lastPasscodeWindow = window;
        continue;
      }
      const trust = persistent ? "Yes, this is my device" : "No, other people use this device";
      for (const [prefix, line] of [
        [trust, `duo: answering "${trust}"`],
        ["Duo Mobile passcode", "duo: choosing a Duo Mobile passcode"],
        ["Other options", "duo: opening other options instead of waiting for the push"],
      ] as const) {
        if (state.buttons.some((b) => b.startsWith(prefix))) {
          log(line);
          clickButton(session, prefix);
          break;
        }
      }
      continue;
    }

    if (INTERMEDIATE.test(state.host) || state.ready !== "complete") {
      settled = 0;
      continue;
    }
    // Two quiet polls off the login hosts means the redirects are over.
    if (++settled < 2) continue;
    if (state.loginForm) {
      throw new Error(
        `Ended on a page that still asks for a login: "${state.title}" (${state.host}). If the site has its own login form, like MarkUs, use agents-vault fill with its item.`,
      );
    }
    return { href: state.href, title: state.title };
  }
  throw new Error(
    `Timed out signing in to UofT. Last page: ${state ? `${state.title} (${state.host}) ${state.text.slice(0, 200)}` : "unknown"}`,
  );
}
