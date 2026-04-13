const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-syn-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const ve = require('../src/memory/vector-engine');
const syn = require('../src/synthesizer');

test('synthesizer — creates new wiki topic from content', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });
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
    sourceId: 'msg-1'
  });

  assert.strictEqual(result.created, 1);
  const rows = db.getWikiEntries({ topic: 'RAG architectures' });
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0].source_ids, ['msg-1']);
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
    sourceId: 'msg-2'
  });

  assert.strictEqual(result.merged, 1);
  const row = db.getWikiEntries({ topic: 'RAG architectures' })[0];
  assert.ok(row.summary.includes('hybrid search'));
  assert.deepStrictEqual(row.source_ids.sort(), ['msg-1', 'msg-2'].sort());
});
