import type { BudgetState, QueuedItem } from "#types";

/**
 * Usage policy for the Grok relay (since v1.2.0, 2026-11-07). Grok Bot bills by agent steps and tokens,
 * and Hermes was sending follow-ups to bots still working on its previous message (63 of 134 sends
 * landed under 3 minutes after the last one), each starting another full run. These pure helpers decide
 * when a bot is busy, merge queued messages into one, keep an hourly budget that sends Hermes to Leon,
 * and steer Linear and Todoist work to Hermes's own MCP tools.
 */

export const HOURLY_BUDGET = 25;
/** Added for the rolling hour after Leon approves more. */
export const EXTENSION = 25;
/** Urgent stop or correction sends allowed per hour past an exhausted budget. */
export const URGENT_OVER_BUDGET = 5;
export const HOUR_MS = 60 * 60 * 1000;
/** No reply yet: assume the bot is still working this long. */
export const NO_REPLY_BUSY_MS = 10 * 60 * 1000;
/** The bot posted this recently: it may still be sending. */
export const QUIET_MS = 60 * 1000;
/** Only acknowledgements so far: give it this long to post the real answer… */
export const ACK_QUIET_MS = 5 * 60 * 1000;
/** …but only while our last message is this fresh. */
export const ACK_WINDOW_MS = 20 * 60 * 1000;
/**
 * How much of a chat `busy` needs: every rule above looks at most this far back (the 20-minute
 * acknowledgement window, with room to spare).
 */
export const BUSY_WINDOW_MS = 25 * 60 * 1000;
/** Flush a queue this old even if the bot still looks busy. */
export const MAX_QUEUE_AGE_MS = 20 * 60 * 1000;
export const MIN_JUSTIFICATION = 20;
export const BOOKKEEPING_BOTS = ["linear bot", "todoist bot"];

export function compareKeys(a: unknown, b: unknown): number {
  const sa = String(a);
  const sb = String(b);
  if (/^\d+$/.test(sa) && /^\d+$/.test(sb)) {
    const x = BigInt(sa);
    const y = BigInt(sb);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** HTML to readable text with links kept, for a source that hands replies over as HTML. */
export function plain(html: unknown): string {
  return String(html)
    .replace(
      /<a\s[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gis,
      (_match: string, href: string, label: string) =>
        label.replace(/<[^>]+>/g, "") === href ? href : `${label} (${href})`,
    )
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/(p|li|ul|ol|h\d|pre|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n\s*\n- /g, "\n- ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const ACK =
  /^(on it|checking|looking|i['’]ll|i will|i['’]m (checking|looking|pulling|working|on it|going|starting|reading)|i am (checking|looking|pulling|working)|working on|got it|sure|let me|one moment|give me a (moment|sec|second|minute))/i;

export function isAck(text: string): boolean {
  const start = text.replace(/^[\s"'*_>]+/, "");
  return start.length < 200 && ACK.test(start);
}

/** What `busy` reads of a message. */
export interface ChatLine {
  sortKey: string;
  isSender: boolean;
  timestamp: string;
  text?: string;
  isDeleted?: boolean;
}

const at = (message: ChatLine): number => Date.parse(message.timestamp);

/**
 * Whether a bot is still working, judged from the chat itself, so it survives restarts. "Out" is
 * anything from Leon's account (Leon or Hermes).
 */
export function busy(
  messages: readonly ChatLine[],
  now: number = Date.now(),
  { windowed = false }: { windowed?: boolean } = {},
): { busy: boolean; reason: string } {
  const list = messages
    .filter((message) => !message.isDeleted)
    .sort((a, b) => compareKeys(a.sortKey, b.sortKey));
  const lastOut = list.findLastIndex((message) => message.isSender);
  const last = list[lastOut];
  if (!last) {
    // `windowed`: these are only the last BUSY_WINDOW_MS of the chat, so Leon's message may be
    // older than that. Every rule that needs it has expired by then; a bot still posting hasn't.
    const newest = windowed ? list.at(-1) : undefined;
    if (newest && now - at(newest) < QUIET_MS) {
      return {
        busy: true,
        reason: `the bot posted ${Math.round((now - at(newest)) / 1000)}s ago and may still be sending`,
      };
    }
    return {
      busy: false,
      reason: windowed
        ? "nothing from Leon in this chat lately, and the bot is quiet"
        : "no message from Leon in this chat yet",
    };
  }
  const outAge = now - at(last);
  const replies = list.slice(lastOut + 1).filter((message) => !message.isSender);
  const secs = (ms: number): string => `${Math.round(ms / 1000)}s`;
  const latest = replies.at(-1);
  if (!latest) {
    return outAge < NO_REPLY_BUSY_MS
      ? { busy: true, reason: `no reply yet to the last message, sent ${secs(outAge)} ago` }
      : {
          busy: false,
          reason: `the last message got no reply in ${secs(outAge)}; treating the bot as idle`,
        };
  }
  const quiet = now - at(latest);
  if (quiet < QUIET_MS)
    return { busy: true, reason: `the bot posted ${secs(quiet)} ago and may still be sending` };
  if (
    replies.every((message) => isAck(message.text ?? "")) &&
    quiet < ACK_QUIET_MS &&
    outAge < ACK_WINDOW_MS
  ) {
    return {
      busy: true,
      reason: `the bot has only acknowledged so far (${secs(quiet)} ago) and is probably still working`,
    };
  }
  return { busy: false, reason: `the bot finished replying ${secs(quiet)} ago` };
}

/** One item goes out unchanged; several become one numbered message, in Leon's lowercase voice. */
export function compose(items: ReadonlyArray<string | QueuedItem>): string {
  const texts = items
    .map((item) => (typeof item === "string" ? item : item.text).trim())
    .filter(Boolean);
  if (texts.length <= 1) return texts[0] ?? "";
  return `a few more things, in order:\n\n${texts.map((text, index) => `${index + 1}. ${text}`).join("\n\n")}`;
}

/** The longest prefix of the queue whose composed message fits in `max` characters (at least one item). */
export function takeBatch<T extends string | QueuedItem>(items: readonly T[], max: number): T[] {
  let count = 1;
  while (count < items.length && compose(items.slice(0, count + 1)).length <= max) count++;
  return items.slice(0, count);
}

/** Budget state, pruned to the last hour. */
export function pruneBudget(
  state: Partial<BudgetState> | null | undefined,
  now: number = Date.now(),
): BudgetState {
  const fresh = (time: string): boolean => now - Date.parse(time) < HOUR_MS;
  return {
    sends: (state?.sends ?? []).filter(fresh),
    urgent: (state?.urgent ?? []).filter(fresh),
    extensions: (state?.extensions ?? []).filter((extension) => fresh(extension.at)),
  };
}

export interface BudgetStatus {
  used: number;
  limit: number;
  remaining: number;
  urgentOver: number;
  resetsInMinutes: number;
}

export function budgetStatus(
  state: Partial<BudgetState> | null | undefined,
  now: number = Date.now(),
): BudgetStatus {
  const pruned = pruneBudget(state, now);
  const limit = HOURLY_BUDGET + EXTENSION * pruned.extensions.length;
  const used = pruned.sends.length;
  const first = pruned.sends[0];
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    urgentOver: pruned.urgent.length,
    resetsInMinutes: first ? Math.ceil((HOUR_MS - (now - Date.parse(first))) / 60000) : 0,
  };
}

export function recordSend(
  state: Partial<BudgetState> | null | undefined,
  now: number = Date.now(),
  { urgent = false }: { urgent?: boolean } = {},
): BudgetState {
  const pruned = pruneBudget(state, now);
  const iso = new Date(now).toISOString();
  pruned.sends.push(iso);
  if (urgent && budgetStatus(state, now).remaining <= 0) pruned.urgent.push(iso);
  return pruned;
}

/** Leon's approval adds EXTENSION sends for the next hour. It only applies once the budget is used up. */
export function extendBudget(
  state: Partial<BudgetState> | null | undefined,
  quote: unknown,
  now: number = Date.now(),
): { state: BudgetState; extended: boolean } {
  if (typeof quote !== "string" || quote.trim().length < 8)
    throw new Error("leon_approved_more must quote Leon's own words approving more messages");
  const pruned = pruneBudget(state, now);
  if (budgetStatus(pruned, now).remaining > 0) return { state: pruned, extended: false };
  pruned.extensions.push({ at: new Date(now).toISOString(), quote: quote.trim().slice(0, 500) });
  return { state: pruned, extended: true };
}

export function budgetExceededMessage(status: BudgetStatus, botName: string, text: string): string {
  return (
    `Hourly budget reached: ${status.used} of ${status.limit} relayed Grok bot messages in the last hour (frees up in about ${status.resetsInMinutes} min). ` +
    `Grok usage is limited, so Leon wants to be asked before more go out. Ask Leon in Slack (his DM or the task thread) whether to keep going, ` +
    `and quote what you still need to send to ${botName}: "${text.trim().slice(0, 300)}". Do not retry until he answers. ` +
    `If he says yes, call grok_bot_send again with leon_approved_more set to his exact words; that allows ${EXTENSION} more this hour.`
  );
}

/** Linear Bot and Todoist Bot only for what Hermes's own linear and todoist MCP tools can't do. */
export function guardBot(botName: string, needsBotBecause: unknown): string | null {
  if (!BOOKKEEPING_BOTS.includes(botName.toLowerCase())) return null;
  const why = typeof needsBotBecause === "string" ? needsBotBecause.trim() : "";
  if (why.length < MIN_JUSTIFICATION) {
    throw new Error(
      "Linear and Todoist go through your own linear/todoist MCP tools (Leon's rule, 2026-11-07), not this bot. " +
        "Only message it for something those tools can't do, and say what in needs_bot_because.",
    );
  }
  return why;
}
