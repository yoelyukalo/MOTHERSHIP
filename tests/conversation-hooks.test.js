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
const users = require('../src/auth/users');
const authRoles = require('../src/auth/roles');

let testUserId;

test('conversation-hooks — preResponse returns context block', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });
  ve._setClient({
    embeddings: { create: async () => ({ data: [{ embedding: new Array(3).fill(0.5) }] }) }
  });

  await authRoles.seedOnce(db);
  testUserId = await users.createUser({ email: 't@x', password: 'p' });

  await ve.storeMirrorEntry({
    category: 'preferences', content: 'likes terse answers',
    confidence: 0.8, source_type: 'conversation', source_id: 'x',
    userId: testUserId
  });

  const block = await hooks.preResponse('hi', { userId: testUserId });
  assert.ok(block.includes('likes terse answers'));
});

test('conversation-hooks — postResponse triggers mirror synthesis', async () => {
  let called = false;
  qm._setClient({
    messages: { create: async () => { called = true; return {
      content: [{ type: 'text', text: JSON.stringify({ new_entries: [], supersede: [], contradictions: [] }) }]
    }; } }
  });
  await hooks.postResponse({ userText: 'hello world this is a substantive message worth synthesizing', assistantText: 'hi back', sourceId: 't1', userId: testUserId });
  assert.ok(called);
});

test('conversation-hooks — postIngestion triggers wiki synthesis', async () => {
  let called = false;
  syn._setClient({
    messages: { create: async () => { called = true; return {
      content: [{ type: 'text', text: JSON.stringify({ topics: [] }) }]
    }; } }
  });
  await hooks.postIngestion({ content: 'long article text that is definitely above the minimum char threshold for synthesis', sourceId: 'msg-1', userId: testUserId });
  assert.ok(called);
});

test('conversation-hooks — postResponse no-ops on short turns', async () => {
  let called = false;
  qm._setClient({
    messages: { create: async () => { called = true; return {
      content: [{ type: 'text', text: '{}' }]
    }; } }
  });
  await hooks.postResponse({ userText: 'hi', assistantText: 'hi', sourceId: 't2', userId: testUserId });
  assert.strictEqual(called, false);
});

test('conversation-hooks — synthesis errors are caught, never thrown', async () => {
  qm._setClient({
    messages: { create: async () => { throw new Error('simulated API failure'); } }
  });
  // Should not throw
  await hooks.postResponse({ userText: 'this is a long enough message to trigger synthesis', assistantText: 'response', sourceId: 't3', userId: testUserId });
});

test('conversation-hooks — postResponse calls logActionFromTurn and writes action rows', async () => {
  // quantum-mirror mock (no new entries from synthesis)
  qm._setClient({
    messages: { create: async () => ({
      content: [{ type: 'text', text: JSON.stringify({ new_entries: [], supersede: [], contradictions: [] }) }]
    }) }
  });

  // action-extractor mock — returns one high-confidence commitment
  const extractor = require('../src/extractors/action-extractor');
  extractor._setClient({
    messages: { create: async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        candidates: [{ kind: 'commitment', subject: 'hook wiring test commit', data: {}, confidence: 0.9 }]
      }) }]
    }) }
  });

  // Also seed the registry so the extractor can load its prompt template
  const registry = require('../src/prompts/registry');
  registry.seedFromHardcoded();

  await hooks.postResponse({
    userText: "I'll do something meaningful and I really mean it this time",
    assistantText: 'ok',
    sourceId: 'hook-wiring-source',
    userId: testUserId
  });

  const actions = db.getActions({ userId: testUserId, kind: 'commitment' });
  assert.ok(actions.some(a => a.subject === 'hook wiring test commit'),
    'postResponse did not write the expected action row');
});
