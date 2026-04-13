const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-mig-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const ve = require('../src/memory/vector-engine');
const migrate = require('../src/migrate-legacy-mirror');

test('migrate-legacy-mirror — converts JSON blob into rows', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });
  ve._setClient({
    embeddings: { create: async () => ({ data: [{ embedding: new Array(3).fill(0.1) }] }) }
  });

  db.setConfig('quantum_mirror', JSON.stringify({
    mental_models: [
      { name: 'First Principles', description: 'Break problems down to fundamentals.' }
    ],
    learning_style: {
      primary: 'visual-kinesthetic',
      preferences: [{ mode: 'By building', note: 'Learns by creating prototypes' }],
      avoid: ['Long lectures']
    },
    knowledge_graph: [
      { topic: 'AI / LLMs', level: 'advanced', notes: 'Deep practical knowledge' }
    ],
    resonance_log: []
  }));

  const count = await migrate.runIfNeeded();
  assert.ok(count > 0);

  const models = db.getMirrorEntries({ category: 'mental_models' });
  assert.ok(models.length >= 1);
  assert.ok(models[0].content.includes('First Principles'));
});

test('migrate-legacy-mirror — no-op if already migrated', async () => {
  const count = await migrate.runIfNeeded();
  assert.strictEqual(count, 0);
});
