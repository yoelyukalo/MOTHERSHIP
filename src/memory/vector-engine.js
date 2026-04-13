/**
 * MOTHERSHIP — Vector engine
 *
 * Bridges the embedding module and the database. Write-time: embed + store.
 * Query-time: embed + cosine search across stored vectors.
 */

const db = require('../database');
const emb = require('./embeddings');

let injectedClient = null;
function _setClient(client) { injectedClient = client; } // test hook

function clientOpts() {
  return injectedClient ? { client: injectedClient } : {};
}

async function storeMirrorEntry(entry) {
  const vec = await emb.generateEmbedding(entry.content, clientOpts());
  const id = db.addMirrorEntry({
    ...entry,
    embedding: emb.toBuffer(vec)
  });
  return id;
}

async function supersedeMirrorEntry(oldId, newEntry) {
  const vec = await emb.generateEmbedding(newEntry.content, clientOpts());
  return db.supersedeMirrorEntry(oldId, {
    ...newEntry,
    embedding: emb.toBuffer(vec)
  });
}

async function storeWikiEntry(entry) {
  const vec = await emb.generateEmbedding(`${entry.topic}: ${entry.summary}`, clientOpts());
  const id = db.addWikiEntry({
    ...entry,
    embedding: emb.toBuffer(vec)
  });
  return id;
}

async function updateWikiEntry(id, updates) {
  let embeddingBuf = null;
  if (updates.summary || updates.topic) {
    const text = `${updates.topic || ''}: ${updates.summary || ''}`.trim();
    const vec = await emb.generateEmbedding(text, clientOpts());
    embeddingBuf = emb.toBuffer(vec);
  }
  db.updateWikiEntry(id, { ...updates, embedding: embeddingBuf });
}

async function searchMirror(query, { topK = 5, category = null } = {}) {
  const qVec = await emb.generateEmbedding(query, clientOpts());
  const rows = db.getMirrorEntries({ category, activeOnly: true, limit: 5000 });
  const candidates = rows
    .filter(r => r.embedding)
    .map(r => ({ ...r, vec: emb.fromBuffer(r.embedding) }));
  return emb.findRelevant(qVec, candidates, topK);
}

async function searchWiki(query, { topK = 5 } = {}) {
  const qVec = await emb.generateEmbedding(query, clientOpts());
  const rows = db.getAllWikiEntries();
  const candidates = rows
    .filter(r => r.embedding)
    .map(r => ({ ...r, vec: emb.fromBuffer(r.embedding) }));
  return emb.findRelevant(qVec, candidates, topK);
}

module.exports = {
  storeMirrorEntry, supersedeMirrorEntry,
  storeWikiEntry, updateWikiEntry,
  searchMirror, searchWiki,
  _setClient
};
