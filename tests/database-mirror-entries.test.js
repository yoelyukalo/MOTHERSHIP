const test = require('node:test');
const { before } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

// Use a temp DB file per run so tests don't stomp production data.
const tmpDb = path.join(__dirname, `.tmp-mirror-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const users = require('../src/auth/users');

let testUserId;

before(async () => {
  await db.init();
  testUserId = await users.createUser({ email: 'mirror-test@x', password: 'p' });
});

test('mirror_entries table — insert and fetch', async (t) => {
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });

  const id = db.addMirrorEntry({
    category: 'mental_models',
    content: 'Prefers first-principles reasoning',
    confidence: 0.9,
    source_type: 'conversation',
    source_id: 'abc-123',
    embedding: Buffer.alloc(1536 * 4), // zero-filled float32
    userId: testUserId
  });

  assert.ok(id);
  const rows = db.getMirrorEntries({ category: 'mental_models', userId: testUserId });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].content, 'Prefers first-principles reasoning');
  assert.ok(rows[0].embedding instanceof Uint8Array);
  assert.strictEqual(rows[0].embedding.length, 1536 * 4);
  assert.strictEqual(rows[0].superseded_by, null);
});

test('mirror_entries — supersede returns new id and hides old', async () => {
  const db = require('../src/database');
  const oldId = db.addMirrorEntry({
    category: 'preferences',
    content: 'Likes dark mode',
    confidence: 0.6,
    source_type: 'conversation',
    source_id: 'x',
    embedding: Buffer.alloc(1536 * 4),
    userId: testUserId
  });
  const newId = db.supersedeMirrorEntry(oldId, {
    category: 'preferences',
    content: 'Likes dark mode except for PDFs',
    confidence: 0.8,
    source_type: 'conversation',
    source_id: 'y',
    embedding: Buffer.alloc(1536 * 4)
    // no userId here — supersedeMirrorEntry inherits from old entry
  });
  const active = db.getMirrorEntries({ category: 'preferences', activeOnly: true, userId: testUserId });
  assert.strictEqual(active.length, 1);
  assert.strictEqual(active[0].id, newId);
});
