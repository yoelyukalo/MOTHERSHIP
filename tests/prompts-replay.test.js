const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-replay-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const users = require('../src/auth/users');
const authRoles = require('../src/auth/roles');
const registry = require('../src/prompts/registry');
const replay = require('../src/prompts/replay');

let uid;

before(async () => {
  await db.init();
  await authRoles.seedOnce(db);
  uid = await users.createUser({ email: 'rp@x', password: 'p' });
  registry.seedFromHardcoded();
});

after(() => { try { fs.unlinkSync(tmpDb); } catch {} });

test('replay.run skips when sample size < 5', async () => {
  // Seed only 2 mothership_synthesis actions with source_ids pointing to real messages
  const msgId1 = db.addMessage('test content 1', 'telegram', 'uncategorized', {}, uid);
  const msgId2 = db.addMessage('test content 2', 'telegram', 'uncategorized', {}, uid);
  db.addAction({
    kind: 'mothership_synthesis', subject: 'x',
    data: { prompt_version: 'synthesis.mirror' },
    sourceType: 'hook', sourceId: msgId1, userId: uid
  });
  db.addAction({
    kind: 'mothership_synthesis', subject: 'x',
    data: { prompt_version: 'synthesis.mirror' },
    sourceType: 'hook', sourceId: msgId2, userId: uid
  });

  const out = await replay.run({
    promptName: 'synthesis.mirror',
    proposedBody: 'new body',
    sampleSize: 20,
    userId: uid
  });
  assert.strictEqual(out.skipped, true);
  assert.strictEqual(out.reason, 'insufficient_history');
});

test('replay.run returns structured diff when enough samples exist', async () => {
  // Seed 6 messages + 6 actions referencing them (total will be 8 with the 2 from prior test)
  for (let i = 0; i < 6; i++) {
    const msgId = db.addMessage(`test user text ${i}`, 'telegram', 'uncategorized', {}, uid);
    db.addAction({
      kind: 'mothership_synthesis',
      subject: 'mirror synthesis',
      data: { prompt_version: 'synthesis.mirror' },
      sourceType: 'hook', sourceId: msgId, userId: uid
    });
  }

  let callCount = 0;
  replay._setClient({
    messages: { create: async () => {
      callCount++;
      return { content: [{ type: 'text', text: JSON.stringify({ new_entries: [], supersede: [] }) }] };
    }}
  });

  const out = await replay.run({
    promptName: 'synthesis.mirror',
    proposedBody: 'new body',
    sampleSize: 6,
    userId: uid
  });
  assert.strictEqual(out.skipped, undefined);
  assert.ok(out.sample_size >= 5);
  assert.ok(typeof out.agreement_rate === 'number');
  // Should have run 2 prompts × sample_size samples
  assert.ok(callCount >= 10);
});

test('replay.run tolerates per-sample failure', async () => {
  let callIdx = 0;
  replay._setClient({
    messages: { create: async () => {
      callIdx++;
      if (callIdx === 3) throw new Error('simulated sample failure');
      return { content: [{ type: 'text', text: JSON.stringify({ new_entries: [] }) }] };
    }}
  });
  const out = await replay.run({
    promptName: 'synthesis.mirror',
    proposedBody: 'new body',
    sampleSize: 6,
    userId: uid
  });
  // Should NOT throw; sample_size reflects surviving samples
  assert.strictEqual(out.skipped, undefined);
  assert.ok(out.sample_size >= 1);
});

test('replay.run returns skipped for unknown promptName', async () => {
  // Unknown prompt name maps to no action kind → zero samples
  const out = await replay.run({
    promptName: 'no.such.prompt',
    proposedBody: 'x',
    sampleSize: 10,
    userId: uid
  });
  assert.strictEqual(out.skipped, true);
});

test('replay.run detects when proposed has fewer new_entries (regression)', async () => {
  let callIdx = 0;
  replay._setClient({
    messages: { create: async () => {
      callIdx++;
      // Alternate: baseline has 2 entries, proposed has 0 (regression on every sample)
      if (callIdx % 2 === 1) {
        return { content: [{ type: 'text', text: JSON.stringify({ new_entries: [{ x: 1 }, { x: 2 }] }) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ new_entries: [] }) }] };
    }}
  });
  const out = await replay.run({
    promptName: 'synthesis.mirror',
    proposedBody: 'proposed body',
    sampleSize: 6,
    userId: uid
  });
  assert.ok(out.regressions && out.regressions.length >= 1);
});
