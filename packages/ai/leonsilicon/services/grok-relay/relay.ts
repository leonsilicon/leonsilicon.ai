import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  isTaskBotFor,
  parseTaskBotName,
  slackIdentifier,
  slackThread,
  taskBotName,
} from "#handoff";
import type { Slack22GrokBot } from "#slack22grokbot";
import {
  budgetExceededMessage,
  budgetStatus,
  busy,
  BUSY_WINDOW_MS,
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
/** How far the homeserver's clock may run behind this machine's when telling a reply from the past. */
const CLOCK_SLACK_MS = 60_000;
const POLL_MS = 3000;
/** How much history `read` asks for when it isn't told. */
const HISTORY = 10;
/** How much history `busy` reads while the journal is too young to answer. */
const BUSY_HISTORY = 10;
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
  /** Milliseconds between checks while waiting for a reply, for a backend with no journal. */
  pollMs?: number;
  /** How long after a reply to keep waiting for more of it (default 20 s). */
  quietMs?: number;
  bridge?: Pick<Slack22GrokBot, "validate" | "complete" | "retired">;
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
  complete(args: Record<string, unknown>): Promise<Record<string, unknown>>;
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
  const { backend, log, bridge } = options;
  const { live } = backend;
  const pollMs = options.pollMs ?? POLL_MS;
  const quietMs = options.quietMs ?? QUIET_SECONDS * 1000;
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
      .filter((bot) => !bridge?.retired(bot.chatID))
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

  const ordered = (list: readonly GrokMessage[]): GrokMessage[] =>
    list.filter((message) => !message.isDeleted).sort((a, b) => compareKeys(a.sortKey, b.sortKey));

  /** One page of history: the slow way, for when the journal doesn't reach back far enough. */
  async function messages(chatID: string, wanted = HISTORY): Promise<GrokMessage[]> {
    return ordered(await backend.messages(chatID, wanted));
  }

  /**
   * What `busy` needs of a chat: its last BUSY_WINDOW_MS from the journal once the journal covers
   * that, and a page of history until then.
   */
  async function recent(
    chatID: string,
    now: number = Date.now(),
  ): Promise<{ list: GrokMessage[]; windowed: boolean }> {
    const from = now - BUSY_WINDOW_MS;
    if (live && (await live.coveredSince()) <= from)
      return { list: ordered(await live.since(chatID, from)), windowed: true };
    return { list: await messages(chatID, BUSY_HISTORY), windowed: false };
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
  ): Array<{ preview: string; ageSeconds: number; needsSlackThread?: true }> {
    return (outbox[chatID]?.items ?? []).map((item) => ({
      preview: item.text.slice(0, 160),
      ageSeconds: Math.round((now - Date.parse(item.at)) / 1000),
      ...(!item.thread ? { needsSlackThread: true } : {}),
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
    // Every task carries its Slack thread, and the bot makes a task bot that works there with
    // Hermes; the instructions for that go after Hermes's own text (see handoff.ts).
    const requested = slackThread(args.slack_channel, args.slack_thread_ts);
    const thread = bridge ? await bridge.validate(requested) : requested;

    const asked = await resolve(args.bot);
    const why = guardBot(asked.name, args.needs_bot_because);
    if (why) log({ event: "grok_bot_justified", bot: asked.name, reason: why.slice(0, 300) });
    // The complete Slack route is the identity, including the channel.
    const all = await bots();
    let existing = all.find((bot) => isTaskBotFor(bot.name, thread));
    if (!existing) {
      for (const bot of all) {
        const named = parseTaskBotName(bot.name);
        if (named?.threadTs !== thread.threadTs) continue;
        if (
          !bridge ||
          isTaskBotFor(bot.name, requested) ||
          (named.channel.startsWith("#") &&
            (await bridge.validate(named).catch(() => undefined))?.channel === thread.channel)
        ) {
          existing = bot;
          break;
        }
      }
    }
    if (!existing && parseTaskBotName(asked.name))
      throw new Error("This Grok task bot belongs to a different Slack thread");
    const target = existing ?? asked;
    if (existing && existing.chatID !== asked.chatID)
      log({ event: "grok_task_bot_reused", asked: asked.name, bot: existing.name });
    const item: QueuedItem = {
      text: text.trim(),
      at: new Date().toISOString(),
      thread,
      ...(existing ? { followUp: true } : {}),
    };
    const handoff = {
      slack_identifier: slackIdentifier(thread),
      task_bot: existing?.name ?? taskBotName(thread),
      ...(existing && existing.chatID !== asked.chatID ? { redirected_from: asked.name } : {}),
    };

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

    const { list: before, windowed } = await recent(target.chatID);
    const baseline = before.at(-1)?.sortKey ?? null;
    const pending = outbox[target.chatID]?.items.filter((item) => item.thread).length ?? 0;
    const state = busy(before, Date.now(), { windowed });
    if (!isUrgent && (state.busy || pending)) {
      const box = (outbox[target.chatID] ??= { bot: target.name, items: [] });
      box.items.push(item);
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
        ...handoff,
        note: QUEUED_NOTE,
      };
    }

    // Taken before the send, so nothing that arrives while it is on its way is missed.
    const position = live ? await live.cursor() : 0;
    const sentAt = Date.now();
    const messageID = await post(
      target.chatID,
      compose([item], Boolean(bridge)),
      `send-${randomUUID()}`,
      {
        urgent: isUrgent,
      },
    );
    log({
      event: "grok_send",
      bot: target.name,
      chars: text.length,
      ...(isUrgent ? { urgent: true } : {}),
    });

    // A reply can arrive as one message that the bot keeps editing, so a changed text counts as
    // activity too, and the texts returned are the ones of the last look.
    const seen = new Map<string, GrokMessage>();
    let lastNew: number | null = null;
    const deadline = Date.now() + wait * 1000;
    const left = (): number =>
      Math.min(deadline, lastNew === null ? deadline : lastNew + quietMs) - Date.now();
    if (live) {
      // The journal answers the moment something arrives, so there is nothing to poll.
      let cursor = position;
      for (let waitMs = left(); waitMs > 0; waitMs = left()) {
        const page = await live.changes(target.chatID, cursor, waitMs);
        cursor = page.cursor;
        for (const message of page.messages) {
          // An old message can turn up in the journal too (see its `latest`); it is no reply.
          if (message.isSender || Date.parse(message.timestamp) < sentAt - CLOCK_SLACK_MS) continue;
          if (message.isDeleted) seen.delete(message.id);
          else seen.set(message.id, message);
          lastNew = Date.now();
        }
      }
    } else {
      const newer = (message: GrokMessage): boolean =>
        !message.isSender && (baseline === null || compareKeys(message.sortKey, baseline) > 0);
      while (left() > 0) {
        await sleep(Math.min(pollMs, Math.max(0, left())));
        const latest = await messages(target.chatID, 5);
        for (const message of latest) {
          if (!newer(message) || seen.get(message.id)?.text === message.text) continue;
          seen.set(message.id, message);
          lastNew = Date.now();
        }
      }
    }
    const replies = ordered([...seen.values()]).map((message) => shape(message, target.name));
    if (replies.length) log({ event: "grok_reply", bot: target.name, messages: replies.length });
    const remaining = budgetStatus(budget);
    return {
      ok: true,
      bot: target.name,
      sent: { messageID, sentAs: "Leon", label: null },
      ...handoff,
      replies,
      cursor: replies.at(-1)?.sortKey ?? baseline,
      budget: { used: remaining.used, limit: remaining.limit },
      note: replies.length
        ? "The bot may still send more. Call grok_bot_read with this cursor to check later."
        : `No reply within ${wait}s. Grok bots often take minutes; call grok_bot_read with this cursor later. Do not resend.`,
    };
  }

  async function read(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const target = await resolve(args.bot);
    const limit = args.limit === undefined ? 10 : Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 30) throw new Error("limit must be 1-30");
    // Cursors from before 2026-11-20, when the relay read Beeper Desktop, were plain numbers.
    const stale = given(args.after) && /^\d+$/.test(String(args.after));
    const after = given(args.after) && !stale ? String(args.after) : null;
    // From the journal when it holds what is asked for: everything since the cursor's time, or as
    // many of the latest messages as wanted. Otherwise one page of history.
    let list: GrokMessage[] | null = null;
    if (live) {
      const from = after === null ? Number.NaN : Number.parseInt(after, 10);
      if (Number.isFinite(from) && from >= (await live.coveredSince()))
        list = ordered(await live.since(target.chatID, from));
      else if (after === null) {
        const held = ordered(await live.latest(target.chatID, limit));
        if (held.length >= limit) list = held;
      }
    }
    list ??= await messages(target.chatID, limit);
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
            queuedNote: waiting.some((item) => item.needsSlackThread)
              ? "Items marked needsSlackThread were queued before Slack handoffs. They require a new grok_bot_send call with the correct Slack thread. Other items go out when the bot finishes."
              : "Not sent yet: these go out merged as one message when the bot finishes.",
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
        if (!box.items.length || bridge?.retired(chatID)) {
          delete outbox[chatID];
          saveOutbox();
          continue;
        }
        // Preserve legacy requests for readback, but only deliver requests with a Slack handoff.
        const threaded = box.items.filter((item) => item.thread);
        const first = threaded[0];
        if (!first) continue;
        try {
          const { list, windowed } = await recent(chatID, now());
          const state = busy(list, now(), { windowed });
          if (state.busy && now() - Date.parse(first.at) < MAX_QUEUE_AGE_MS) continue;
          const batch = takeBatch(threaded, MAX_TEXT, Boolean(bridge));
          const text = compose(batch, Boolean(bridge));
          // The same batch always has the same key, so a flush retried after a lost answer can't
          // post it twice.
          const key = `flush-${createHash("sha256")
            .update([chatID, ...batch.map((item) => item.at)].join("\n"))
            .digest("hex")
            .slice(0, 40)}`;
          await post(chatID, text, key);
          const sent = new Set(batch);
          box.items = box.items.filter((item) => !sent.has(item));
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
    async complete(args) {
      if (!bridge) throw new Error("slack22grokbot is unavailable on this Beeper inbox");
      return bridge.complete(slackThread(args.slack_channel, args.slack_thread_ts));
    },
    flushOnce,
    budget: () => budgetStatus(budget),
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
}
