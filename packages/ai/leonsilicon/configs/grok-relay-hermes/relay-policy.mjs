// 2026-11-07: usage policy for the Grok relay (v1.2.0). Grok Bot bills by agent steps and tokens, and Hermes was
// sending follow-ups to bots still working on its previous message (63 of 134 sends landed <3 min after the last
// one), each starting another full run. These pure helpers decide when a bot is busy, merge queued messages into
// one, keep an hourly budget that sends Hermes to Leon, and steer Linear/Todoist work to Hermes's own MCP tools.

export const HOURLY_BUDGET = 25;
export const EXTENSION = 25; // added for the rolling hour after Leon approves more
export const URGENT_OVER_BUDGET = 5; // urgent stop/correction sends allowed per hour past an exhausted budget
export const HOUR_MS = 60 * 60 * 1000;
export const NO_REPLY_BUSY_MS = 10 * 60 * 1000; // no reply yet: assume still working this long
export const QUIET_MS = 60 * 1000; // bot posted this recently: it may still be sending
export const ACK_QUIET_MS = 5 * 60 * 1000; // only acks so far: give it this long to post the real answer
export const ACK_WINDOW_MS = 20 * 60 * 1000; // ...but only while our last message is this fresh
export const MAX_QUEUE_AGE_MS = 20 * 60 * 1000; // flush a queue this old even if the bot still looks busy
export const MIN_JUSTIFICATION = 20;
export const BOOKKEEPING_BOTS = ['linear bot', 'todoist bot'];

export function compareKeys(a, b) {
  const sa = String(a), sb = String(b);
  if (/^\d+$/.test(sa) && /^\d+$/.test(sb)) { const x = BigInt(sa), y = BigInt(sb); return x < y ? -1 : x > y ? 1 : 0; }
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

// Grok replies arrive as HTML; give Hermes readable text with links kept.
export function plain(html) {
  return String(html)
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gis, (_, href, label) => label.replace(/<[^>]+>/g, '') === href ? href : `${label} (${href})`)
    .replace(/<br\s*\/?>/gi, '\n').replace(/<li[^>]*>/gi, '- ').replace(/<\/(p|li|ul|ol|h\d|pre|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n\s*\n- /g, '\n- ').replace(/\n{3,}/g, '\n\n').trim();
}

const ACK = /^(on it|checking|looking|i['’]ll|i will|i['’]m (checking|looking|pulling|working|on it|going|starting|reading)|i am (checking|looking|pulling|working)|working on|got it|sure|let me|one moment|give me a (moment|sec|second|minute))/i;

export function isAck(text) {
  const t = plain(text).replace(/^[\s"'*_>]+/, '');
  return t.length < 200 && ACK.test(t);
}

const at = m => Date.parse(m.timestamp);

// Stateless, from the chat itself, so it survives restarts. "Out" is anything from Leon's account (Leon or Hermes).
export function busy(messages, now = Date.now()) {
  const list = [...messages].filter(m => !m.isDeleted).sort((a, b) => compareKeys(a.sortKey, b.sortKey));
  let lastOut = -1;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].isSender) { lastOut = i; break; }
  if (lastOut < 0) return { busy: false, reason: 'no message from Leon in this chat yet' };
  const outAge = now - at(list[lastOut]);
  const replies = list.slice(lastOut + 1).filter(m => !m.isSender);
  const secs = ms => `${Math.round(ms / 1000)}s`;
  if (replies.length === 0) {
    return outAge < NO_REPLY_BUSY_MS
      ? { busy: true, reason: `no reply yet to the last message, sent ${secs(outAge)} ago` }
      : { busy: false, reason: `the last message got no reply in ${secs(outAge)}; treating the bot as idle` };
  }
  const quiet = now - at(replies[replies.length - 1]);
  if (quiet < QUIET_MS) return { busy: true, reason: `the bot posted ${secs(quiet)} ago and may still be sending` };
  if (replies.every(m => isAck(m.text ?? '')) && quiet < ACK_QUIET_MS && outAge < ACK_WINDOW_MS) {
    return { busy: true, reason: `the bot has only acknowledged so far (${secs(quiet)} ago) and is probably still working` };
  }
  return { busy: false, reason: `the bot finished replying ${secs(quiet)} ago` };
}

// One item goes out unchanged; several become one numbered message, in Leon's lowercase voice.
export function compose(items) {
  const texts = items.map(i => (typeof i === 'string' ? i : i.text).trim()).filter(Boolean);
  if (texts.length <= 1) return texts[0] ?? '';
  return 'a few more things, in order:\n\n' + texts.map((t, i) => `${i + 1}. ${t}`).join('\n\n');
}

// The longest prefix of the queue whose composed message fits in max characters (at least one item).
export function takeBatch(items, max) {
  let n = 1;
  while (n < items.length && compose(items.slice(0, n + 1)).length <= max) n++;
  return items.slice(0, n);
}

// Budget state: { sends: [iso], urgent: [iso], extensions: [{ at, quote }] }, all pruned to the last hour.
export function pruneBudget(state, now = Date.now()) {
  const fresh = t => now - Date.parse(t) < HOUR_MS;
  return {
    sends: (state?.sends ?? []).filter(fresh),
    urgent: (state?.urgent ?? []).filter(fresh),
    extensions: (state?.extensions ?? []).filter(e => fresh(e.at))
  };
}

export function budgetStatus(state, now = Date.now()) {
  const s = pruneBudget(state, now);
  const limit = HOURLY_BUDGET + EXTENSION * s.extensions.length;
  const used = s.sends.length;
  return { used, limit, remaining: Math.max(0, limit - used), urgentOver: s.urgent.length,
    resetsInMinutes: used ? Math.ceil((HOUR_MS - (now - Date.parse(s.sends[0]))) / 60000) : 0 };
}

export function recordSend(state, now = Date.now(), { urgent = false } = {}) {
  const s = pruneBudget(state, now);
  const iso = new Date(now).toISOString();
  s.sends.push(iso);
  if (urgent && budgetStatus(state, now).remaining <= 0) s.urgent.push(iso);
  return s;
}

// Leon's approval adds EXTENSION sends for the next hour. Only applies once the budget is actually used up.
export function extendBudget(state, quote, now = Date.now()) {
  if (typeof quote !== 'string' || quote.trim().length < 8) throw new Error("leon_approved_more must quote Leon's own words approving more messages");
  const s = pruneBudget(state, now);
  if (budgetStatus(s, now).remaining > 0) return { state: s, extended: false };
  s.extensions.push({ at: new Date(now).toISOString(), quote: quote.trim().slice(0, 500) });
  return { state: s, extended: true };
}

export function budgetExceededMessage(status, botName, text) {
  return `Hourly budget reached: ${status.used} of ${status.limit} relayed Grok bot messages in the last hour (frees up in about ${status.resetsInMinutes} min). ` +
    `Grok usage is limited, so Leon wants to be asked before more go out. Ask Leon in Slack (his DM or the task thread) whether to keep going, ` +
    `and quote what you still need to send to ${botName}: "${String(text).trim().slice(0, 300)}". Do not retry until he answers. ` +
    `If he says yes, call grok_bot_send again with leon_approved_more set to his exact words; that allows ${EXTENSION} more this hour.`;
}

// Linear Bot and Todoist Bot only for what Hermes's own linear/todoist MCP tools can't do.
export function guardBot(botName, needsBotBecause) {
  if (!BOOKKEEPING_BOTS.includes(String(botName).toLowerCase())) return null;
  const why = typeof needsBotBecause === 'string' ? needsBotBecause.trim() : '';
  if (why.length < MIN_JUSTIFICATION) {
    throw new Error("Linear and Todoist go through your own linear/todoist MCP tools (Leon's rule, 2026-11-07), not this bot. " +
      'Only message it for something those tools can\'t do, and say what in needs_bot_because.');
  }
  return why;
}
