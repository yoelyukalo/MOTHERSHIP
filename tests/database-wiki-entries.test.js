const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-wiki-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');

test('wiki_entries — insert, fetch, update', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });

  const id = db.addWikiEntry({
    topic: 'RAG architecture',
    summary: 'Retrieval-augmented generation patterns',
    source_ids: ['msg-1', 'msg-2'],
    tags: ['ai', 'architecture'],
    embedding: Buffer.alloc(1536 * 4)
  });

  const rows = db.getWikiEntries({ topic: 'RAG architecture' });
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0].source_ids, ['msg-1', 'msg-2']);
  assert.deepStrictEqual(rows[0].tags, ['ai', 'architecture']);

  db.updateWikiEntry(id, {
    summary: 'Updated summary',
    source_ids: ['msg-1', 'msg-2', 'msg-3'],
    tags: ['ai', 'architecture', 'retrieval'],
    embedding: Buffer.alloc(1536 * 4)
  });
  const updated = db.getWikiEntries({ topic: 'RAG architecture' })[0];
  assert.strictEqual(updated.summary, 'Updated summary');
  assert.strictEqual(updated.source_ids.length, 3);
});
