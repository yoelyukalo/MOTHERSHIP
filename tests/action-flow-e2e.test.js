/**
 * MOTHERSHIP Phase 5 — end-to-end integration test
 *
 * Exercises the full capture → reflection → mirror proposal → prompt
 * approval → new-version-active flow as a single narrative. Uses mocked
 * Claude clients at every LLM call site.
 */

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-e2e-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;
process.env.ACTION_EXTRACTION_ENABLED = 'true';

const db = require('../src/database');
const users = require('../src/auth/users');
const authRoles = require('../src/auth/roles');
const registry = require('../src/prompts/registry');
const ve = require('../src/memory/vector-engine');
const hooks = require('../src/conversation-hooks');
const qm = require('../src/quantum-mirror');
const extractor = require('../src/extractors/action-extractor');
const reflection = require('../src/reflection');

let uid;

before(async () => {
  await db.init();
  await authRoles.seedOnce(db);
  uid = await users.createUser({ email: 'e2e@x', password: 'p' });
  registry.seedFromHardcoded();
  ve._setClient({
    embeddings: { create: async () => ({ data: [{ embedding: new Array(3).fill(0.5) }] }) }
  });
});

after(() => { try { fs.unlinkSync(tmpDb); } catch {} });

test('e2e — a conversation turn triggers action extraction and writes commitment row', async () => {
  // Mock quantum-mirror synthesis to return no entries
  qm._setClient({
    messages: { create: async () => ({
      content: [{ type: 'text', text: JSON.stringify({ new_entries: [], supersede: [] }) }]
    }) }
  });

  // Mock the extractor to return a high-confidence commitment
  extractor._setClient({
    messages: { create: async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        candidates: [{
          kind: 'commitment',
          subject: 'ship feature X',
          data: { what: 'ship feature X', due_at: '2026-04-20' },
          confidence: 0.9
        }]
      }) }]
    }) }
  });

  // Seed a source message row so sourceId lookups work for any downstream use
  const sourceId = db.addMessage(
    "I'll ship feature X by next Monday — this is a promise",
    'telegram', 'uncategorized', {}, uid
  );

  // Fire the postResponse hook as if conversation.respond had just returned
  await hooks.postResponse({
    userText: "I'll ship feature X by next Monday — this is a promise",
    assistantText: 'noted; anything blocking?',
    sourceId,
    userId: uid
  });

  // The commitment should now exist in the actions table
  const commitments = db.getActions({ userId: uid, kind: 'commitment' });
  assert.ok(commitments.some(c => c.subject === 'ship feature X'),
    'commitment row not written by extractor path');
});

test('e2e — reflection.runNow consumes actions and proposes a mirror entry', async () => {
  // Mock the reflection LLM to return a briefing + mirror proposal
  reflection._setClient({
    messages: { create: async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        briefing_md: '# Today\n\nOpen: ship feature X by Monday.',
        patterns: [{ description: 'feature commitment', evidence_action_ids: [], confidence: 0.8 }],
        self_critique: [],
        mirror_proposals: [{
          category: 'active_projects',
          content: 'shipping feature X by 2026-04-20',
          confidence: 0.8
        }]
      }) }]
    }) }
  });

  const out = await reflection.runNow({ userId: uid });
  assert.strictEqual(out.status, 'ok');
  assert.strictEqual(out.mirrorProposalsStored, 1);

  const mirrorEntries = db.getMirrorEntries({ userId: uid });
  assert.ok(mirrorEntries.some(m =>
    m.source_type === 'reflection' && m.content.includes('feature X')
  ), 'reflection-sourced mirror entry not written');
});

test('e2e — proposal approval flips the active prompt version', async () => {
  // The reflection from the previous test did not produce a self_critique.
  // Seed a prompt_proposal directly to exercise the approval flow end-to-end.
  db.addPromptProposal({
    promptName: 'system.conversation',
    baseVersion: 1,
    proposedBody: 'NEW E2E SYSTEM PROMPT BODY',
    rationale: 'e2e test proposal',
    replayResultsJson: {
      sample_size: 10,
      agreement_rate: 0.9,
      regressions: [],
      improvements: []
    }
  });

  const pending = db.getPendingPromptProposals();
  const target = pending.find(p => p.proposed_body === 'NEW E2E SYSTEM PROMPT BODY');
  assert.ok(target, 'seeded proposal missing');

  // Approve it directly via the registry (mirrors the route handler logic)
  const newVersion = registry.createVersion(
    'system.conversation',
    target.proposed_body,
    { createdBy: 'e2e-test', parentVersion: target.base_version, activate: true }
  );
  db.updatePromptProposalStatus(target.id, 'approved');

  // Active prompt should now return the new body
  const active = db.getActivePromptVersion('system.conversation');
  assert.strictEqual(active.body, 'NEW E2E SYSTEM PROMPT BODY');
  assert.strictEqual(active.version, newVersion);

  // Registry getPrompt should reflect the new body (cache was invalidated)
  assert.strictEqual(registry.getPrompt('system.conversation'), 'NEW E2E SYSTEM PROMPT BODY');

  // Proposal status flipped
  const refreshed = db.getPromptProposal(target.id);
  assert.strictEqual(refreshed.status, 'approved');
});

test('e2e — rejecting a proposal leaves the registry untouched', async () => {
  const beforeActive = db.getActivePromptVersion('synthesis.mirror');

  db.addPromptProposal({
    promptName: 'synthesis.mirror',
    baseVersion: beforeActive.version,
    proposedBody: 'REJECTED E2E BODY',
    rationale: 'e2e test reject'
  });

  const pending = db.getPendingPromptProposals();
  const target = pending.find(p => p.proposed_body === 'REJECTED E2E BODY');

  db.updatePromptProposalStatus(target.id, 'rejected');

  const afterActive = db.getActivePromptVersion('synthesis.mirror');
  assert.strictEqual(afterActive.version, beforeActive.version);
  assert.notStrictEqual(afterActive.body, 'REJECTED E2E BODY');
});

test('e2e — mothership_* audit rows accumulate across the flow', async () => {
  // Confirm both mothership_reply and mothership_synthesis rows exist from
  // the conversation-hooks call in test 1 (wiki synth doesn't fire without
  // ingestion, but the mirror synth tail call does)
  const synths = db.getActions({ userId: uid, kind: 'mothership_synthesis' });
  assert.ok(synths.length >= 1, 'no mothership_synthesis audit row');
  assert.strictEqual(synths[0].data.prompt_version, 'synthesis.mirror');
});
