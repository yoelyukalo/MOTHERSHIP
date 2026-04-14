const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-qm-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const ve = require('../src/memory/vector-engine');
const qm = require('../src/quantum-mirror');
const users = require('../src/auth/users');
const authRoles = require('../src/auth/roles');

const fakeEmbClient = {
  embeddings: { create: async () => ({ data: [{ embedding: new Array(3).fill(0.33) }] }) }
};

let testUserId;

test('quantum-mirror — synthesizes new entries from a turn', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });
  ve._setClient(fakeEmbClient);

  await authRoles.seedOnce(db);
  testUserId = await users.createUser({ email: 'qm@x', password: 'p' });

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
    sourceId: 'turn-1',
    userId: testUserId
  });

  const rows = db.getMirrorEntries({ category: 'preferences', userId: testUserId });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].content, 'Prefers Rust for systems work');

  const actions = db.getActions({ userId: testUserId, kind: 'mothership_synthesis' });
  assert.ok(actions.length >= 1, 'mothership_synthesis action not logged');
  assert.strictEqual(actions[0].data.prompt_version, 'synthesis.mirror');
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
  const result = await qm.synthesizeFromTurn({ userText: 'hi', assistantText: 'hi', sourceId: 't2', userId: testUserId });
  assert.strictEqual(result.created, 0);
  assert.strictEqual(result.superseded, 0);
});

test('quantum-mirror — supersede path replaces an existing entry', async () => {
  // Seed an entry to supersede. Reuses the singleton db state from prior tests.
  const seedId = await ve.storeMirrorEntry({
    category: 'preferences',
    content: 'Likes verbose documentation',
    confidence: 0.7,
    source_type: 'conversation',
    source_id: 'seed',
    userId: testUserId
  });

  qm._setClient({
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: JSON.stringify({
          new_entries: [],
          supersede: [
            { old_id: seedId, new_content: 'Likes terse documentation with examples', new_confidence: 0.9 }
          ],
          contradictions: []
        }) }]
      })
    }
  });

  const result = await qm.synthesizeFromTurn({
    userText: 'actually I prefer terse docs with concrete examples',
    assistantText: 'noted',
    sourceId: 'turn-3',
    userId: testUserId
  });

  assert.strictEqual(result.superseded, 1);

  // The old row must be hidden (superseded_by is set) and a new active row must exist with the new content.
  const active = db.getMirrorEntries({ category: 'preferences', activeOnly: true, userId: testUserId });
  const stillSeeded = active.find(r => r.id === seedId);
  assert.strictEqual(stillSeeded, undefined, 'old entry should no longer be active');

  const newRow = active.find(r => r.content === 'Likes terse documentation with examples');
  assert.ok(newRow, 'new entry should exist in active set');
  assert.ok(Math.abs(newRow.confidence - 0.9) < 1e-6);
});

test('storeFromReflection writes mirror entries via vector-engine with source_type=reflection', async () => {
  // ve already has a mocked client from earlier tests; reuse it
  const qm = require('../src/quantum-mirror');
  const out = await qm.storeFromReflection({
    proposals: [
      { category: 'patterns', content: 'energy dips on Wednesdays', confidence: 0.7 },
      { category: 'goals', content: 'wants to ship phase 5 by May', confidence: 0.8 }
    ],
    userId: testUserId,
    reflectionId: 'refl-test-1'
  });
  assert.strictEqual(out.stored, 2);

  const entries = db.getMirrorEntries({ userId: testUserId });
  const reflectionSourced = entries.filter(e => e.source_type === 'reflection');
  assert.ok(reflectionSourced.some(e => e.content === 'energy dips on Wednesdays'));
  assert.ok(reflectionSourced.some(e => e.content === 'wants to ship phase 5 by May'));
  // source_id must point back to the reflection id
  assert.ok(reflectionSourced.every(e => e.source_id === 'refl-test-1'));
});

test('storeFromReflection requires userId', async () => {
  const qm = require('../src/quantum-mirror');
  await assert.rejects(() => qm.storeFromReflection({
    proposals: [],
    reflectionId: 'x'
  }), /userId required/);
});

test('storeFromReflection handles empty proposals list', async () => {
  const qm = require('../src/quantum-mirror');
  const out = await qm.storeFromReflection({
    proposals: [],
    userId: testUserId,
    reflectionId: 'empty'
  });
  assert.strictEqual(out.stored, 0);
});

test('storeFromReflection continues past individual write failures', async () => {
  // Use an embeddings client that throws on specific input, succeeds otherwise
  ve._setClient({
    embeddings: {
      create: async ({ input }) => {
        if (typeof input === 'string' && input.includes('POISON')) {
          throw new Error('simulated embed failure');
        }
        return { data: [{ embedding: new Array(3).fill(0.5) }] };
      }
    }
  });

  const qm = require('../src/quantum-mirror');
  const out = await qm.storeFromReflection({
    proposals: [
      { category: 'patterns', content: 'POISON entry that should fail', confidence: 0.5 },
      { category: 'goals', content: 'good entry that should succeed', confidence: 0.6 }
    ],
    userId: testUserId,
    reflectionId: 'partial-failure'
  });
  assert.strictEqual(out.stored, 1);

  const entries = db.getMirrorEntries({ userId: testUserId });
  assert.ok(entries.some(e => e.content === 'good entry that should succeed'));
  assert.ok(!entries.some(e => e.content === 'POISON entry that should fail'));
});
