// node --test relay-policy.test.mjs (offline; sends nothing)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  busy, isAck, compose, takeBatch, budgetStatus, recordSend, extendBudget, pruneBudget, guardBot,
  budgetExceededMessage, HOURLY_BUDGET, EXTENSION, HOUR_MS
} from './relay-policy.mjs';

const T0 = Date.parse('2026-11-07T19:00:00Z');
const s = n => n * 1000;
let key = 100;
const msg = (isSender, offsetMs, text = 'x') => ({ isSender, timestamp: new Date(T0 + offsetMs).toISOString(), sortKey: String(key++), text });

test('idle when Leon never wrote', () => {
  assert.equal(busy([msg(false, 0, 'hello')], T0 + s(5)).busy, false);
  assert.equal(busy([], T0).busy, false);
});

test('busy while the last message has no reply, idle after 10 min', () => {
  const chat = [msg(false, 0, 'done'), msg(true, s(10), 'do the thing')];
  assert.equal(busy(chat, T0 + s(70)).busy, true);
  assert.equal(busy(chat, T0 + s(10) + 9 * 60000).busy, true);
  assert.equal(busy(chat, T0 + s(10) + 11 * 60000).busy, false);
});

test('busy right after a reply, idle once quiet for 60s', () => {
  const chat = [msg(true, 0, 'do it'), msg(false, s(30), 'Here is the full answer with everything you asked for, finished and verified in Linear.')];
  assert.equal(busy(chat, T0 + s(60)).busy, true);
  assert.equal(busy(chat, T0 + s(95)).busy, false);
});

test('only acks: busy up to 5 min of quiet, then idle', () => {
  const chat = [msg(true, 0, 'check my inbox'), msg(false, s(5), '<p>Checking your inbox now.</p>')];
  assert.equal(isAck(chat[1].text), true);
  assert.equal(busy(chat, T0 + s(5) + s(120)).busy, true);
  assert.equal(busy(chat, T0 + s(5) + s(310)).busy, false);
});

test('ack variants and non-acks', () => {
  for (const t of ['On it.', 'I’ll check that now.', "I'm pulling the issues now.", 'Let me look.', 'Got it, working on it.', '**Checking** now'])
    assert.equal(isAck(t), true, t);
  assert.equal(isAck('Done. LEON-6 is now marked Done and the readback matches.'), false);
  assert.equal(isAck('Checking ' + 'x'.repeat(250)), false); // long text is a real answer
});

test('stale ack: idle once our message is over 20 min old', () => {
  const chat = [msg(true, 0, 'go'), msg(false, 19 * 60000, 'On it')];
  // quiet 2 min (< 5 min) but our message is 21 min old
  assert.equal(busy(chat, T0 + 21 * 60000).busy, false);
});

test('a real reply followed by Leon typing again makes it busy again', () => {
  const chat = [msg(true, 0, 'a'), msg(false, s(20), 'Full answer that is clearly not an acknowledgement at all, with details.'), msg(true, s(300), 'b')];
  assert.equal(busy(chat, T0 + s(330)).busy, true);
});

test('compose: one item unchanged, several numbered in order', () => {
  assert.equal(compose(['just this']), 'just this');
  assert.equal(compose([{ text: ' a ' }, { text: 'b' }]), 'a few more things, in order:\n\n1. a\n\n2. b');
  assert.equal(compose([]), '');
});

test('takeBatch keeps under the size limit but always takes one', () => {
  const items = ['a'.repeat(50), 'b'.repeat(50), 'c'.repeat(50)].map(text => ({ text }));
  assert.equal(takeBatch(items, 1000).length, 3);
  assert.equal(takeBatch(items, 150).length, 2);
  assert.equal(takeBatch(items, 10).length, 1);
});

test('budget: rolling hour, refuses at the limit, frees as sends age out', () => {
  let st = {};
  for (let i = 0; i < HOURLY_BUDGET; i++) st = recordSend(st, T0 + i * 1000);
  assert.equal(budgetStatus(st, T0 + s(30)).remaining, 0);
  assert.match(budgetExceededMessage(budgetStatus(st, T0 + s(30)), 'Task Bot', 'do x'), /Ask Leon in Slack/);
  // first send ages out after an hour
  assert.equal(budgetStatus(st, T0 + HOUR_MS + 500).remaining, 1);
  assert.equal(pruneBudget(st, T0 + 2 * HOUR_MS).sends.length, 0);
});

test('budget extension: only when exhausted, adds EXTENSION for the hour, needs a quote', () => {
  let st = {};
  assert.equal(extendBudget(st, 'yes keep going', T0).extended, false); // not exhausted yet
  for (let i = 0; i < HOURLY_BUDGET; i++) st = recordSend(st, T0 + i);
  assert.throws(() => extendBudget(st, 'ok', T0 + s(1)), /quote Leon/);
  const r = extendBudget(st, 'yes, keep going with the sweep', T0 + s(1));
  assert.equal(r.extended, true);
  assert.equal(budgetStatus(r.state, T0 + s(2)).limit, HOURLY_BUDGET + EXTENSION);
  assert.equal(budgetStatus(r.state, T0 + s(2)).remaining, EXTENSION);
  assert.equal(budgetStatus(r.state, T0 + HOUR_MS + s(5)).limit, HOURLY_BUDGET);
});

test('urgent sends past an exhausted budget are counted separately', () => {
  let st = {};
  for (let i = 0; i < HOURLY_BUDGET; i++) st = recordSend(st, T0 + i);
  st = recordSend(st, T0 + s(1), { urgent: true });
  assert.equal(budgetStatus(st, T0 + s(2)).urgentOver, 1);
  assert.equal(recordSend({}, T0, { urgent: true }).urgent.length, 0); // within budget: not "over"
});

test('guard: Linear Bot and Todoist Bot need a reason, other bots do not', () => {
  assert.throws(() => guardBot('Linear Bot'), /linear\/todoist MCP tools/);
  assert.throws(() => guardBot('todoist bot', 'too short'), /needs_bot_because/);
  assert.equal(guardBot('Linear Bot', 'the linear MCP has no tool for workflow state creation'), 'the linear MCP has no tool for workflow state creation');
  assert.equal(guardBot('Instagram Bot'), null);
  assert.equal(guardBot('Google Bot', undefined), null);
});
