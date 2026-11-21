import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  budgetExceededMessage,
  budgetStatus,
  busy,
  compareKeys,
  compose,
  extendBudget,
  guardBot,
  MAX_QUEUE_AGE_MS,
  pruneBudget,
  recordSend,
  takeBatch,
  URGENT_OVER_BUDGET,
  type BudgetStatus,
} from "#policy";
import type { BudgetState, GrokBackend, GrokBot, GrokMessage, QueuedItem, RelayLog } from "#types";

/**
 * The Grok Bot relay (since 2026-11-06). Leon's Grok bots answer only Leon and ignore Hermes in Slack,
 * so Hermes messages them in their own chats, as Leon and with no label. Since v1.2.0 a message to a
 * bot that is still working is queued and goes out merged with the others when it finishes, and an
 * hourly budget sends Hermes to Leon. Only Grok Bot chats are reachable here.
 */

/** Labels used before 2026-11-07, so older Hermes messages still read as Hermes's. */
const OLD_LABELS = [
  "[From Hermes, Leon's Slack agent, relayed through Leon's Beeper. Leon lets Hermes approve and confirm for him, except payments, purchases, transfers and password or security changes.]",
  "[From Hermes, Leon's Slack agent, relayed through Leon's Beeper]",
];
/** Message IDs remembered as Hermes's. */
const KEEP_SENT = 2000;
export const MAX_TEXT = 8000;
/** Stays under Hermes Cloud's 180 s MCP timeout. */
export const MAX_WAIT_SECONDS = 150;
/** After a reply, wait this long for follow-up messages. */
const QUIET_SECONDS = 20;
const FLUSH_EVERY_MS = 10_000;
const POLL_MS = 3000;
/** How much of a chat `busy` and `read` look at. */
const HISTORY = 30;
const QUEUED_NOTE =
  "Queued: it will go out merged with any other queued messages as one message when the bot finishes its current reply. Read replies later with grok_bot_read. Do not resend.";

type Outbox = Record<string, { bot: string; items: QueuedItem[] }>;

export interface GrokRelayOptions {
  /** Holds `hermes-sent.json`, `outbox.json` and `budget.json`; one process at a time. */
  stateDir: string;
  backend: GrokBackend;
  log: RelayLog;
  /** Run the background flusher (default). Tests call `flushOnce` themselves. */
  flush?: boolean;
  /** Only these bot names are reachable, when given. */
  allowedBots?: readonly string[];
  /** Milliseconds between checks while waiting for a reply. */
  pollMs?: number;
}

export interface ShapedMessage {
  from: string;
  text: string;
  timestamp: string;
  sortKey: string;
  type?: string;
}

export interface GrokRelay {
  bots(): Promise<Array<GrokBot & { queued?: number }>>;
  send(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  read(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  flushOnce(now?: () => number): Promise<void>;
  budget(): BudgetStatus;
  stop(): void;
}

function readJSON<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJSON(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const given = (value: unknown): boolean => value !== undefined && value !== null && value !== "";

export function createGrokRelay(options: GrokRelayOptions): GrokRelay {
  const { backend, log } = options;
  const pollMs = options.pollMs ?? POLL_MS;
  const sentFile = join(options.stateDir, "hermes-sent.json");
  const outboxFile = join(options.stateDir, "outbox.json");
  const budgetFile = join(options.stateDir, "budget.json");

  // Chat and message ID of everything Hermes sent, so reads can tell Hermes from Leon.
  let sentLog = readJSON<Array<{ chatID: string; id: string; at: string }>>(sentFile, []);
  const sentIDs = new Set(sentLog.map((entry) => `${entry.chatID} ${entry.id}`));
  const remember = (chatID: string, id: string, at: string): void => {
    if (sentIDs.has(`${chatID} ${id}`)) return;
    sentIDs.add(`${chatID} ${id}`);
    sentLog.push({ chatID, id, at });
    if (sentLog.length > KEEP_SENT) sentLog = sentLog.slice(-KEEP_SENT);
    writeJSON(sentFile, sentLog);
  };

  // Messages waiting for a busy bot, sent merged by the flusher.
  const outbox = readJSON<Outbox>(outboxFile, {});
  const saveOutbox = (): void => writeJSON(outboxFile, outbox);
  let budget: BudgetState = pruneBudget(readJSON<Partial<BudgetState>>(budgetFile, {}));
  const saveBudget = (): void => writeJSON(budgetFile, budget);
  const allowed = options.allowedBots
    ? new Set(options.allowedBots.map((name) => name.toLowerCase()))
    : null;

  async function bots(refresh = false): Promise<Array<GrokBot & { queued?: number }>> {
    const all = await backend.bots(refresh ? { refresh: true } : {});
    return all
      .filter((bot) => !allowed || allowed.has(bot.name.toLowerCase()))
      .map((bot) => {
        const waiting = outbox[bot.chatID]?.items.length ?? 0;
        return { ...bot, ...(waiting ? { queued: waiting } : {}) };
      });
  }

  function match(all: readonly GrokBot[], want: string): GrokBot | null {
    const partial = all.filter((bot) => bot.name.toLowerCase().includes(want));
    return (
      all.find((bot) => bot.name.toLowerCase() === want) ??
      all.find((bot) => bot.name.toLowerCase() === `${want} bot`) ??
      (partial.length === 1 ? (partial[0] ?? null) : null)
    );
  }

  async function resolve(name: unknown): Promise<GrokBot> {
    if (typeof name !== "string" || !name.trim())
      throw new Error('bot is required, e.g. "University Bot"');
    const want = name.trim().toLowerCase();
    let all = await bots();
    let found = match(all, want);
    if (!found) {
      // A bot created or renamed since the list was built.
      all = await bots(true);
      found = match(all, want);
    }
    if (!found)
      throw new Error(
        `No Grok bot called "${name}". Available: ${all.map((bot) => bot.name).join(", ")}`,
      );
    return found;
  }

  async function messages(chatID: string, wanted = HISTORY): Promise<GrokMessage[]> {
    const list = await backend.messages(chatID, wanted);
    return list
      .filter((message) => !message.isDeleted)
      .sort((a, b) => compareKeys(a.sortKey, b.sortKey));
  }

  function shape(message: GrokMessage, botName: string): ShapedMessage {
    const label = message.isSender
      ? OLD_LABELS.find((old) => message.text.startsWith(old))
      : undefined;
    const byHermes =
      message.isSender && (label !== undefined || sentIDs.has(`${message.chatID} ${message.id}`));
    return {
      from: !message.isSender ? botName : byHermes ? "Hermes (as Leon)" : "Leon",
      text: label ? message.text.slice(label.length).trim() : message.text,
      timestamp: message.timestamp,
      sortKey: message.sortKey,
      ...(message.type ? { type: message.type } : {}),
    };
  }

  /** Posts one message, counts it against the budget, and remembers its ID as Hermes's. */
  async function post(
    chatID: string,
    text: string,
    key: string,
    { urgent = false }: { urgent?: boolean } = {},
  ): Promise<string> {
    const sent = await backend.send(chatID, text, key);
    budget = recordSend(budget, Date.now(), { urgent });
    saveBudget();
    remember(chatID, sent.id, new Date().toISOString());
    return sent.id;
  }

  function queued(
    chatID: string,
    now: number = Date.now(),
  ): Array<{ preview: string; ageSeconds: number }> {
    return (outbox[chatID]?.items ?? []).map((item) => ({
      preview: item.text.slice(0, 160),
      ageSeconds: Math.round((now - Date.parse(item.at)) / 1000),
    }));
  }

  async function send(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { text } = args;
    if (typeof text !== "string" || !text.trim()) throw new Error("text is required");
    if (text.length > MAX_TEXT) throw new Error(`text must be under ${MAX_TEXT} characters`);
    const wait = args.wait_seconds === undefined ? 90 : Number(args.wait_seconds);
    if (!Number.isFinite(wait) || wait < 0 || wait > MAX_WAIT_SECONDS)
      throw new Error(`wait_seconds must be 0-${MAX_WAIT_SECONDS}`);
    const isUrgent = args.urgent === true;

    const target = await resolve(args.bot);
    const why = guardBot(target.name, args.needs_bot_because);
    if (why) log({ event: "grok_bot_justified", bot: target.name, reason: why.slice(0, 300) });

    if (given(args.leon_approved_more)) {
      const { state, extended } = extendBudget(budget, args.leon_approved_more);
      budget = state;
      saveBudget();
      if (extended)
        log({
          event: "budget_extended",
          bot: target.name,
          quote: String(args.leon_approved_more).slice(0, 300),
        });
    }
    const status = budgetStatus(budget);
    if (status.remaining <= 0 && !(isUrgent && status.urgentOver < URGENT_OVER_BUDGET)) {
      log({
        event: "budget_refused",
        bot: target.name,
        used: status.used,
        limit: status.limit,
        chars: text.length,
      });
      throw new Error(budgetExceededMessage(status, target.name, text));
    }

    const before = await messages(target.chatID);
    const baseline = before.at(-1)?.sortKey ?? null;
    const pending = outbox[target.chatID]?.items.length ?? 0;
    const state = busy(before);
    if (!isUrgent && (state.busy || pending)) {
      const box = (outbox[target.chatID] ??= { bot: target.name, items: [] });
      box.items.push({ text: text.trim(), at: new Date().toISOString() });
      saveOutbox();
      const reason = pending
        ? `${pending} earlier message(s) are already queued for this bot`
        : state.reason;
      log({
        event: "grok_queued",
        bot: target.name,
        position: box.items.length,
        chars: text.length,
        reason,
      });
      return {
        ok: true,
        queued: true,
        position: box.items.length,
        bot: target.name,
        reason,
        cursor: baseline,
        note: QUEUED_NOTE,
      };
    }

    const messageID = await post(target.chatID, text.trim(), `send-${randomUUID()}`, {
      urgent: isUrgent,
    });
    log({
      event: "grok_send",
      bot: target.name,
      chars: text.length,
      ...(isUrgent ? { urgent: true } : {}),
    });

    // A reply can arrive as one message that the bot keeps editing, so a changed text counts as
    // activity too, and the texts returned are the ones of the last look.
    const seen = new Map<string, string>();
    const newer = (message: GrokMessage): boolean =>
      !message.isSender && (baseline === null || compareKeys(message.sortKey, baseline) > 0);
    let latest: GrokMessage[] = [];
    let lastNew: number | null = null;
    const deadline = Date.now() + wait * 1000;
    while (Date.now() < deadline) {
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
      latest = await messages(target.chatID, 1);
      for (const message of latest) {
        if (!newer(message) || seen.get(message.id) === message.text) continue;
        seen.set(message.id, message.text);
        lastNew = Date.now();
      }
      if (lastNew !== null && Date.now() - lastNew > QUIET_SECONDS * 1000) break;
    }
    const replies = latest
      .filter((message) => seen.has(message.id))
      .map((message) => shape(message, target.name));
    if (replies.length) log({ event: "grok_reply", bot: target.name, messages: replies.length });
    const left = budgetStatus(budget);
    return {
      ok: true,
      bot: target.name,
      sent: { messageID, sentAs: "Leon", label: null },
      replies,
      cursor: replies.at(-1)?.sortKey ?? baseline,
      budget: { used: left.used, limit: left.limit },
      note: replies.length
        ? "The bot may still send more. Call grok_bot_read with this cursor to check later."
        : `No reply within ${wait}s. Grok bots often take minutes; call grok_bot_read with this cursor later. Do not resend.`,
    };
  }

  async function read(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const target = await resolve(args.bot);
    const limit = args.limit === undefined ? 10 : Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 30) throw new Error("limit must be 1-30");
    let list = await messages(target.chatID);
    // Cursors from before 2026-11-20, when the relay read Beeper Desktop, were plain numbers.
    const stale = given(args.after) && /^\d+$/.test(String(args.after));
    const after = given(args.after) && !stale ? String(args.after) : null;
    if (after !== null) list = list.filter((message) => compareKeys(message.sortKey, after) > 0);
    const shown = list.slice(-limit).map((message) => shape(message, target.name));
    const waiting = queued(target.chatID);
    return {
      ok: true,
      bot: target.name,
      messages: shown,
      cursor: shown.at(-1)?.sortKey ?? after,
      ...(stale
        ? {
            cursorNote:
              "That cursor is from before the relay moved off Beeper Desktop and can't be used any more; these are the latest messages instead.",
          }
        : {}),
      ...(waiting.length
        ? {
            queued: waiting,
            queuedNote: "Not sent yet: these go out merged as one message when the bot finishes.",
          }
        : {}),
    };
  }

  // Background flusher: when a bot with queued messages goes idle, or the queue is 20 minutes old,
  // send them as one.
  let flushing = false;
  async function flushOnce(now: () => number = () => Date.now()): Promise<void> {
    if (flushing) return;
    flushing = true;
    try {
      for (const [chatID, box] of Object.entries(outbox)) {
        const first = box.items[0];
        if (!first) {
          delete outbox[chatID];
          saveOutbox();
          continue;
        }
        try {
          const list = await messages(chatID);
          const state = busy(list, now());
          if (state.busy && now() - Date.parse(first.at) < MAX_QUEUE_AGE_MS) continue;
          const batch = takeBatch(box.items, MAX_TEXT);
          const text = compose(batch);
          // The same batch always has the same key, so a flush retried after a lost answer can't
          // post it twice.
          const key = `flush-${createHash("sha256")
            .update([chatID, ...batch.map((item) => item.at)].join("\n"))
            .digest("hex")
            .slice(0, 40)}`;
          await post(chatID, text, key);
          box.items = box.items.slice(batch.length); // items added meanwhile stay queued
          if (!box.items.length) delete outbox[chatID];
          saveOutbox();
          log({
            event: "grok_flush",
            bot: box.bot,
            count: batch.length,
            chars: text.length,
            left: box.items.length,
            why: state.busy ? "queue older than 20 min" : state.reason,
          });
        } catch (error) {
          log({
            event: "grok_flush_error",
            bot: box.bot,
            message: String(error instanceof Error ? error.message : error).slice(0, 300),
          });
        }
      }
    } finally {
      flushing = false;
    }
  }
  const timer =
    options.flush === false
      ? null
      : setInterval(() => {
          if (Object.keys(outbox).length) void flushOnce();
        }, FLUSH_EVERY_MS);
  timer?.unref();

  return {
    bots: () => bots(),
    send,
    read,
    flushOnce,
    budget: () => budgetStatus(budget),
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
}
