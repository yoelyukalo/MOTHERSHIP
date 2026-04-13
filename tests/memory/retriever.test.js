const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-ret-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../../src/database');
const ve = require('../../src/memory/vector-engine');
const retriever = require('../../src/memory/retriever');

const fakeEmb = {
  'thinks in systems': new Float32Array([1, 0, 0]),
  'likes first principles': new Float32Array([0.9, 0.1, 0]),
  'rag is retrieval augmented generation': new Float32Array([0, 1, 0]),
  'RAG: rag is retrieval augmented generation': new Float32Array([0, 1, 0]),
  'how do i build a rag pipeline': new Float32Array([0.1, 0.95, 0])
};
const fakeClient = {
  embeddings: {
    create: async ({ input }) => ({ data: [{ embedding: Array.from(fakeEmb[input] || new Float32Array([0, 0, 0])) }] })
  }
};

test('retriever — returns block with mirror + wiki sections', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });

  ve._setClient(fakeClient);

  await ve.storeMirrorEntry({
    category: 'mental_models', content: 'thinks in systems',
    confidence: 0.9, source_type: 'conversation', source_id: 'x'
  });
  await ve.storeMirrorEntry({
    category: 'mental_models', content: 'likes first principles',
    confidence: 0.85, source_type: 'conversation', source_id: 'y'
  });
  await ve.storeWikiEntry({
    topic: 'RAG',
    summary: 'rag is retrieval augmented generation',
    source_ids: ['z'], tags: ['ai']
  });

  const block = await retriever.buildContextBlock('how do i build a rag pipeline', { mirrorTopK: 2, wikiTopK: 1 });

  assert.ok(block.includes('## Mirror'));
  assert.ok(block.includes('## Wiki'));
  assert.ok(block.includes('thinks in systems') || block.includes('likes first principles'));
  assert.ok(block.includes('RAG'));
});
