const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-ve-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../../src/database');
const ve = require('../../src/memory/vector-engine');

// Fake embedder: maps a few keywords to deterministic 4-dim vectors for
// easy top-k assertions.
const fakeEmbeddings = {
  'rust is fast': new Float32Array([1, 0, 0, 0]),
  'go is pragmatic': new Float32Array([0, 1, 0, 0]),
  'python is flexible': new Float32Array([0, 0, 1, 0]),
  'query: systems languages': new Float32Array([0.9, 0.4, 0, 0]),
  'Rust: rust is fast': new Float32Array([1, 0, 0, 0]),
  'Go: go is pragmatic': new Float32Array([0, 1, 0, 0])
};
const fakeClient = {
  embeddings: {
    create: async ({ input }) => {
      const vec = fakeEmbeddings[input];
      if (!vec) throw new Error(`no fake for: ${input}`);
      return { data: [{ embedding: Array.from(vec) }] };
    }
  }
};

test('vector-engine — store & retrieve mirror entries by similarity', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });

  ve._setClient(fakeClient);

  await ve.storeMirrorEntry({
    category: 'preferences',
    content: 'rust is fast',
    confidence: 0.9,
    source_type: 'conversation',
    source_id: 'm1'
  });
  await ve.storeMirrorEntry({
    category: 'preferences',
    content: 'go is pragmatic',
    confidence: 0.8,
    source_type: 'conversation',
    source_id: 'm2'
  });
  await ve.storeMirrorEntry({
    category: 'preferences',
    content: 'python is flexible',
    confidence: 0.7,
    source_type: 'conversation',
    source_id: 'm3'
  });

  const results = await ve.searchMirror('query: systems languages', { topK: 2 });
  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].content, 'rust is fast');
  assert.strictEqual(results[1].content, 'go is pragmatic');
  assert.ok(results[0].score > results[1].score);
});

test('vector-engine — store & retrieve wiki entries by similarity', async () => {
  await ve.storeWikiEntry({
    topic: 'Rust',
    summary: 'rust is fast',
    source_ids: ['msg-a'],
    tags: ['language']
  });
  await ve.storeWikiEntry({
    topic: 'Go',
    summary: 'go is pragmatic',
    source_ids: ['msg-b'],
    tags: ['language']
  });

  const results = await ve.searchWiki('query: systems languages', { topK: 1 });
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].topic, 'Rust');
});
