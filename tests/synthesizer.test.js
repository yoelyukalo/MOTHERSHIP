const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-syn-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const ve = require('../src/memory/vector-engine');
const syn = require('../src/synthesizer');
const users = require('../src/auth/users');
const authRoles = require('../src/auth/roles');

let testUserId;

test('synthesizer — creates new wiki topic from content', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });

  await authRoles.seedOnce(db);
  testUserId = await users.createUser({ email: 't@x', password: 'p' });

  ve._setClient({
    embeddings: { create: async () => ({ data: [{ embedding: new Array(3).fill(0.5) }] }) }
  });
  syn._setClient({
    messages: {
      create: async () => ({ content: [{ type: 'text', text: JSON.stringify({
        topics: [
          { topic: 'RAG architectures', mode: 'create',
            summary: 'Retrieval-augmented generation blends vector search with LLM generation.',
            tags: ['ai', 'architecture'] }
        ]
      }) }] })
    }
  });

  const result = await syn.synthesizeFromContent({
    content: 'Article about RAG pipelines...',
    sourceId: 'msg-1',
    userId: testUserId
  });

  assert.strictEqual(result.created, 1);
  const rows = db.getWikiEntries({ topic: 'RAG architectures', userId: testUserId });
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0].source_ids, ['msg-1']);

  const actions = db.getActions({ userId: testUserId, kind: 'mothership_synthesis' });
  assert.ok(actions.some(a => a.data.prompt_version === 'synthesis.wiki'));
});

test('synthesizer — merges into existing topic', async () => {
  syn._setClient({
    messages: {
      create: async () => ({ content: [{ type: 'text', text: JSON.stringify({
        topics: [
          { topic: 'RAG architectures', mode: 'merge',
            summary: 'Updated summary with new insight about hybrid search.',
            tags: ['ai', 'architecture', 'hybrid-search'] }
        ]
      }) }] })
    }
  });

  const result = await syn.synthesizeFromContent({
    content: 'Another article with more detail...',
    sourceId: 'msg-2',
    userId: testUserId
  });

  assert.strictEqual(result.merged, 1);
  const row = db.getWikiEntries({ topic: 'RAG architectures', userId: testUserId })[0];
  assert.ok(row.summary.includes('hybrid search'));
  assert.deepStrictEqual(row.source_ids.sort(), ['msg-1', 'msg-2'].sort());
});
