const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-sat-reg-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');
process.env.MOTHERSHIP_SATELLITES_DIR = path.join(tmpRoot, 'satellites');
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
