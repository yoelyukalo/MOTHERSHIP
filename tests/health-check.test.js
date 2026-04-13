const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-hc-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;
// Don't write reports during the test
delete process.env.OBSIDIAN_VAULT_PATH;

const db = require('../src/database');
const ve = require('../src/memory/vector-engine');
const hc = require('../src/health-check');

test('health-check — decays confidence of stale entries', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });
  ve._setClient({
    embeddings: { create: async () => ({ data: [{ embedding: new Array(3).fill(0.1) }] }) }
  });

  await ve.storeMirrorEntry({
    category: 'preferences', content: 'ancient belief',
    confidence: 0.8, source_type: 'migration', source_id: 'x'
  });

  // Get the inserted row id
  const inserted = db.getMirrorEntries({ category: 'preferences', activeOnly: true });
  assert.strictEqual(inserted.length, 1);
  const id = inserted[0].id;

  // Force updated_at to 60 days ago via raw SQL
  const raw = db._raw();
  raw.run(`UPDATE mirror_entries SET updated_at = datetime('now', '-60 days') WHERE id = ?`, [id]);

  hc._setClient({
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: JSON.stringify({
          contradictions: [], merge_candidates: [],
          knowledge_gaps: [], thin_mirror_categories: []
        }) }]
      })
    }
  });

  const r = await hc.runNow();
  assert.ok(r.decayed >= 1);
  // After decay the row's confidence should have dropped from 0.8 to 0.7 (default DECAY_STEP 0.1)
  const after = db.getMirrorEntries({ activeOnly: true }).find(x => x.id === id);
  assert.ok(after);
  assert.ok(after.confidence < 0.8);
});
