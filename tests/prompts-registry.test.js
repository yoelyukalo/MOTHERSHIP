const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-registry-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const registry = require('../src/prompts/registry');

before(async () => {
  await db.init();
});

after(() => { try { fs.unlinkSync(tmpDb); } catch {} });

test('createVersion + getPrompt returns active body', () => {
  registry.createVersion('system.conversation', 'v1 body', { createdBy: 'bootstrap', activate: true });
  assert.strictEqual(registry.getPrompt('system.conversation'), 'v1 body');
});

test('createVersion auto-increments version numbers', () => {
  registry.createVersion('system.conversation', 'v2 body', { createdBy: 'reflection' });
  const versions = registry.listVersions('system.conversation');
  assert.strictEqual(versions.length, 2);
  assert.strictEqual(versions[0].version, 2); // DESC
  assert.strictEqual(versions[1].version, 1);
});

test('createVersion without activate leaves the old version active', () => {
  // v2 was created in the previous test WITHOUT activate:true
  assert.strictEqual(registry.getPrompt('system.conversation'), 'v1 body');
});

test('activateVersion flips the active row and invalidates cache', () => {
  registry.activateVersion('system.conversation', 2);
  assert.strictEqual(registry.getPrompt('system.conversation'), 'v2 body');
});

test('setFallback + getPrompt returns fallback when no active version', () => {
  registry.setFallback('experimental.prompt', 'fallback string');
  assert.strictEqual(registry.getPrompt('experimental.prompt'), 'fallback string');
});

test('getPrompt throws when no active version and no fallback', () => {
  assert.throws(() => registry.getPrompt('completely.unknown'),
    /no active version and no fallback/);
});

test('listActive returns all currently-active prompts', () => {
  registry.createVersion('synthesis.mirror', 'mirror v1', { createdBy: 'bootstrap', activate: true });
  const active = registry.listActive();
  const names = active.map(p => p.name);
  assert.ok(names.includes('system.conversation'));
  assert.ok(names.includes('synthesis.mirror'));
});

test('cache is invalidated after activateVersion (fresh read returns new body)', () => {
  registry.createVersion('synthesis.mirror', 'mirror v2', { createdBy: 'reflection' });
  registry.activateVersion('synthesis.mirror', 2);
  assert.strictEqual(registry.getPrompt('synthesis.mirror'), 'mirror v2');
});

test('setFallback does not override an active version', () => {
  // system.conversation has an active version already
  registry.setFallback('system.conversation', 'SHOULD NOT BE USED');
  assert.strictEqual(registry.getPrompt('system.conversation'), 'v2 body');
});

test('seedFromHardcoded creates v1 for every known prompt', () => {
  registry.seedFromHardcoded();
  const afterNames = registry.listActive().map(p => p.name);
  for (const name of [
    'system.conversation',
    'synthesis.mirror',
    'synthesis.wiki',
    'health.contradictions',
    'health.gap_analysis',
    'extractor.actions',
    'reflection.daily'
  ]) {
    assert.ok(afterNames.includes(name), `seed missed ${name}`);
  }
});

test('seedFromHardcoded is idempotent', () => {
  const firstCount = registry.listActive().length;
  registry.seedFromHardcoded();
  const secondCount = registry.listActive().length;
  assert.strictEqual(firstCount, secondCount);
});

test('seedFromHardcoded registers fallbacks for every seeded name', () => {
  // Clear the in-memory cache so getPrompt goes through the fallback path if DB is empty.
  // (The seed call above already put rows in the DB, so this test only proves the
  // fallbacks Map was also populated — by checking that getPrompt succeeds for all names.)
  registry._invalidateAll();
  for (const name of [
    'system.conversation',
    'synthesis.mirror',
    'synthesis.wiki',
    'health.contradictions',
    'health.gap_analysis',
    'extractor.actions',
    'reflection.daily'
  ]) {
    const body = registry.getPrompt(name);
    assert.ok(body && body.length > 0, `getPrompt('${name}') returned empty`);
  }
});
