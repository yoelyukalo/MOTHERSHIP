const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-sat-e2e-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');
process.env.MOTHERSHIP_SATELLITES_DIR = path.join(tmpRoot, 'satellites');
process.env.MOTHERSHIP_KINDS_DIR = path.join(__dirname, '..', 'fixtures', 'satellite-kinds');
fs.mkdirSync(process.env.MOTHERSHIP_SATELLITES_DIR, { recursive: true });

const db = require('../../src/database');
const satellites = require('../../src/satellites');
const users = require('../../src/auth/users');
const { SovereigntyViolation, VisibilityViolation } = require('../../src/satellites/sovereignty');

let testUserId;

before(async () => { await db.init(); testUserId = await users.createUser({ email: 'sat-e2e-test@x', password: 'p' }); await satellites.init(); });
after(async () => {
  await satellites.shutdown();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

test('e2e — draft → satellite → directive → applied', async () => {
  // 1. Create draft
  satellites.drafts.create({ slug: 'e2e-draft', name: 'E2E Draft', kind: 'test-kind' });

  // 2. Link a chat turn by metadata
  db.addMessage('We should build an E2E satellite', 'dashboard', 'uncategorized', { draft_slug: 'e2e-draft' }, testUserId);

  // 3. Verify linked message retrieval
  const { draft, messages } = satellites.drafts.getDraftWithMessages('e2e-draft');
  assert.strictEqual(draft.slug, 'e2e-draft');
  assert.strictEqual(messages.length, 1);

  // 4. Promote draft to satellite
  const { id } = await satellites.registry.createInstance({
    slug: 'e2e-sat', name: 'E2E Sat', kind: 'test-kind'
  });
  satellites.drafts.linkToSatellite('e2e-draft', id);
  assert.strictEqual(satellites.drafts.getBySlug('e2e-draft').status, 'created');

  // 5. Register in loader
  await satellites.loader.register('e2e-sat');
  const entry = satellites.loader.get('e2e-sat');
  assert.ok(entry);

  // 6. Sovereignty: writes blocked
  assert.throws(
    () => entry.db.run("INSERT INTO satellite_meta (key, value) VALUES ('x', '1')"),
    SovereigntyViolation
  );

  // 7. Issue a config.set directive
  satellites.directives.issue('e2e-sat', {
    kind: 'config.set',
    payload: { key: 'greeting', value: 'howdy' },
    issuedBy: 'e2e'
  });
  await sleep(500);

  // 8. Assert applied
  const applied = fs.readdirSync(path.join(process.env.MOTHERSHIP_SATELLITES_DIR, 'e2e-sat', 'directives', 'applied'));
  assert.strictEqual(applied.length, 1);
  const histRow = entry.db.exec("SELECT status FROM satellite_directives_history WHERE kind='config.set'")[0];
  assert.strictEqual(histRow.values[0][0], 'applied');
  const metaRow = entry.db.exec("SELECT value FROM satellite_meta WHERE key='greeting'")[0];
  assert.strictEqual(JSON.parse(metaRow.values[0][0]), 'howdy');

  // 9. Change visibility to limited, re-read
  await satellites.registry.setVisibility('e2e-sat', 'limited');
  const refreshed = satellites.loader.get('e2e-sat');
  refreshed.db.exec('SELECT * FROM satellite_meta'); // ok
  assert.throws(
    () => refreshed.db.exec('SELECT * FROM test_widgets'),
    VisibilityViolation
  );

  // 10. Archive and verify unload
  await satellites.registry.archive('e2e-sat');
  assert.strictEqual(satellites.loader.get('e2e-sat'), undefined);
  assert.strictEqual(satellites.registry.getBySlug('e2e-sat').status, 'archived');

  // 11. Unarchive and verify reload
  await satellites.registry.unarchive('e2e-sat');
  assert.ok(satellites.loader.get('e2e-sat'));
});
