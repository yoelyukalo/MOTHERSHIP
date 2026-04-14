const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-actions-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const users = require('../src/auth/users');
const authRoles = require('../src/auth/roles');

let uid;

before(async () => {
  await db.init();
  await authRoles.seedOnce(db);
  uid = await users.createUser({ email: 'a@x', password: 'p' });
});

after(() => { try { fs.unlinkSync(tmpDb); } catch {} });

test('addAction writes a row and returns its id', () => {
  const id = db.addAction({
    kind: 'commitment',
    subject: 'ship mirror v2 — test 1 marker',
    data: { what: 'ship mirror v2', due_at: '2026-04-17' },
    confidence: 0.92,
    sourceType: 'conversation',
    sourceId: 'msg-1',
    userId: uid
  });
  assert.ok(id);
  const rows = db.getActions({ userId: uid, kind: 'commitment' });
  const row = rows.find(r => r.id === id);
  assert.ok(row, 'inserted row not found');
  assert.strictEqual(row.kind, 'commitment');
  assert.strictEqual(row.data.due_at, '2026-04-17');
  assert.strictEqual(row.status, 'active');
});

test('addAction requires userId', () => {
  assert.throws(() => db.addAction({ kind: 'win', subject: 'x', sourceType: 'conversation' }),
    /userId required/);
});

test('getActions filters by kind and status', () => {
  db.addAction({ kind: 'win', subject: 'closed deal — test 3 active', sourceType: 'conversation', userId: uid });
  db.addAction({ kind: 'win', subject: 'pending thing — test 3 pending', sourceType: 'conversation', userId: uid, status: 'pending_confirm' });
  const active = db.getActions({ userId: uid, kind: 'win', status: 'active' });
  assert.ok(active.some(r => r.subject === 'closed deal — test 3 active'));
  const pending = db.getActions({ userId: uid, kind: 'win', status: 'pending_confirm' });
  assert.ok(pending.some(r => r.subject === 'pending thing — test 3 pending'));
});

test('getActionsByWindow returns actions inside window', () => {
  const beforeCount = db.getActions({ userId: uid }).length;
  // Insert 2 fresh rows just for this test
  db.addAction({ kind: 'state', subject: 'window test a', sourceType: 'conversation', userId: uid });
  db.addAction({ kind: 'state', subject: 'window test b', sourceType: 'conversation', userId: uid });

  const now = new Date();
  const start = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const end = new Date(now.getTime() + 60 * 1000).toISOString();
  const rows = db.getActionsByWindow({ userId: uid, windowStart: start, windowEnd: end });
  assert.ok(rows.length >= beforeCount + 2, `expected at least ${beforeCount + 2} rows, got ${rows.length}`);
  assert.ok(rows.some(r => r.subject === 'window test a'));
  assert.ok(rows.some(r => r.subject === 'window test b'));
});

test('getActionsByWindow requires windowStart and windowEnd', () => {
  assert.throws(() => db.getActionsByWindow({ userId: uid }), /windowStart and windowEnd required/);
});

test('getPendingActions returns only pending_confirm rows', () => {
  const rows = db.getPendingActions({ userId: uid });
  assert.ok(rows.every(r => r.status === 'pending_confirm'));
});

test('updateActionStatus transitions pending_confirm to active', () => {
  const id = db.addAction({
    kind: 'preference', subject: 'test 7 pending',
    sourceType: 'conversation', status: 'pending_confirm', userId: uid
  });
  db.updateActionStatus(id, 'active');
  const rows = db.getActions({ userId: uid, kind: 'preference' });
  const refreshed = rows.find(r => r.id === id);
  assert.ok(refreshed);
  assert.strictEqual(refreshed.status, 'active');
});

test('resolveAction sets resolved_at and parent_action_id', () => {
  const commitment = db.addAction({
    kind: 'commitment', subject: 'test 8 commitment', sourceType: 'conversation', userId: uid
  });
  const win = db.addAction({
    kind: 'win', subject: 'test 8 win', sourceType: 'conversation', userId: uid
  });
  db.resolveAction(commitment, win);
  const rows = db.getActions({ userId: uid, kind: 'commitment' });
  const resolved = rows.find(r => r.id === commitment);
  assert.strictEqual(resolved.status, 'resolved');
  assert.ok(resolved.resolved_at);
  assert.strictEqual(resolved.parent_action_id, win);
});

test('getActions supports allUsers for admin access', () => {
  const rows = db.getActions({ allUsers: true });
  assert.ok(rows.length >= 1);
});
