// node verify.mjs [--public]: checks auth, the tool list, and read-only Grok access. Sends nothing.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const origin = process.argv.includes('--public') ? config.publicOrigin : `http://127.0.0.1:${config.port}`;
const url = new URL('/mcp', origin);
const unauthenticated = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
assert.equal(unauthenticated.status, 401, 'Missing credentials must be rejected');
const wrongToken = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${'x'.repeat(64)}`, 'Content-Type': 'application/json' }, body: '{}' });
assert.equal(wrongToken.status, 401, 'Incorrect credentials must be rejected');

const client = new Client({ name: 'grok-relay-verifier', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${config.token}` } } }));
try {
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(t => t.name).sort(), ['grok_bot_read', 'grok_bot_send', 'grok_bots']);
  const bots = await client.callTool({ name: 'grok_bots', arguments: {} });
  assert.notEqual(bots.isError, true, `Grok bots must be listable: ${bots.content[0].text}`);
  const list = JSON.parse(bots.content[0].text).bots;
  assert.ok(list.length > 0 && list.every(b => b.chatID.endsWith(':beeper.local')), 'Only Grok Bot chats must be listed');
  const bad = await client.callTool({ name: 'grok_bot_read', arguments: { bot: 'Nonexistent Person' } });
  assert.equal(bad.isError, true, 'Unknown bots must be rejected');
  const read = await client.callTool({ name: 'grok_bot_read', arguments: { bot: list[0].name, limit: 2 } });
  assert.notEqual(read.isError, true, 'Grok chats must be readable');
  console.log(JSON.stringify({ origin, authenticatedMcp: true, unauthenticatedRejected: true,
    tools: tools.tools.map(t => t.name), grokBots: list.map(b => b.name),
    readable: JSON.parse(read.content[0].text).messages.length }));
} finally { await client.close(); }
