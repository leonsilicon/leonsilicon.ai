// node --test grok-relay.test.mjs: the relay against a fake Beeper Desktop (offline; sends nothing real).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGrokRelay } from './grok-relay.mjs';
import { HOURLY_BUDGET } from './relay-policy.mjs';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-relay-test-'));
  const root = path.join(dir, 'adapter');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(dir, 'beeper.json'), JSON.stringify({ token: 'fake' }));
  let key = 1000, id = 1;
  const chats = {
    'c-task': { title: 'Task Bot', messages: [] },
    'c-linear': { title: 'Linear Bot', messages: [] }
  };
  const posted = [];
  const add = (chatID, isSender, text, ago = 0) => chats[chatID].messages.push({
    id: String(id++), chatID, sortKey: String(key++), timestamp: new Date(Date.now() - ago).toISOString(), isSender, text, type: 'TEXT' });
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const json = v => new Response(JSON.stringify(v), { status: 200 });
    if (u.pathname === '/v1/accounts') return json([{ network: 'Grok Bot', accountID: 'a1' }]);
    if (u.pathname === '/v1/chats') return json({ items: Object.entries(chats).map(([cid, c]) => ({ id: cid, title: c.title, type: 'single', preview: { text: '' } })) });
    const m = u.pathname.match(/^\/v1\/chats\/([^/]+)\/messages$/);
    if (m && (opts.method ?? 'GET') === 'GET') return json({ items: [...chats[decodeURIComponent(m[1])].messages].reverse() });
    if (m && opts.method === 'POST') {
      const chatID = decodeURIComponent(m[1]);
      const { text } = JSON.parse(opts.body);
      posted.push({ chatID, text });
      add(chatID, true, text);
      return json({ pendingMessageID: 'pending-1' });
    }
    return new Response('nope', { status: 404 });
  };
  const logs = [];
  const relay = createGrokRelay({ root, config: {}, log: e => logs.push(e), flush: false });
  return { dir, relay, chats, add, posted, logs };
}

test('idle bot: sends directly and counts against the budget', async () => {
  const { relay, posted, add } = setup();
  add('c-task', true, 'earlier', 3600_000); add('c-task', false, 'Earlier full answer, done and verified.', 3500_000);
  const r = await relay.send({ bot: 'Task Bot', text: 'please do X', wait_seconds: 0 });
  assert.equal(r.ok, true); assert.equal(r.queued, undefined);
  assert.equal(posted.length, 1); assert.equal(r.budget.used, 1);
});

test('busy bot: queued, merged into one message on flush once idle', async () => {
  const { relay, posted, add, chats, dir } = setup();
  add('c-task', true, 'first ask', 30_000); // no reply yet: busy
  const a = await relay.send({ bot: 'Task', text: 'also do Y', wait_seconds: 0 });
  const b = await relay.send({ bot: 'Task', text: 'and Z', wait_seconds: 0 });
  assert.equal(a.queued, true); assert.equal(b.position, 2); assert.equal(posted.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state/outbox.json'))) ['c-task'].items.length, 2);
  const read = await relay.read({ bot: 'Task Bot' });
  assert.equal(read.queued.length, 2);
  await relay.flushOnce(); // still busy: nothing goes out
  assert.equal(posted.length, 0);
  // bot answers and goes quiet for over a minute
  chats['c-task'].messages.push({ id: 'r1', chatID: 'c-task', sortKey: '99999', timestamp: new Date(Date.now() - 90_000).toISOString(), isSender: false, text: 'Done with the first ask, here are the full results and the readback.' });
  await relay.flushOnce();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].text, 'a few more things, in order:\n\n1. also do Y\n\n2. and Z');
  assert.equal((await relay.read({ bot: 'Task Bot' })).queued, undefined);
  assert.equal(relay.budget().used, 1);
});

test('urgent goes straight out even when busy', async () => {
  const { relay, posted, add } = setup();
  add('c-task', true, 'first ask', 10_000);
  const r = await relay.send({ bot: 'Task Bot', text: 'stop, wrong account', urgent: true, wait_seconds: 0 });
  assert.equal(r.queued, undefined); assert.equal(posted.length, 1);
});

test('Linear Bot needs a reason; with one it is allowed and logged', async () => {
  const { relay, posted, logs } = setup();
  await assert.rejects(relay.send({ bot: 'Linear Bot', text: 'read back LEON-6', wait_seconds: 0 }), /linear\/todoist MCP tools/);
  assert.equal(posted.length, 0);
  const r = await relay.send({ bot: 'Linear Bot', text: 'create the workflow status', needs_bot_because: 'the linear MCP cannot create workflow states', wait_seconds: 0 });
  assert.equal(r.ok, true);
  assert.ok(logs.some(e => e.event === 'grok_bot_justified'));
});

test('budget: refused at the limit with ask-Leon text; Leon quote extends it', async () => {
  const { relay, dir } = setup();
  const sends = Array.from({ length: HOURLY_BUDGET }, (_, i) => new Date(Date.now() - 60_000 + i).toISOString());
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state/budget.json'), JSON.stringify({ sends }));
  // a new relay instance picks the persisted budget up (restart-safe)
  const relay2 = createGrokRelay({ root: path.join(dir, 'adapter'), config: {}, log: () => {}, flush: false });
  await assert.rejects(relay2.send({ bot: 'Task Bot', text: 'one more', wait_seconds: 0 }), /Ask Leon in Slack/);
  const r = await relay2.send({ bot: 'Task Bot', text: 'one more', wait_seconds: 0, leon_approved_more: 'yes keep going, send it' });
  assert.equal(r.ok, true);
  assert.equal(relay2.budget().limit, HOURLY_BUDGET * 2);
  void relay;
});
