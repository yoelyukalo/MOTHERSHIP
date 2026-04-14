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
const registry = require('../src/prompts/registry');

let uid;

before(async () => {
  await db.init();
  await authRoles.seedOnce(db);
  registry.seedFromHardcoded();
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

const extractor = require('../src/extractors/action-extractor');

test('logActionFromTurn auto-logs high-confidence candidates, queues borderline, drops low', async () => {
  extractor._setClient({
    messages: { create: async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        candidates: [
          { kind: 'commitment', subject: 'ship v2 high conf', data: { due_at: '2026-04-20' }, confidence: 0.92 },
          { kind: 'state', subject: 'tired borderline', data: { dimension: 'energy' }, confidence: 0.6 },
          { kind: 'preference', subject: 'weak hint', data: {}, confidence: 0.3 }
        ]
      }) }]
    }) }
  });

  const result = await actionLogger.logActionFromTurn({
    userText: "I'll ship v2 this week and I'm tired today",
    assistantText: 'got it',
    sourceId: 'msg-from-turn-test',
    userId: uid
  });

  assert.strictEqual(result.autoLogged, 1);
  assert.strictEqual(result.queued, 1);
  assert.strictEqual(result.dropped, 1);

  const active = db.getActions({ userId: uid, kind: 'commitment', status: 'active' });
  assert.ok(active.some(a => a.subject === 'ship v2 high conf'));

  const pending = db.getActions({ userId: uid, kind: 'state', status: 'pending_confirm' });
  assert.ok(pending.some(a => a.subject === 'tired borderline'));

  // Weak hint should NOT appear anywhere
  const weak = db.getActions({ userId: uid, kind: 'preference' });
  assert.ok(!weak.some(a => a.subject === 'weak hint'));
});

test('logActionFromTurn tolerates extractor returning empty candidates', async () => {
  extractor._setClient({
    messages: { create: async () => ({
      content: [{ type: 'text', text: JSON.stringify({ candidates: [] }) }]
    }) }
  });
  const result = await actionLogger.logActionFromTurn({
    userText: 'long enough message to pass the guard but no actionable content',
    assistantText: 'ok',
    sourceId: 'empty-test',
    userId: uid
  });
  assert.strictEqual(result.autoLogged, 0);
  assert.strictEqual(result.queued, 0);
  assert.strictEqual(result.dropped, 0);
});

test('logActionFromTurn tolerates extractor failure (never throws)', async () => {
  extractor._setClient({
    messages: { create: async () => { throw new Error('api down'); } }
  });
  let result;
  await assert.doesNotReject(async () => {
    result = await actionLogger.logActionFromTurn({
      userText: 'long enough text to trigger extraction attempt',
      assistantText: 'ok',
      sourceId: 'fail-test',
      userId: uid
    });
  });
  assert.strictEqual(result.autoLogged, 0);
  assert.strictEqual(result.queued, 0);
});

test('logActionFromTurn returns zero counts when userId is missing', async () => {
  const result = await actionLogger.logActionFromTurn({
    userText: 'long text',
    assistantText: 'ok',
    sourceId: 'no-user'
    // userId intentionally missing
  });
  assert.strictEqual(result.autoLogged, 0);
  assert.strictEqual(result.queued, 0);
  assert.strictEqual(result.dropped, 0);
});

test('logActionFromTurn drops candidates missing kind or subject', async () => {
  extractor._setClient({
    messages: { create: async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        candidates: [
          { kind: 'win', subject: 'valid one', confidence: 0.9 },
          { subject: 'missing kind', confidence: 0.9 },
          { kind: 'stumble', confidence: 0.9 },
          { kind: 'commitment', subject: 'another valid', data: {}, confidence: 0.85 }
        ]
      }) }]
    }) }
  });
  const result = await actionLogger.logActionFromTurn({
    userText: 'long enough text to trigger extraction attempt',
    assistantText: 'ok',
    sourceId: 'malformed-test',
    userId: uid
  });
  assert.strictEqual(result.autoLogged, 2); // only the two valid ones
  assert.strictEqual(result.dropped, 2);
});
