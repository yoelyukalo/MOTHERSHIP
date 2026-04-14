const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-action-logger-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const users = require('../src/auth/users');
const authRoles = require('../src/auth/roles');
const actionLogger = require('../src/action-logger');

let uid;

before(async () => {
  await db.init();
  await authRoles.seedOnce(db);
  uid = await users.createUser({ email: 'al@x', password: 'p' });
});

after(() => { try { fs.unlinkSync(tmpDb); } catch {} });

test('logAction writes a row via db.addAction and returns id', () => {
  const id = actionLogger.logAction({
    kind: 'mothership_reply',
    subject: 'test reply',
    data: { prompt_version: 'system.conversation@1' },
    sourceType: 'hook',
    sourceId: 'msg-1',
    userId: uid
  });
  assert.ok(id);
  const rows = db.getActions({ userId: uid, kind: 'mothership_reply' });
  const row = rows.find(r => r.id === id);
  assert.ok(row);
  assert.strictEqual(row.data.prompt_version, 'system.conversation@1');
  assert.strictEqual(row.status, 'active');
});

test('logAction swallows DB errors and returns null', () => {
  // Missing kind — db.addAction would throw 'addAction: kind required'
  let result;
  assert.doesNotThrow(() => {
    result = actionLogger.logAction({
      kind: null,
      subject: 'x',
      sourceType: 'hook',
      userId: uid
    });
  });
  assert.strictEqual(result, null);
});

test('logAction swallows missing userId without throwing', () => {
  let result;
  assert.doesNotThrow(() => {
    result = actionLogger.logAction({
      kind: 'commitment',
      subject: 'x',
      sourceType: 'conversation'
      // userId missing
    });
  });
  assert.strictEqual(result, null);
});

test('confirmPendingAction flips pending_confirm to active', () => {
  const id = actionLogger.logAction({
    kind: 'commitment', subject: 'do x',
    sourceType: 'conversation', status: 'pending_confirm', userId: uid
  });
  actionLogger.confirmPendingAction(id);
  const row = db.getActions({ userId: uid, kind: 'commitment' }).find(r => r.id === id);
  assert.strictEqual(row.status, 'active');
});

test('rejectPendingAction flips pending_confirm to rejected', () => {
  const id = actionLogger.logAction({
    kind: 'state', subject: 'tired',
    sourceType: 'conversation', status: 'pending_confirm', userId: uid
  });
  actionLogger.rejectPendingAction(id);
  const row = db.getActions({ userId: uid, kind: 'state' }).find(r => r.id === id);
  assert.strictEqual(row.status, 'rejected');
});

test('confirmPendingAction swallows errors on bad id', () => {
  assert.doesNotThrow(() => actionLogger.confirmPendingAction('does-not-exist'));
});

test('rejectPendingAction swallows errors on bad id', () => {
  assert.doesNotThrow(() => actionLogger.rejectPendingAction('does-not-exist'));
});

test('resolveAction links commitment to resolving win', () => {
  const c = actionLogger.logAction({
    kind: 'commitment', subject: 'ship feature X',
    sourceType: 'conversation', userId: uid
  });
  const w = actionLogger.logAction({
    kind: 'win', subject: 'shipped feature X',
    sourceType: 'conversation', userId: uid
  });
  actionLogger.resolveAction(c, w);
  const row = db.getActions({ userId: uid, kind: 'commitment' }).find(r => r.id === c);
  assert.strictEqual(row.status, 'resolved');
  assert.ok(row.resolved_at);
  assert.strictEqual(row.parent_action_id, w);
});

test('resolveAction swallows errors on bad ids', () => {
  assert.doesNotThrow(() => actionLogger.resolveAction('nope', 'also-nope'));
});
