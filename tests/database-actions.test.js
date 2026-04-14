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
    subject: 'ship mirror v2',
    data: { what: 'ship mirror v2', due_at: '2026-04-17' },
    confidence: 0.92,
    sourceType: 'conversation',
    sourceId: 'msg-1',
    userId: uid
  });
  assert.ok(id);
  const rows = db.getActions({ userId: uid });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].kind, 'commitment');
  assert.strictEqual(rows[0].data.due_at, '2026-04-17');
  assert.strictEqual(rows[0].status, 'active');
});

test('addAction requires userId', () => {
  assert.throws(() => db.addAction({ kind: 'win', subject: 'x', sourceType: 'conversation' }),
    /userId required/);
});

test('getActions filters by kind and status', () => {
  db.addAction({ kind: 'win', subject: 'closed deal', sourceType: 'conversation', userId: uid });
  db.addAction({ kind: 'win', subject: 'x', sourceType: 'conversation', userId: uid, status: 'pending_confirm' });
  const active = db.getActions({ userId: uid, kind: 'win', status: 'active' });
  assert.strictEqual(active.length, 1);
  const pending = db.getActions({ userId: uid, kind: 'win', status: 'pending_confirm' });
  assert.strictEqual(pending.length, 1);
});

test('getActionsByWindow returns actions inside window', () => {
  const now = new Date();
  const start = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const end = new Date(now.getTime() + 60 * 1000).toISOString();
  const rows = db.getActionsByWindow({ userId: uid, windowStart: start, windowEnd: end });
  assert.ok(rows.length >= 3);
});

test('getPendingActions returns only pending_confirm rows', () => {
  const rows = db.getPendingActions({ userId: uid });
  assert.ok(rows.every(r => r.status === 'pending_confirm'));
  assert.ok(rows.length >= 1);
});

test('updateActionStatus transitions pending_confirm to active', () => {
  const pending = db.getPendingActions({ userId: uid });
  const target = pending[0];
  db.updateActionStatus(target.id, 'active');
  const refreshed = db.getActions({ userId: uid, kind: target.kind, status: 'active' });
  assert.ok(refreshed.find(r => r.id === target.id));
});

test('resolveAction sets resolved_at and parent_action_id', () => {
  const commitment = db.addAction({
    kind: 'commitment', subject: 'do X', sourceType: 'conversation', userId: uid
  });
  const win = db.addAction({
    kind: 'win', subject: 'did X', sourceType: 'conversation', userId: uid
  });
  db.resolveAction(commitment, win);
  const rows = db.getActions({ userId: uid, kind: 'commitment' });
  const resolved = rows.find(r => r.id === commitment);
  assert.strictEqual(resolved.status, 'resolved');
  assert.ok(resolved.resolved_at);
  assert.strictEqual(resolved.parent_action_id, win);
});
