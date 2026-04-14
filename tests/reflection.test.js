const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-reflection-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const users = require('../src/auth/users');
const authRoles = require('../src/auth/roles');
const registry = require('../src/prompts/registry');
const ve = require('../src/memory/vector-engine');
const reflection = require('../src/reflection');
const replay = require('../src/prompts/replay');

let uid;

before(async () => {
  await db.init();
  await authRoles.seedOnce(db);
  uid = await users.createUser({ email: 'rf@x', password: 'p' });
  registry.seedFromHardcoded();
  ve._setClient({
    embeddings: { create: async () => ({ data: [{ embedding: new Array(3).fill(0.5) }] }) }
  });

  // Seed 3 user actions and 2 mothership_synthesis actions in the last 24h
  db.addAction({ kind: 'commitment', subject: 'ship v2 by Friday', sourceType: 'conversation', userId: uid });
  db.addAction({ kind: 'state', subject: 'tired mid-week', sourceType: 'conversation', userId: uid });
  db.addAction({ kind: 'win', subject: 'closed Acme deal', sourceType: 'conversation', userId: uid });

  const msgId = db.addMessage('test content for reflection input', 'telegram', 'uncategorized', {}, uid);
  db.addAction({ kind: 'mothership_synthesis', subject: 'mirror synth', data: { prompt_version: 'synthesis.mirror' }, sourceType: 'hook', sourceId: msgId, userId: uid });
});

after(() => { try { fs.unlinkSync(tmpDb); } catch {} });

test('runNow writes a reflection row and processes LLM output', async () => {
  reflection._setClient({
    messages: { create: async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        briefing_md: '# Today\n\nTest briefing.',
        patterns: [{ description: 'test pattern', evidence_action_ids: [], confidence: 0.8 }],
        self_critique: [],
        mirror_proposals: [
          { category: 'patterns', content: 'reflection-proposed pattern fact', confidence: 0.7 }
        ]
      }) }]
    }) }
  });
  replay._setClient({
    messages: { create: async () => ({ content: [{ type: 'text', text: '{}' }] }) }
  });

  const out = await reflection.runNow({ userId: uid });
  assert.strictEqual(out.status, 'ok');
  assert.ok(out.reflectionId);
  assert.strictEqual(out.mirrorProposalsStored, 1);

  const latest = db.getLatestReflection({ userId: uid });
  assert.ok(latest);
  assert.ok(latest.briefing_md.includes('Test briefing'));

  // Mirror proposal should have been flowed through vector-engine
  const entries = db.getMirrorEntries({ userId: uid });
  assert.ok(entries.some(e => e.source_type === 'reflection' && e.content === 'reflection-proposed pattern fact'));
});

test('runNow with self_critique creates prompt_proposals + runs replay', async () => {
  reflection._setClient({
    messages: { create: async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        briefing_md: 'brief',
        patterns: [],
        self_critique: [{
          prompt_name: 'synthesis.mirror',
          issue: 'misses thin categories',
          proposed_body: 'IMPROVED PROMPT BODY',
          rationale: 'needs better coverage'
        }],
        mirror_proposals: []
      }) }]
    }) }
  });
  replay._setClient({
    messages: { create: async () => ({ content: [{ type: 'text', text: '{}' }] }) }
  });

  const out = await reflection.runNow({ userId: uid });
  assert.strictEqual(out.promptProposalsCreated, 1);
  const proposals = db.getPendingPromptProposals();
  assert.ok(proposals.some(p => p.prompt_name === 'synthesis.mirror' && p.proposed_body === 'IMPROVED PROMPT BODY'));
});

test('runNow concurrency lock returns already_running on second call', async () => {
  let release;
  const blocker = new Promise(r => { release = r; });
  reflection._setClient({
    messages: { create: async () => {
      await blocker;
      return { content: [{ type: 'text', text: JSON.stringify({
        briefing_md: 'x', patterns: [], self_critique: [], mirror_proposals: []
      }) }] };
    }}
  });
  const first = reflection.runNow({ userId: uid });
  // Give the first call a tick to set the lock
  await new Promise(r => setTimeout(r, 10));
  const second = await reflection.runNow({ userId: uid });
  assert.strictEqual(second.status, 'already_running');
  release();
  await first;
});

test('runNow tolerates Claude failure without throwing', async () => {
  reflection._setClient({
    messages: { create: async () => { throw new Error('api down'); } }
  });
  let out;
  await assert.doesNotReject(async () => {
    out = await reflection.runNow({ userId: uid });
  });
  assert.strictEqual(out.status, 'failed');
  assert.ok(out.error);
});

test('runNow with empty actions window still runs cleanly', async () => {
  // Use a user with no seeded actions
  const freshUid = await users.createUser({ email: 'fresh@x', password: 'p' });
  reflection._setClient({
    messages: { create: async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        briefing_md: 'nothing to report',
        patterns: [], self_critique: [], mirror_proposals: []
      }) }]
    }) }
  });
  const out = await reflection.runNow({ userId: freshUid });
  assert.strictEqual(out.status, 'ok');
  assert.strictEqual(out.actionCount, 0);
});

test('runNow requires userId', async () => {
  await assert.rejects(() => reflection.runNow({}), /userId required/);
});
