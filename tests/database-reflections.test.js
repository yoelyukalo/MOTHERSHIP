const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-reflections-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const users = require('../src/auth/users');
const authRoles = require('../src/auth/roles');

let uid;

before(async () => {
  await db.init();
  await authRoles.seedOnce(db);
  uid = await users.createUser({ email: 'r@x', password: 'p' });
});

after(() => { try { fs.unlinkSync(tmpDb); } catch {} });

test('addReflection writes a row with JSON fields', () => {
  const id = db.addReflection({
    userId: uid,
    windowStart: '2026-04-13T07:00:00Z',
    windowEnd: '2026-04-14T07:00:00Z',
    briefingMd: '# Daily briefing\n\n...',
    actionCount: 42,
    patternJson: { patterns: [{ description: 'energy dips midweek' }] },
    selfCritiqueJson: { issues: [] }
  });
  assert.ok(id);

  const latest = db.getLatestReflection({ userId: uid });
  assert.ok(latest);
  assert.strictEqual(latest.id, id);
  assert.strictEqual(latest.action_count, 42);
  assert.strictEqual(latest.pattern_json.patterns[0].description, 'energy dips midweek');
  assert.strictEqual(latest.briefing_md, '# Daily briefing\n\n...');
});

test('addReflection requires userId', () => {
  assert.throws(() => db.addReflection({
    windowStart: 'x', windowEnd: 'y', briefingMd: 'z'
  }), /userId required/);
});

test('addReflection requires windowStart', () => {
  assert.throws(() => db.addReflection({
    userId: uid, windowEnd: 'y', briefingMd: 'z'
  }), /windowStart required/);
});

test('addReflection requires windowEnd', () => {
  assert.throws(() => db.addReflection({
    userId: uid, windowStart: 'x', briefingMd: 'z'
  }), /windowEnd required/);
});

test('addReflection requires briefingMd', () => {
  assert.throws(() => db.addReflection({
    userId: uid, windowStart: 'x', windowEnd: 'y'
  }), /briefingMd required/);
});

test('getLatestReflection returns the most recent row', () => {
  const secondId = db.addReflection({
    userId: uid,
    windowStart: '2026-04-14T07:00:00Z',
    windowEnd: '2026-04-15T07:00:00Z',
    briefingMd: 'second',
    actionCount: 10
  });
  const latest = db.getLatestReflection({ userId: uid });
  assert.strictEqual(latest.id, secondId);
  assert.strictEqual(latest.briefing_md, 'second');
});

test('getLatestReflection returns null when no reflections exist', async () => {
  const otherUid = await users.createUser({ email: 'r2@x', password: 'p' });
  const latest = db.getLatestReflection({ userId: otherUid });
  assert.strictEqual(latest, null);
});

test('markReflectionDelivered updates delivery flags', () => {
  const latest = db.getLatestReflection({ userId: uid });
  db.markReflectionDelivered(latest.id, { telegram: true, obsidianPath: '/tmp/daily.md' });
  const refreshed = db.getLatestReflection({ userId: uid });
  assert.strictEqual(refreshed.delivered_telegram, 1);
  assert.strictEqual(refreshed.delivered_obsidian, '/tmp/daily.md');
});

test('markReflectionDelivered can set only one flag', () => {
  // Fresh row
  const id = db.addReflection({
    userId: uid,
    windowStart: '2026-04-15T07:00:00Z',
    windowEnd: '2026-04-16T07:00:00Z',
    briefingMd: 'partial delivery test'
  });
  db.markReflectionDelivered(id, { telegram: true });
  const rows = db._raw().exec(`SELECT delivered_telegram, delivered_obsidian FROM reflections WHERE id = '${id}'`);
  assert.strictEqual(rows[0].values[0][0], 1);
  assert.strictEqual(rows[0].values[0][1], null);
});
