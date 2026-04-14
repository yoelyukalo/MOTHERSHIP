const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-routes-actions-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');

const db = require('../src/database');
const auth = require('../src/auth');
const users = require('../src/auth/users');
const authSessions = require('../src/auth/sessions');
const actionsRouter = require('../src/routes/actions');
const actionLogger = require('../src/action-logger');

let uid, cookie, server, baseUrl;

before(async () => {
  await db.init();
  await auth.init();
  uid = await users.createUser({ email: 'rt-actions@x', password: 'p' });
  const sess = authSessions.createSession(uid, {});
  cookie = `mothership_sid=${sess.id}`;

  const app = express();
  app.use(express.json());
  app.use('/api', actionsRouter);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  actionLogger.logAction({
    kind: 'commitment', subject: 'seeded commitment for routes test',
    sourceType: 'conversation', userId: uid
  });
  actionLogger.logAction({
    kind: 'state', subject: 'seeded pending state',
    sourceType: 'conversation', status: 'pending_confirm', userId: uid
  });
});

after(() => new Promise(resolve => {
  server.close(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    resolve();
  });
}));

async function request(method, urlPath, body = null) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'Cookie': cookie },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

test('GET /api/actions returns user actions', async () => {
  const res = await request('GET', '/api/actions');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.actions));
  assert.ok(res.body.actions.some(a => a.kind === 'commitment' && a.subject.includes('seeded commitment')));
});

test('GET /api/actions?kind=state filters by kind', async () => {
  const res = await request('GET', '/api/actions?kind=state');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.actions.every(a => a.kind === 'state'));
});

test('GET /api/actions/pending returns only pending_confirm', async () => {
  const res = await request('GET', '/api/actions/pending');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.actions.length >= 1);
  assert.ok(res.body.actions.every(a => a.status === 'pending_confirm'));
});

test('POST /api/actions/:id/confirm transitions pending to active', async () => {
  const pendingRes = await request('GET', '/api/actions/pending');
  const target = pendingRes.body.actions[0];
  const res = await request('POST', `/api/actions/${target.id}/confirm`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, true);

  const active = db.getActions({ userId: uid, kind: 'state', status: 'active' });
  assert.ok(active.some(a => a.id === target.id));
});

test('POST /api/actions/:id/reject transitions pending to rejected', async () => {
  const id = actionLogger.logAction({
    kind: 'preference', subject: 'reject me',
    sourceType: 'conversation', status: 'pending_confirm', userId: uid
  });
  const res = await request('POST', `/api/actions/${id}/reject`);
  assert.strictEqual(res.status, 200);
  const row = db.getActions({ userId: uid, kind: 'preference' }).find(r => r.id === id);
  assert.strictEqual(row.status, 'rejected');
});

test('POST /api/actions/:id/resolve links commitment to resolving action', async () => {
  const c = actionLogger.logAction({
    kind: 'commitment', subject: 'ship thing for resolve test',
    sourceType: 'conversation', userId: uid
  });
  const w = actionLogger.logAction({
    kind: 'win', subject: 'shipped thing',
    sourceType: 'conversation', userId: uid
  });
  const res = await request('POST', `/api/actions/${c}/resolve`, { resolvingActionId: w });
  assert.strictEqual(res.status, 200);
  const row = db.getActions({ userId: uid, kind: 'commitment' }).find(r => r.id === c);
  assert.strictEqual(row.status, 'resolved');
  assert.strictEqual(row.parent_action_id, w);
});

test('POST /api/actions/:id/resolve requires resolvingActionId in body', async () => {
  const c = actionLogger.logAction({
    kind: 'commitment', subject: 'missing body',
    sourceType: 'conversation', userId: uid
  });
  const res = await request('POST', `/api/actions/${c}/resolve`, {});
  assert.strictEqual(res.status, 400);
});

test('GET /api/reflections/latest returns reflection or null', async () => {
  // No reflection seeded yet for this user — first call returns null
  const res1 = await request('GET', '/api/reflections/latest');
  assert.strictEqual(res1.status, 200);
  assert.strictEqual(res1.body.reflection, null);

  // Seed one
  db.addReflection({
    userId: uid,
    windowStart: '2026-04-13T07:00:00Z',
    windowEnd: '2026-04-14T07:00:00Z',
    briefingMd: 'latest test',
    actionCount: 3
  });

  const res2 = await request('GET', '/api/reflections/latest');
  assert.strictEqual(res2.status, 200);
  assert.ok(res2.body.reflection);
  assert.strictEqual(res2.body.reflection.briefing_md, 'latest test');
});

test('unauthenticated request returns 401', async () => {
  const res = await fetch(`${baseUrl}/api/actions`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' }
    // NO cookie
  });
  assert.strictEqual(res.status, 401);
});

test('GET /api/prompt-proposals?status=pending returns pending queue', async () => {
  db.addPromptProposal({
    promptName: 'system.conversation',
    baseVersion: 1,
    proposedBody: 'NEW SYSTEM BODY',
    rationale: 'test rationale for approve',
    replayResultsJson: { sample_size: 10, agreement_rate: 0.8, regressions: [], improvements: [] }
  });
  const res = await request('GET', '/api/prompt-proposals?status=pending');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.proposals));
  assert.ok(res.body.proposals.some(p => p.prompt_name === 'system.conversation'));
});

test('GET /api/prompt-proposals/:id returns a single proposal', async () => {
  const list = (await request('GET', '/api/prompt-proposals?status=pending')).body.proposals;
  const target = list.find(p => p.prompt_name === 'system.conversation');
  const res = await request('GET', `/api/prompt-proposals/${target.id}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.proposal.id, target.id);
});

test('GET /api/prompt-proposals/:id returns 404 for unknown id', async () => {
  const res = await request('GET', '/api/prompt-proposals/does-not-exist');
  assert.strictEqual(res.status, 404);
});

test('POST /api/prompt-proposals/:id/approve creates new version and activates', async () => {
  // Need the registry seeded so there's a base version to fork from
  const registry = require('../src/prompts/registry');
  registry.seedFromHardcoded();

  const list = (await request('GET', '/api/prompt-proposals?status=pending')).body.proposals;
  const target = list.find(p => p.prompt_name === 'system.conversation' && p.proposed_body === 'NEW SYSTEM BODY');
  const res = await request('POST', `/api/prompt-proposals/${target.id}/approve`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, true);
  assert.ok(typeof res.body.newVersion === 'number');

  // Registry should now return the new body
  const active = db.getActivePromptVersion('system.conversation');
  assert.strictEqual(active.body, 'NEW SYSTEM BODY');

  // Proposal status flipped
  const refreshed = db.getPromptProposal(target.id);
  assert.strictEqual(refreshed.status, 'approved');
  assert.ok(refreshed.resolved_at);

  // Audit action row written
  const audit = db.getActions({ userId: uid, kind: 'mothership_prompt_change' });
  assert.ok(audit.some(a => a.data.name === 'system.conversation'));
});

test('POST /api/prompt-proposals/:id/approve returns 409 if already resolved', async () => {
  const list = (await request('GET', '/api/prompt-proposals?status=pending')).body.proposals;
  // Fresh proposal → approve → approve again should 409
  db.addPromptProposal({
    promptName: 'synthesis.mirror',
    baseVersion: 1,
    proposedBody: 'DOUBLE APPROVE TEST',
    rationale: 'test'
  });
  const p = db.getPendingPromptProposals().find(x => x.proposed_body === 'DOUBLE APPROVE TEST');
  const first = await request('POST', `/api/prompt-proposals/${p.id}/approve`);
  assert.strictEqual(first.status, 200);
  const second = await request('POST', `/api/prompt-proposals/${p.id}/approve`);
  assert.strictEqual(second.status, 409);
});

test('POST /api/prompt-proposals/:id/reject leaves registry untouched', async () => {
  const registry = require('../src/prompts/registry');
  const beforeActive = db.getActivePromptVersion('synthesis.mirror');

  db.addPromptProposal({
    promptName: 'synthesis.mirror',
    baseVersion: 1,
    proposedBody: 'SHOULD NOT SHIP — REJECTED',
    rationale: 'test reject'
  });
  const p = db.getPendingPromptProposals().find(x => x.proposed_body === 'SHOULD NOT SHIP — REJECTED');

  const res = await request('POST', `/api/prompt-proposals/${p.id}/reject`);
  assert.strictEqual(res.status, 200);

  // Active version unchanged
  const afterActive = db.getActivePromptVersion('synthesis.mirror');
  assert.strictEqual(afterActive.version, beforeActive.version);
  assert.notStrictEqual(afterActive.body, 'SHOULD NOT SHIP — REJECTED');

  // Proposal status is rejected
  const refreshed = db.getPromptProposal(p.id);
  assert.strictEqual(refreshed.status, 'rejected');

  // Audit action row written
  const audit = db.getActions({ userId: uid, kind: 'mothership_prompt_change_rejected' });
  assert.ok(audit.some(a => a.data.name === 'synthesis.mirror'));
});

test('POST /api/prompt-proposals/:id/approve returns 404 for unknown id', async () => {
  const res = await request('POST', '/api/prompt-proposals/does-not-exist/approve');
  assert.strictEqual(res.status, 404);
});
