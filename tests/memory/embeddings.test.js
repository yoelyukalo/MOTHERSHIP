const test = require('node:test');
const assert = require('node:assert');
const emb = require('../../src/memory/embeddings');

test('serialize/deserialize round-trip preserves values', () => {
  const v = new Float32Array([0.1, -0.2, 0.3, 0.4, 0.5]);
  const buf = emb.toBuffer(v);
  const out = emb.fromBuffer(buf);
  assert.strictEqual(out.length, 5);
  for (let i = 0; i < 5; i++) {
    assert.ok(Math.abs(out[i] - v[i]) < 1e-6);
  }
});

test('cosineSimilarity — identical vectors = 1', () => {
  const a = new Float32Array([1, 2, 3]);
  const b = new Float32Array([1, 2, 3]);
  assert.ok(Math.abs(emb.cosineSimilarity(a, b) - 1) < 1e-6);
});

test('cosineSimilarity — orthogonal = 0', () => {
  const a = new Float32Array([1, 0]);
  const b = new Float32Array([0, 1]);
  assert.ok(Math.abs(emb.cosineSimilarity(a, b)) < 1e-6);
});

test('cosineSimilarity — opposite = -1', () => {
  const a = new Float32Array([1, 0]);
  const b = new Float32Array([-1, 0]);
  assert.ok(Math.abs(emb.cosineSimilarity(a, b) + 1) < 1e-6);
});

test('generateEmbedding uses injected client and returns Float32Array', async () => {
  const fakeClient = {
    embeddings: {
      create: async ({ input }) => ({
        data: [{ embedding: new Array(1536).fill(0.01) }]
      })
    }
  };
  const vec = await emb.generateEmbedding('hello world', { client: fakeClient, model: 'fake' });
  assert.ok(vec instanceof Float32Array);
  assert.strictEqual(vec.length, 1536);
  assert.ok(Math.abs(vec[0] - 0.01) < 1e-6);
});

test('findRelevant — returns top-k by similarity score', () => {
  const query = new Float32Array([1, 0, 0]);
  const candidates = [
    { id: 'a', vec: new Float32Array([1, 0, 0]) },     // 1.0
    { id: 'b', vec: new Float32Array([0.7, 0.7, 0]) }, // ~0.7
    { id: 'c', vec: new Float32Array([0, 1, 0]) },     // 0
    { id: 'd', vec: new Float32Array([-1, 0, 0]) }     // -1
  ];
  const results = emb.findRelevant(query, candidates, 2);
  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].id, 'a');
  assert.strictEqual(results[1].id, 'b');
  assert.ok(results[0].score > results[1].score);
});
