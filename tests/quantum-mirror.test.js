const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-qm-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const ve = require('../src/memory/vector-engine');
const qm = require('../src/quantum-mirror');

const fakeEmbClient = {
  embeddings: { create: async () => ({ data: [{ embedding: new Array(3).fill(0.33) }] }) }
};

test('quantum-mirror — synthesizes new entries from a turn', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });
  ve._setClient(fakeEmbClient);

  const fakeAnthropic = {
    messages: {
      create: async () => ({
        content: [{
          type: 'text',
          text: JSON.stringify({
            new_entries: [
              { category: 'preferences', content: 'Prefers Rust for systems work', confidence: 0.85 }
            ],
            supersede: [],
            contradictions: []
          })
        }]
      })
    }
  };
  qm._setClient(fakeAnthropic);

  await qm.synthesizeFromTurn({
    userText: 'I want to build my next systems project in Rust',
    assistantText: 'Rust is a strong pick for that.',
    sourceId: 'turn-1'
  });

  const rows = db.getMirrorEntries({ category: 'preferences' });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].content, 'Prefers Rust for systems work');
});

test('quantum-mirror — handles empty synthesis without error', async () => {
  const fakeAnthropic = {
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: JSON.stringify({
          new_entries: [],
          supersede: [],
          contradictions: []
        }) }]
      })
    }
  };
  qm._setClient(fakeAnthropic);
  // Should not throw on empty synthesis
  const result = await qm.synthesizeFromTurn({ userText: 'hi', assistantText: 'hi', sourceId: 't2' });
  assert.strictEqual(result.created, 0);
  assert.strictEqual(result.superseded, 0);
});
