const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-sat-boot-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');
process.env.MOTHERSHIP_SATELLITES_DIR = path.join(tmpRoot, 'satellites');
process.env.MOTHERSHIP_KINDS_DIR = path.join(__dirname, '..', 'fixtures', 'satellite-kinds');
fs.mkdirSync(process.env.MOTHERSHIP_SATELLITES_DIR, { recursive: true });

const db = require('../../src/database');
const satellites = require('../../src/satellites');

before(async () => { await db.init(); });
after(async () => {
  await satellites.shutdown();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('satellites — init runs with zero instances and returns', async () => {
  await satellites.init(); // should not throw
  assert.deepStrictEqual(satellites.loader.list(), []);
});

test('satellites — init re-runs after a satellite is created', async () => {
  await satellites.registry.createInstance({ slug: 'boot-1', name: 'Boot One', kind: 'test-kind' });
  await satellites.shutdown();
  await satellites.init();
  assert.ok(satellites.loader.list().includes('boot-1'));
});
