const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-hooks-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const ve = require('../src/memory/vector-engine');
const hooks = require('../src/conversation-hooks');
const qm = require('../src/quantum-mirror');
const syn = require('../src/synthesizer');

test('conversation-hooks — preResponse returns context block', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });
  ve._setClient({
    embeddings: { create: async () => ({ data: [{ embedding: new Array(3).fill(0.5) }] }) }
  });

  await ve.storeMirrorEntry({
    category: 'preferences', content: 'likes terse answers',
    confidence: 0.8, source_type: 'conversation', source_id: 'x'
  });

  const block = await hooks.preResponse('hi');
  assert.ok(block.includes('likes terse answers'));
});

test('conversation-hooks — postResponse triggers mirror synthesis', async () => {
  let called = false;
  qm._setClient({
    messages: { create: async () => { called = true; return {
      content: [{ type: 'text', text: JSON.stringify({ new_entries: [], supersede: [], contradictions: [] }) }]
    }; } }
  });
  await hooks.postResponse({ userText: 'hello world this is a substantive message worth synthesizing', assistantText: 'hi back', sourceId: 't1' });
  assert.ok(called);
});

test('conversation-hooks — postIngestion triggers wiki synthesis', async () => {
  let called = false;
  syn._setClient({
    messages: { create: async () => { called = true; return {
      content: [{ type: 'text', text: JSON.stringify({ topics: [] }) }]
    }; } }
  });
  await hooks.postIngestion({ content: 'long article text that is definitely above the minimum char threshold for synthesis', sourceId: 'msg-1' });
  assert.ok(called);
});

test('conversation-hooks — postResponse no-ops on short turns', async () => {
  let called = false;
  qm._setClient({
    messages: { create: async () => { called = true; return {
      content: [{ type: 'text', text: '{}' }]
    }; } }
  });
  await hooks.postResponse({ userText: 'hi', assistantText: 'hi', sourceId: 't2' });
  assert.strictEqual(called, false);
});

test('conversation-hooks — synthesis errors are caught, never thrown', async () => {
  qm._setClient({
    messages: { create: async () => { throw new Error('simulated API failure'); } }
  });
  // Should not throw
  await hooks.postResponse({ userText: 'this is a long enough message to trigger synthesis', assistantText: 'response', sourceId: 't3' });
});
