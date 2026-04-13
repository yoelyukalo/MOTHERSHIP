const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-sat-'));
const tmpDb = path.join(tmpRoot, 'mothership.db');
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../../src/database');

test('database — satellites and satellite_drafts tables exist after init', async (t) => {
  await db.init();
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const raw = db._raw();
  const tables = raw.exec(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  )[0].values.map(r => r[0]);

  assert.ok(tables.includes('satellites'), 'satellites table missing');
  assert.ok(tables.includes('satellite_drafts'), 'satellite_drafts table missing');
});

test('database — satellites has the expected columns', async () => {
  const raw = db._raw();
  const cols = raw.exec("PRAGMA table_info(satellites)")[0].values.map(r => r[1]);
  for (const col of ['id', 'slug', 'name', 'kind', 'db_path', 'owner', 'visibility', 'status', 'config_json', 'created_at', 'transferred_at', 'notes']) {
    assert.ok(cols.includes(col), `satellites missing column ${col}`);
  }
});

test('database — satellite_drafts has the expected columns', async () => {
  const raw = db._raw();
  const cols = raw.exec("PRAGMA table_info(satellite_drafts)")[0].values.map(r => r[1]);
  for (const col of ['id', 'slug', 'name', 'kind', 'status', 'brief_md', 'brief_updated_at', 'created_satellite_id', 'created_at', 'updated_at']) {
    assert.ok(cols.includes(col), `satellite_drafts missing column ${col}`);
  }
});
