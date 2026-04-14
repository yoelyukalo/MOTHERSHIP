const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-pp-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');

before(async () => {
  await db.init();
});

after(() => { try { fs.unlinkSync(tmpDb); } catch {} });

test('addPromptProposal writes a row with JSON replay results', () => {
  const id = db.addPromptProposal({
    promptName: 'synthesis.mirror',
    baseVersion: 1,
    proposedBody: 'improved prompt body',
    rationale: 'the current version misses thin categories',
    replayResultsJson: { sample_size: 20, agreement_rate: 0.75, regressions: [], improvements: [] }
  });
  assert.ok(id);
  const row = db.getPromptProposal(id);
  assert.strictEqual(row.prompt_name, 'synthesis.mirror');
  assert.strictEqual(row.replay_results_json.agreement_rate, 0.75);
  assert.strictEqual(row.status, 'pending');
});

test('addPromptProposal requires promptName', () => {
  assert.throws(() => db.addPromptProposal({
    baseVersion: 1, proposedBody: 'b', rationale: 'r'
  }), /promptName required/);
});

test('addPromptProposal requires proposedBody', () => {
  assert.throws(() => db.addPromptProposal({
    promptName: 'x', baseVersion: 1, rationale: 'r'
  }), /proposedBody required/);
});

test('addPromptProposal requires rationale', () => {
  assert.throws(() => db.addPromptProposal({
    promptName: 'x', baseVersion: 1, proposedBody: 'b'
  }), /rationale required/);
});

test('addPromptProposal stores replay_error when replay failed', () => {
  const id = db.addPromptProposal({
    promptName: 'system.conversation',
    baseVersion: 1,
    proposedBody: 'x',
    rationale: 'y',
    replayResultsJson: null,
    replayError: 'simulated failure'
  });
  const row = db.getPromptProposal(id);
  assert.strictEqual(row.replay_error, 'simulated failure');
  assert.strictEqual(row.replay_results_json, null);
});

test('getPromptProposal returns null for unknown id', () => {
  const row = db.getPromptProposal('does-not-exist');
  assert.strictEqual(row, null);
});

test('getPendingPromptProposals returns pending rows DESC', () => {
  const rows = db.getPendingPromptProposals();
  assert.ok(rows.length >= 2);
  assert.ok(rows.every(r => r.status === 'pending'));
});

test('updatePromptProposalStatus transitions to approved and sets resolved_at', () => {
  const pending = db.getPendingPromptProposals();
  const target = pending[0];
  db.updatePromptProposalStatus(target.id, 'approved');
  const refreshed = db.getPromptProposal(target.id);
  assert.strictEqual(refreshed.status, 'approved');
  assert.ok(refreshed.resolved_at);
});

test('updatePromptProposalStatus transitions to rejected', () => {
  const id = db.addPromptProposal({
    promptName: 'z', baseVersion: 1, proposedBody: 'b', rationale: 'r'
  });
  db.updatePromptProposalStatus(id, 'rejected');
  const row = db.getPromptProposal(id);
  assert.strictEqual(row.status, 'rejected');
});

test('countPromptProposals filters by prompt_name and status', () => {
  const n = db.countPromptProposals({ promptName: 'synthesis.mirror', status: 'pending' });
  assert.ok(typeof n === 'number');
  const all = db.countPromptProposals({});
  assert.ok(all >= n);
});
