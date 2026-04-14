const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-pv-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');

before(async () => {
  await db.init();
});

after(() => { try { fs.unlinkSync(tmpDb); } catch {} });

test('addPromptVersion writes a row and returns its id', () => {
  const id = db.addPromptVersion({
    name: 'system.conversation',
    version: 1,
    body: 'You are MOTHERSHIP v1.',
    isActive: 1,
    createdBy: 'bootstrap',
    parentVersion: null
  });
  assert.ok(id);
});

test('addPromptVersion requires name', () => {
  assert.throws(() => db.addPromptVersion({ version: 1, body: 'x' }), /name required/);
});

test('addPromptVersion requires body', () => {
  assert.throws(() => db.addPromptVersion({ name: 'x', version: 1 }), /body required/);
});

test('addPromptVersion requires version to be a number', () => {
  assert.throws(() => db.addPromptVersion({ name: 'x', body: 'y' }), /version required/);
  assert.throws(() => db.addPromptVersion({ name: 'x', body: 'y', version: '1' }), /version required/);
});

test('getActivePromptVersion returns the is_active row', () => {
  const row = db.getActivePromptVersion('system.conversation');
  assert.ok(row);
  assert.strictEqual(row.version, 1);
  assert.strictEqual(row.body, 'You are MOTHERSHIP v1.');
});

test('getActivePromptVersion returns null for unknown prompt', () => {
  const row = db.getActivePromptVersion('does.not.exist');
  assert.strictEqual(row, null);
});

test('listPromptVersions returns version history DESC', () => {
  db.addPromptVersion({
    name: 'system.conversation', version: 2,
    body: 'v2 body', isActive: 0, createdBy: 'reflection', parentVersion: 1
  });
  const all = db.listPromptVersions('system.conversation');
  assert.strictEqual(all.length, 2);
  assert.strictEqual(all[0].version, 2); // DESC
  assert.strictEqual(all[1].version, 1);
});

test('setActivePromptVersion flips is_active atomically', () => {
  db.setActivePromptVersion('system.conversation', 2);
  const active = db.getActivePromptVersion('system.conversation');
  assert.strictEqual(active.version, 2);
  const all = db.listPromptVersions('system.conversation');
  const v1 = all.find(r => r.version === 1);
  assert.strictEqual(v1.is_active, 0);
});

test('getMaxPromptVersion returns highest version number', () => {
  const n = db.getMaxPromptVersion('system.conversation');
  assert.strictEqual(n, 2);
});

test('getMaxPromptVersion returns 0 for unknown prompt', () => {
  const n = db.getMaxPromptVersion('nothing');
  assert.strictEqual(n, 0);
});
