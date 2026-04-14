const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const initSqlJs = require('sql.js');
const kinds = require('../../src/satellites/kinds');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-sat-reg-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');
process.env.MOTHERSHIP_SATELLITES_DIR = path.join(tmpRoot, 'satellites');
process.env.MOTHERSHIP_KINDS_DIR = path.join(__dirname, '..', 'fixtures', 'satellite-kinds');
fs.mkdirSync(process.env.MOTHERSHIP_SATELLITES_DIR, { recursive: true });

const db = require('../../src/database');
const registry = require('../../src/satellites/registry');

before(async () => { await db.init(); });
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test('registry — validateSlug accepts valid slugs', () => {
  assert.strictEqual(registry.validateSlug('abc-auto-titles'), true);
  assert.strictEqual(registry.validateSlug('dental1'), true);
  assert.strictEqual(registry.validateSlug('a1b'), true);
});

test('registry — validateSlug rejects invalid slugs', () => {
  assert.strictEqual(registry.validateSlug('ABC'), false);
  assert.strictEqual(registry.validateSlug('-abc'), false);
  assert.strictEqual(registry.validateSlug('ab'), false);
  assert.strictEqual(registry.validateSlug('a'.repeat(65)), false);
  assert.strictEqual(registry.validateSlug('has_underscore'), false);
  assert.strictEqual(registry.validateSlug('has space'), false);
});

test('registry — insertRow writes a row with defaults', () => {
  const id = registry.insertRow({
    slug: 'test-sat-1', name: 'Test One', kind: 'test-kind', db_path: 'data/satellites/test-sat-1/db.sqlite'
  });
  assert.ok(id);
  const row = registry.getBySlug('test-sat-1');
  assert.strictEqual(row.slug, 'test-sat-1');
  assert.strictEqual(row.owner, 'mothership');
  assert.strictEqual(row.visibility, 'full');
  assert.strictEqual(row.status, 'active');
});

test('registry — insertRow rejects duplicate slug', () => {
  assert.throws(
    () => registry.insertRow({ slug: 'test-sat-1', name: 'dup', kind: 'test-kind' }),
    /slug/
  );
});

test('registry — listRows filters by status and kind', () => {
  registry.insertRow({ slug: 'test-sat-2', name: 'Two', kind: 'test-kind' });
  registry.insertRow({ slug: 'test-sat-3', name: 'Three', kind: 'other-kind' });
  registry.updateStatus('test-sat-2', 'archived');

  const active = registry.listRows({ status: 'active' });
  const archived = registry.listRows({ status: 'archived' });
  const testKind = registry.listRows({ kind: 'test-kind' });

  assert.ok(active.find(r => r.slug === 'test-sat-1'));
  assert.ok(!active.find(r => r.slug === 'test-sat-2'));
  assert.ok(archived.find(r => r.slug === 'test-sat-2'));
  assert.strictEqual(testKind.length, 2);
});

test('registry — createInstance builds folder tree and baseline+kind tables', async () => {
  const inst = await registry.createInstance({
    slug: 'inst-1',
    name: 'Instance One',
    kind: 'test-kind',
    visibility: 'full',
    owner: 'mothership',
    config: { greeting: 'hi' }
  });
  assert.strictEqual(inst.slug, 'inst-1');
  assert.ok(inst.id);

  const base = path.join(process.env.MOTHERSHIP_SATELLITES_DIR, 'inst-1');
  assert.ok(fs.existsSync(path.join(base, 'db.sqlite')));
  assert.ok(fs.existsSync(path.join(base, 'config.json')));
  assert.ok(fs.existsSync(path.join(base, 'directives', 'pending')));
  assert.ok(fs.existsSync(path.join(base, 'directives', 'applied')));
  assert.ok(fs.existsSync(path.join(base, 'directives', 'rejected')));
  assert.ok(fs.existsSync(path.join(base, 'agents')));

  const cfg = JSON.parse(fs.readFileSync(path.join(base, 'config.json'), 'utf8'));
  assert.strictEqual(cfg.greeting, 'hi');
  assert.strictEqual(cfg.nested.a, 1); // from kind default

  const SQL = await initSqlJs();
  const buf = fs.readFileSync(path.join(base, 'db.sqlite'));
  const sdb = new SQL.Database(buf);
  const tables = sdb.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")[0].values.map(r => r[0]);
  for (const t of ['satellite_meta', 'satellite_messages', 'satellite_logs', 'satellite_directives_history', 'test_widgets']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
});

test('registry — createInstance rolls back on kind load failure', async () => {
  await assert.rejects(
    registry.createInstance({ slug: 'inst-bad', name: 'Bad', kind: 'missing-kind' }),
    /kind not found/i
  );
  assert.ok(!fs.existsSync(path.join(process.env.MOTHERSHIP_SATELLITES_DIR, 'inst-bad')));
  assert.strictEqual(registry.getBySlug('inst-bad'), null);
});

test('registry — createInstance rejects path-traversal kind names', async () => {
  await assert.rejects(
    registry.createInstance({ slug: 'inst-evil', name: 'Evil', kind: '../../../etc/passwd' }),
    /invalid kind name/i
  );
  assert.ok(!fs.existsSync(path.join(process.env.MOTHERSHIP_SATELLITES_DIR, 'inst-evil')));
  assert.strictEqual(registry.getBySlug('inst-evil'), null);
});
