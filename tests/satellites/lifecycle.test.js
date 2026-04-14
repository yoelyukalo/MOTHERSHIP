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

test('lifecycle — transfer rejects invalid visibility values', async () => {
  await registry.createInstance({ slug: 'lc-tx-bad', name: 'Bad TX', kind: 'test-kind' });
  await loader.register('lc-tx-bad');
  await assert.rejects(
    registry.transfer('lc-tx-bad', { visibility: 'potato' }),
    /invalid visibility/
  );
  // Row is unchanged — still active, not transferred.
  const row = registry.getBySlug('lc-tx-bad');
  assert.strictEqual(row.status, 'active');
  assert.strictEqual(row.transferred_at, null);
});

test('lifecycle — unarchive rejects non-archived satellites', async () => {
  // lc-1 is currently transferred (from the earlier transfer test).
  await assert.rejects(
    registry.unarchive('lc-1'),
    /cannot unarchive satellite in status 'transferred'/
  );
  // Unknown slug also rejects.
  await assert.rejects(
    registry.unarchive('does-not-exist'),
    /no such satellite/
  );
});

test('lifecycle — archive fires the kind onArchive hook', async () => {
  // Write a one-off kind whose onArchive sets a meta key we can inspect.
  const customDir = path.join(process.env.MOTHERSHIP_KINDS_DIR, 'archive-tracker');
  fs.mkdirSync(customDir, { recursive: true });
  fs.writeFileSync(path.join(customDir, 'index.js'),
    `module.exports = {
      kind: 'archive-tracker', displayName: 'Archive Tracker', version: '0.0.1',
      description: 'fixture', defaultConfig: {}, directiveHandlers: {},
      onCreate: async () => {},
      onBoot: async () => {},
      onArchive: async ({ db }) => {
        db.run(
          "INSERT OR REPLACE INTO satellite_meta (key, value, updated_at) VALUES (?, ?, datetime('now'))",
          ['archived_at_marker', '"yes"']
        );
      },
      handlers: {}
    };`);
  fs.writeFileSync(path.join(customDir, 'schema.sql'), '');

  try {
    await registry.createInstance({ slug: 'lc-hook', name: 'Hook', kind: 'archive-tracker' });
    await loader.register('lc-hook');

    // Capture the dbFile path BEFORE archive unloads the satellite.
    const dbFile = path.join(process.env.MOTHERSHIP_SATELLITES_DIR, 'lc-hook', 'db.sqlite');

    await registry.archive('lc-hook');
    assert.strictEqual(registry.getBySlug('lc-hook').status, 'archived');

    // Re-open the DB file directly and confirm the hook wrote the marker.
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    const sdb = new SQL.Database(fs.readFileSync(dbFile));
    const res = sdb.exec("SELECT value FROM satellite_meta WHERE key = 'archived_at_marker'");
    assert.strictEqual(JSON.parse(res[0].values[0][0]), 'yes');
    sdb.close();
  } finally {
    fs.rmSync(customDir, { recursive: true, force: true });
  }
});
