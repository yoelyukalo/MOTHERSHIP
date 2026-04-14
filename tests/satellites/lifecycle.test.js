const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-sat-life-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');
process.env.MOTHERSHIP_SATELLITES_DIR = path.join(tmpRoot, 'satellites');
process.env.MOTHERSHIP_KINDS_DIR = path.join(__dirname, '..', 'fixtures', 'satellite-kinds');
fs.mkdirSync(process.env.MOTHERSHIP_SATELLITES_DIR, { recursive: true });

const db = require('../../src/database');
const registry = require('../../src/satellites/registry');
const loader = require('../../src/satellites/loader');
const { VisibilityViolation } = require('../../src/satellites/sovereignty');

before(async () => { await db.init(); });
after(async () => {
  await loader.shutdown();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('lifecycle — archive unloads the satellite and sets status', async () => {
  await registry.createInstance({ slug: 'lc-1', name: 'LC One', kind: 'test-kind' });
  await loader.register('lc-1');
  assert.ok(loader.get('lc-1'));

  await registry.archive('lc-1');
  assert.strictEqual(registry.getBySlug('lc-1').status, 'archived');
  assert.strictEqual(loader.get('lc-1'), undefined);
});

test('lifecycle — unarchive reloads the satellite', async () => {
  await registry.unarchive('lc-1');
  assert.strictEqual(registry.getBySlug('lc-1').status, 'active');
  assert.ok(loader.get('lc-1'));
});

test('lifecycle — transfer sets transferred_at and unloads', async () => {
  await registry.transfer('lc-1', { visibility: 'none', owner: 'client' });
  const row = registry.getBySlug('lc-1');
  assert.strictEqual(row.status, 'transferred');
  assert.ok(row.transferred_at);
  assert.strictEqual(row.visibility, 'none');
  assert.strictEqual(row.owner, 'client');
  assert.strictEqual(loader.get('lc-1'), undefined);
});

test('lifecycle — setVisibility updates in-memory wrapper', async () => {
  await registry.createInstance({ slug: 'lc-2', name: 'LC Two', kind: 'test-kind' });
  await loader.register('lc-2');
  await registry.setVisibility('lc-2', 'limited');
  const entry = loader.get('lc-2');
  assert.throws(
    () => entry.db.exec('SELECT * FROM test_widgets'),
    VisibilityViolation
  );
});

test('lifecycle — setVisibility rejects invalid values', async () => {
  await assert.rejects(
    registry.setVisibility('lc-2', 'potato'),
    /invalid visibility/
  );
});
