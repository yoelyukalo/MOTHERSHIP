const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

// Build a legacy-schema DB manually, then point MOTHERSHIP_DB_PATH at it
// BEFORE requiring ../src/database — init() will detect the pre-v3 schema and
// rebuild it in place. This is the only realistic way to exercise the
// migration path short of running against production data.
const tmpDb = path.join(__dirname, `.tmp-taxonomy-v3-${Date.now()}.db`);

test('mirror-taxonomy-v3 migration — rebuilds legacy schema and remaps categories', async (t) => {
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });

  // 1. Build a legacy v2 DB (no entry_type/layer/status/related_ids columns).
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const legacyDb = new SQL.Database();
  legacyDb.run(`
    CREATE TABLE mirror_entries (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      source_type TEXT NOT NULL,
      source_id TEXT,
      embedding BLOB,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      superseded_by TEXT,
      user_id TEXT
    )
  `);

  const fixtures = [
    ['id-1', 'mental_models',   'Thinks in first principles',         0.9, 'u1'],
    ['id-2', 'preferences',     'Prefers terse docs with examples',   0.8, 'u1'],
    ['id-3', 'knowledge_levels','AI/LLMs — advanced',                 0.85,'u1'],
    ['id-4', 'active_projects', 'Building MOTHERSHIP phase 5',        0.95,'u1'],
    ['id-5', 'decisions',       'Picked Claude as primary LLM',       0.9, 'u1'],
    ['id-6', 'patterns',        'Energy dips on Wednesdays',          0.7, 'u1'],
    ['id-7', 'contradictions',  'Wants speed but also wants polish',  0.6, 'u1'],
    ['id-8', 'goals',           'Ship Mothership v1 by May',          0.85,'u1'],
    // Unknown legacy label — should fall back to the default bucket.
    ['id-9', 'wildcard-foo',    'Something totally ad-hoc',           0.5, 'u1']
  ];
  for (const [id, cat, content, conf, uid] of fixtures) {
    legacyDb.run(
      `INSERT INTO mirror_entries (id, category, content, confidence, source_type, user_id)
       VALUES (?, ?, ?, ?, 'migration', ?)`,
      [id, cat, content, conf, uid]
    );
  }
  // Also needs a messages table so logs/db.init don't choke, and a config
  // table so the init path can set flags. Easiest: only the bare minimum.
  legacyDb.run(`CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT, source TEXT, category TEXT, tags TEXT, created_at TEXT, metadata TEXT, user_id TEXT)`);
  legacyDb.run(`CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`);

  const bytes = legacyDb.export();
  fs.mkdirSync(path.dirname(tmpDb), { recursive: true });
  fs.writeFileSync(tmpDb, Buffer.from(bytes));
  legacyDb.close();

  // 2. Point the real database module at this file and init — this should
  //    trigger the v3 migration inside init().
  process.env.MOTHERSHIP_DB_PATH = tmpDb;
  // Fresh require — the database module is a singleton, so if it was already
  // loaded by a previous test the cached `db` reference would still point at
  // whatever file that earlier test used. Clear it.
  delete require.cache[require.resolve('../src/database')];
  const db = require('../src/database');
  await db.init();

  // 3. Verify schema rebuilt: entry_type column exists.
  const raw = db._raw();
  const info = raw.exec(`PRAGMA table_info(mirror_entries)`);
  const cols = info[0].values.map(r => r[1]);
  assert.ok(cols.includes('entry_type'), 'entry_type column missing after migration');
  assert.ok(cols.includes('layer'), 'layer column missing after migration');
  assert.ok(cols.includes('status'), 'status column missing after migration');
  assert.ok(cols.includes('related_ids'), 'related_ids column missing after migration');

  // 4. Verify all 9 legacy rows survived, with correct mapping.
  const allRows = db.getMirrorEntries({ allUsers: true, limit: 1000, activeOnly: false });
  assert.strictEqual(allRows.length, 9, 'row count changed during migration');

  const byId = new Map(allRows.map(r => [r.id, r]));
  const expected = {
    'id-1': { entry_type: 'model',         layer: 'world' },
    'id-2': { entry_type: 'signal',        layer: 'pattern' },
    'id-3': { entry_type: 'model',         layer: 'world' },
    'id-4': { entry_type: 'context',       layer: 'world' },
    'id-5': { entry_type: 'decision',      layer: 'direction' },
    'id-6': { entry_type: 'loop',          layer: 'pattern' },
    'id-7': { entry_type: 'contradiction', layer: 'pattern' },
    'id-8': { entry_type: 'goal',          layer: 'direction' },
    // unknown → falls back to 'context'/world
    'id-9': { entry_type: 'context',       layer: 'world' }
  };
  for (const [id, { entry_type, layer }] of Object.entries(expected)) {
    const row = byId.get(id);
    assert.ok(row, `row ${id} missing after migration`);
    assert.strictEqual(row.entry_type, entry_type, `${id} entry_type wrong`);
    assert.strictEqual(row.layer, layer, `${id} layer wrong`);
    assert.strictEqual(row.status, 'active', `${id} status wrong`);
    assert.deepStrictEqual(row.related_ids, [], `${id} related_ids wrong`);
  }

  // 5. Verify filtering by entry_type works, and legacy category filter still
  //    resolves through the taxonomy alias (e.g. 'mental_models' → 'model').
  const models = db.getMirrorEntries({ entry_type: 'model', allUsers: true, activeOnly: false });
  assert.strictEqual(models.length, 2, 'entry_type=model should match id-1 and id-3');

  const aliased = db.getMirrorEntries({ category: 'mental_models', allUsers: true, activeOnly: false });
  assert.strictEqual(aliased.length, 2, 'legacy category alias should map to entry_type=model');

  // 6. Layer filter sanity check.
  const patternRows = db.getMirrorEntries({ layer: 'pattern', allUsers: true, activeOnly: false });
  assert.strictEqual(patternRows.length, 3, 'pattern layer should contain id-2/id-6/id-7');

  // 7. Idempotent: a second call to db.init() must not touch anything.
  const beforeCount = db.getMirrorEntries({ allUsers: true, limit: 1000, activeOnly: false }).length;
  await db.init();
  const afterCount = db.getMirrorEntries({ allUsers: true, limit: 1000, activeOnly: false }).length;
  assert.strictEqual(afterCount, beforeCount, 'migration re-ran on idempotent init');
});
