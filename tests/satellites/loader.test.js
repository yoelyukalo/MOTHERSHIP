const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-sat-loader-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');
process.env.MOTHERSHIP_SATELLITES_DIR = path.join(tmpRoot, 'satellites');
process.env.MOTHERSHIP_KINDS_DIR = path.join(__dirname, '..', 'fixtures', 'satellite-kinds');
fs.mkdirSync(process.env.MOTHERSHIP_SATELLITES_DIR, { recursive: true });

const db = require('../../src/database');
const registry = require('../../src/satellites/registry');
const loader = require('../../src/satellites/loader');
const { SovereigntyViolation, VisibilityViolation } = require('../../src/satellites/sovereignty');

before(async () => { await db.init(); });
after(async () => {
  await loader.shutdown();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('loader — register returns a wrapped handle stored in the map', async () => {
  await registry.createInstance({ slug: 'load-1', name: 'Load One', kind: 'test-kind' });
  await loader.register('load-1');
  const entry = loader.get('load-1');
  assert.ok(entry);
  assert.strictEqual(entry.kind, 'test-kind');
  // Reads pass under full visibility
  const res = entry.db.exec('SELECT * FROM satellite_meta');
  assert.ok(Array.isArray(res));
});

test('loader — wrapped handle blocks writes', () => {
  const entry = loader.get('load-1');
  assert.throws(
    () => entry.db.run("INSERT INTO satellite_meta (key, value) VALUES ('x', '1')"),
    SovereigntyViolation
  );
});

test('loader — init loads all active non-embedded satellites', async () => {
  await registry.createInstance({ slug: 'load-2', name: 'Load Two', kind: 'test-kind' });
  await loader.shutdown();
  await loader.init();
  assert.ok(loader.get('load-1'));
  assert.ok(loader.get('load-2'));
});

test('loader — archived satellites are not loaded at boot', async () => {
  registry.updateStatus('load-2', 'archived');
  await loader.shutdown();
  await loader.init();
  assert.ok(loader.get('load-1'));
  assert.strictEqual(loader.get('load-2'), undefined);
});

test('loader — broken kind is marked and does not crash init', async () => {
  // Insert a row directly pointing at a non-existent kind
  registry.insertRow({ slug: 'load-broken', name: 'Broken', kind: 'nope-kind' });
  await loader.shutdown();
  await loader.init();
  const row = registry.getBySlug('load-broken');
  assert.strictEqual(row.status, 'broken');
  assert.strictEqual(loader.get('load-broken'), undefined);
});

test('loader — limited visibility blocks reads of non-meta tables', async () => {
  await registry.createInstance({ slug: 'load-3', name: 'Load Three', kind: 'test-kind' });
  registry.updateVisibility('load-3', 'limited');
  await loader.register('load-3');
  const entry = loader.get('load-3');
  assert.throws(
    () => entry.db.exec('SELECT * FROM test_widgets'),
    VisibilityViolation
  );
  // satellite_meta is still readable
  entry.db.exec('SELECT * FROM satellite_meta');
});
