// 2026-11-06: Grok Bot relay for Hermes. Leon's Grok bots answer only Leon, and their Slack turns crash,
// so Hermes reaches them through Beeper Desktop's Grok Bot network instead. A message lands in the bot's
// in-app chat as Leon, and Leon sees the whole exchange in Beeper.
// 2026-11-07: no label any more (Leon's request): Hermes writes as Leon, and the bot can't tell it from him.
// The relay records the ids of the messages it sent (state/hermes-sent.json) so grok_bot_read still can.
// 2026-11-07 (v1.2.0, to save Grok usage): messages to a bot that is still working are queued (state/outbox.json)
// and go out merged as one message when it finishes; an hourly budget (state/budget.json) sends Hermes to Leon;
// Linear Bot and Todoist Bot are refused unless Hermes says why its own linear/todoist tools can't do the job.
// Only chats on Beeper's "Grok Bot" network are reachable here; every other Beeper chat stays out of reach.
import fs from 'node:fs';
import path from 'node:path';
import {
  busy, compose, takeBatch, compareKeys, plain, guardBot, budgetStatus, recordSend, extendBudget, pruneBudget,
  budgetExceededMessage, MAX_QUEUE_AGE_MS, URGENT_OVER_BUDGET
} from './relay-policy.mjs';

export { plain };

const BEEPER = 'http://127.0.0.1:23373';
const GROK_NETWORK = 'Grok Bot';
// Labels used before 2026-11-07, so older Hermes messages still read as Hermes's in grok_bot_read.
const OLD_LABELS = [
  "[From Hermes, Leon's Slack agent, relayed through Leon's Beeper. Leon lets Hermes approve and confirm for him, except payments, purchases, transfers and password or security changes.]",
  "[From Hermes, Leon's Slack agent, relayed through Leon's Beeper]"
];
const KEEP_SENT = 2000; // message ids remembered as Hermes's
const MAX_TEXT = 8000;
const MAX_WAIT_SECONDS = 150; // stay under Hermes Cloud's 180s MCP timeout
const QUIET_SECONDS = 20; // after a reply, wait this long for follow-up messages
const FLUSH_EVERY_MS = 10000;
const QUEUED_NOTE = 'Queued: it will go out merged with any other queued messages as one message when the bot finishes its current reply. Read replies later with grok_bot_read. Do not resend.';

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(value));
  fs.renameSync(file + '.tmp', file);
}

export function createGrokRelay({ root, config, log, flush = true }) {
  const tokenFile = path.join(root, '../beeper.json');
  const sentFile = path.join(root, '../state/hermes-sent.json');
  const outboxFile = path.join(root, '../state/outbox.json');
  const budgetFile = path.join(root, '../state/budget.json');
  // chatID + message id of everything Hermes sent since 2026-11-07, so reads can tell Hermes from Leon.
  let sentLog = readJSON(sentFile, []);
  const sentIDs = new Set(sentLog.map(e => `${e.chatID} ${e.id}`));
  function remember(chatID, id, at) {
    if (sentIDs.has(`${chatID} ${id}`)) return;
    sentIDs.add(`${chatID} ${id}`);
    sentLog.push({ chatID, id, at });
    if (sentLog.length > KEEP_SENT) sentLog = sentLog.slice(-KEEP_SENT);
    writeJSON(sentFile, sentLog);
  }
  // { [chatID]: { bot, items: [{ text, at }] } }: messages waiting for a busy bot, sent merged by the flusher.
  const outbox = readJSON(outboxFile, {});
  const saveOutbox = () => writeJSON(outboxFile, outbox);
  let budget = pruneBudget(readJSON(budgetFile, {}));
  const saveBudget = () => writeJSON(budgetFile, budget);
  const allowed = Array.isArray(config.grokBots) ? new Set(config.grokBots.map(n => n.toLowerCase())) : null;

  function token() {
    try { return JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token; }
    catch { throw new Error('This bridge has no Beeper token. Leon must run adapter/beeper-token.mjs on the MacBook and approve it in Beeper Desktop.'); }
  }

  async function beeper(method, pathname, body) {
    let res;
    try {
      res = await fetch(BEEPER + pathname, {
        method, signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Bearer ${token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (error) {
      if (error.message.includes('Beeper token')) throw error;
      throw new Error(`Beeper Desktop is not reachable on Leon's Mac mini (${error.cause?.code || error.name}). It must be running and signed in.`);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Beeper Desktop returned ${res.status} for ${method} ${pathname.split('?')[0]}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }

  async function bots() {
    const accounts = (await beeper('GET', '/v1/accounts')).filter(a => a.network === GROK_NETWORK);
    if (accounts.length === 0) throw new Error('Beeper has no Grok Bot account connected.');
    const chats = [];
    for (const account of accounts) {
      const q = new URLSearchParams({ accountIDs: account.accountID, limit: '100' });
      const page = await beeper('GET', `/v1/chats?${q}`);
      for (const c of page.items ?? []) {
        if (c.type !== 'single' || c.isArchived) continue;
        if (allowed && !allowed.has(String(c.title).toLowerCase())) continue;
        chats.push({ name: c.title, chatID: c.id, lastActivity: c.lastActivity,
          lastMessage: plain(c.preview?.text ?? '').slice(0, 200),
          ...(outbox[c.id]?.items?.length ? { queued: outbox[c.id].items.length } : {}) });
      }
    }
    return chats;
  }

  async function resolve(name) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('bot is required, e.g. "University Bot"');
    const all = await bots();
    const want = name.trim().toLowerCase();
    const match = all.find(b => b.name.toLowerCase() === want) ??
      all.find(b => b.name.toLowerCase() === `${want} bot`) ??
      (all.filter(b => b.name.toLowerCase().includes(want)).length === 1 ? all.find(b => b.name.toLowerCase().includes(want)) : null);
    if (!match) throw new Error(`No Grok bot called "${name}". Available: ${all.map(b => b.name).join(', ')}`);
    return match;
  }

  async function messages(chatID) {
    const page = await beeper('GET', `/v1/chats/${encodeURIComponent(chatID)}/messages`);
    return (page.items ?? []).filter(m => !m.isDeleted).sort((a, b) => compareKeys(a.sortKey, b.sortKey));
  }

  function shape(m, botName) {
    const text = plain(m.text ?? '');
    const label = m.isSender ? OLD_LABELS.find(l => text.startsWith(l)) : undefined;
    const byHermes = m.isSender && (label || sentIDs.has(`${m.chatID} ${m.id}`));
    const from = !m.isSender ? botName : byHermes ? 'Hermes (as Leon)' : 'Leon';
    return { from, text: label ? text.slice(label.length).trim() : text,
      timestamp: m.timestamp, sortKey: m.sortKey, ...(m.type && m.type !== 'TEXT' ? { type: m.type } : {}) };
  }

  // Post one message, count it against the budget, and remember its id as Hermes's.
  async function post(chatID, text, baseline, { urgent = false } = {}) {
    const sent = await beeper('POST', `/v1/chats/${encodeURIComponent(chatID)}/messages`, { text });
    budget = recordSend(budget, Date.now(), { urgent });
    saveBudget();
    const at = new Date().toISOString();
    let ownID = null;
    const findOwn = list => {
      if (ownID) return;
      // Skip the pending copy: its id changes once Beeper confirms the send.
      const own = list.find(m => m.isSender && (baseline === null || compareKeys(m.sortKey, baseline) > 0) &&
        m.id !== sent.pendingMessageID && !/pending/i.test(String(m.id)));
      if (own) { ownID = own.id; remember(own.chatID ?? chatID, own.id, at); }
    };
    for (let i = 0; i < 8 && !ownID; i++) {
      await new Promise(r => setTimeout(r, 750));
      findOwn(await messages(chatID));
    }
    return { pendingMessageID: sent.pendingMessageID, findOwn, ownID: () => ownID };
  }

  function queued(chatID, now = Date.now()) {
    return (outbox[chatID]?.items ?? []).map(i => ({ preview: i.text.slice(0, 160), ageSeconds: Math.round((now - Date.parse(i.at)) / 1000) }));
  }

  async function send({ bot, text, wait_seconds, urgent, needs_bot_because, leon_approved_more }) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('text is required');
    if (text.length > MAX_TEXT) throw new Error(`text must be under ${MAX_TEXT} characters`);
    const wait = wait_seconds === undefined ? 90 : Number(wait_seconds);
    if (!Number.isFinite(wait) || wait < 0 || wait > MAX_WAIT_SECONDS) throw new Error(`wait_seconds must be 0-${MAX_WAIT_SECONDS}`);
    const isUrgent = urgent === true;

    const target = await resolve(bot);
    const why = guardBot(target.name, needs_bot_because);
    if (why) log({ event: 'grok_bot_justified', bot: target.name, reason: why.slice(0, 300) });

    if (leon_approved_more !== undefined && leon_approved_more !== null && leon_approved_more !== '') {
      const { state, extended } = extendBudget(budget, leon_approved_more);
      budget = state; saveBudget();
      if (extended) log({ event: 'budget_extended', bot: target.name, quote: String(leon_approved_more).slice(0, 300) });
    }
    const status = budgetStatus(budget);
    if (status.remaining <= 0 && !(isUrgent && status.urgentOver < URGENT_OVER_BUDGET)) {
      log({ event: 'budget_refused', bot: target.name, used: status.used, limit: status.limit, preview: text.slice(0, 120) });
      throw new Error(budgetExceededMessage(status, target.name, text));
    }

    const before = await messages(target.chatID);
    const baseline = before.length ? before[before.length - 1].sortKey : null;
    const pending = outbox[target.chatID]?.items?.length ?? 0;
    const state = busy(before);
    if (!isUrgent && (state.busy || pending)) {
      const box = outbox[target.chatID] ??= { bot: target.name, items: [] };
      box.items.push({ text: text.trim(), at: new Date().toISOString() });
      saveOutbox();
      const reason = pending ? `${pending} earlier message(s) are already queued for this bot` : state.reason;
      log({ event: 'grok_queued', bot: target.name, position: box.items.length, chars: text.length, reason, preview: text.slice(0, 200) });
      return { ok: true, queued: true, position: box.items.length, bot: target.name, reason, cursor: baseline, note: QUEUED_NOTE };
    }

    const sent = await post(target.chatID, text.trim(), baseline, { urgent: isUrgent });
    log({ event: 'grok_send', bot: target.name, chars: text.length, ...(isUrgent ? { urgent: true } : {}), preview: text.slice(0, 200) });

    const replies = [];
    const deadline = Date.now() + wait * 1000;
    let lastNew = null;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 3000));
      const latest = await messages(target.chatID);
      sent.findOwn(latest);
      const fresh = latest
        .filter(m => !m.isSender && (baseline === null || compareKeys(m.sortKey, baseline) > 0))
        .filter(m => !replies.some(r => r.sortKey === m.sortKey));
      if (fresh.length) { replies.push(...fresh.map(m => shape(m, target.name))); lastNew = Date.now(); }
      if (lastNew && Date.now() - lastNew > QUIET_SECONDS * 1000) break;
    }
    if (replies.length) log({ event: 'grok_reply', bot: target.name, messages: replies.length });
    const left = budgetStatus(budget);
    return { ok: true, bot: target.name, sent: { pendingMessageID: sent.pendingMessageID, messageID: sent.ownID(), sentAs: 'Leon', label: null },
      replies, cursor: replies.length ? replies[replies.length - 1].sortKey : baseline,
      budget: { used: left.used, limit: left.limit },
      note: replies.length
        ? 'The bot may still send more. Call grok_bot_read with this cursor to check later.'
        : `No reply within ${wait}s. Grok bots often take minutes; call grok_bot_read with this cursor later. Do not resend.` };
  }

  async function read({ bot, after, limit }) {
    const target = await resolve(bot);
    const n = limit === undefined ? 10 : Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 30) throw new Error('limit must be 1-30');
    let list = await messages(target.chatID);
    if (after !== undefined && after !== null && after !== '') list = list.filter(m => compareKeys(m.sortKey, String(after)) > 0);
    const shown = list.slice(-n).map(m => shape(m, target.name));
    const waiting = queued(target.chatID);
    return { ok: true, bot: target.name, messages: shown, cursor: shown.length ? shown[shown.length - 1].sortKey : (after ?? null),
      ...(waiting.length ? { queued: waiting, queuedNote: 'Not sent yet: these go out merged as one message when the bot finishes.' } : {}) };
  }

  // Background flusher: when a bot with queued messages goes idle (or the queue is 20 min old), send them as one.
  let flushing = false;
  async function flushOnce(now = () => Date.now()) {
    if (flushing) return;
    flushing = true;
    try {
      for (const [chatID, box] of Object.entries(outbox)) {
        if (!box?.items?.length) { delete outbox[chatID]; saveOutbox(); continue; }
        try {
          const list = await messages(chatID);
          const state = busy(list, now());
          const oldest = Date.parse(box.items[0].at);
          if (state.busy && now() - oldest < MAX_QUEUE_AGE_MS) continue;
          const batch = takeBatch(box.items, MAX_TEXT);
          const text = compose(batch);
          const baseline = list.length ? list[list.length - 1].sortKey : null;
          await post(chatID, text, baseline);
          box.items = box.items.slice(batch.length); // items appended meanwhile stay queued
          if (!box.items.length) delete outbox[chatID];
          saveOutbox();
          log({ event: 'grok_flush', bot: box.bot, count: batch.length, chars: text.length, left: box.items?.length ?? 0,
            why: state.busy ? 'queue older than 20 min' : state.reason, preview: text.slice(0, 200) });
        } catch (error) {
          log({ event: 'grok_flush_error', bot: box.bot, message: String(error?.message ?? error).slice(0, 300) });
        }
      }
    } catch (error) {
      log({ event: 'grok_flush_error', message: String(error?.message ?? error).slice(0, 300) });
    } finally { flushing = false; }
  }
  if (flush) setInterval(() => { flushOnce().catch(() => {}); }, FLUSH_EVERY_MS).unref();

  return { bots, send, read, flushOnce, budget: () => budgetStatus(budget) };
}
