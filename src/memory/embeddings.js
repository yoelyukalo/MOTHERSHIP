/**
 * MOTHERSHIP — Embedding engine
 *
 * Pure-JS wrappers around embedding generation, serialization for SQLite BLOB
 * storage, and cosine similarity. Provider is OpenAI text-embedding-3-small
 * by default; swappable by passing a `client` into generateEmbedding.
 */

const OpenAI = require('openai');

const MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
const DIMS = parseInt(process.env.EMBEDDING_DIMS || '1536', 10);

let defaultClient = null;
function getDefaultClient() {
  if (defaultClient) return defaultClient;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set — required for embeddings');
  defaultClient = new OpenAI({ apiKey });
  return defaultClient;
}

function toBuffer(float32) {
  if (!(float32 instanceof Float32Array)) {
    throw new TypeError('toBuffer expects Float32Array');
  }
  return Buffer.from(float32.buffer, float32.byteOffset, float32.byteLength);
}

function fromBuffer(buf) {
  if (!buf) return null;
  const view = buf instanceof Buffer ? buf : Buffer.from(buf);
  return new Float32Array(view.buffer, view.byteOffset, view.byteLength / 4);
}

async function generateEmbedding(text, { client, model = MODEL } = {}) {
  if (!text || typeof text !== 'string') {
    throw new TypeError('generateEmbedding requires a non-empty string');
  }
  const c = client || getDefaultClient();
  const res = await c.embeddings.create({ model, input: text.slice(0, 8000) });
  const arr = res.data[0].embedding;
  return new Float32Array(arr);
}

function cosineSimilarity(a, b) {
  if (a.length !== b.length) throw new Error('Vector length mismatch');
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Score candidates against a query vector and return the top-k.
 * @param {Float32Array} query
 * @param {Array<{id: string, vec: Float32Array, [key: string]: any}>} candidates
 * @param {number} k
 * @returns {Array<{id: string, score: number, [key: string]: any}>}
 */
function findRelevant(query, candidates, k = 5) {
  const scored = candidates.map(c => ({
    ...c,
    score: cosineSimilarity(query, c.vec)
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

module.exports = {
  DIMS, MODEL,
  generateEmbedding, toBuffer, fromBuffer,
  cosineSimilarity, findRelevant
};
