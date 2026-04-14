const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-sat-dir-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');
process.env.MOTHERSHIP_SATELLITES_DIR = path.join(tmpRoot, 'satellites');
process.env.MOTHERSHIP_KINDS_DIR = path.join(__dirname, '..', 'fixtures', 'satellite-kinds');
fs.mkdirSync(process.env.MOTHERSHIP_SATELLITES_DIR, { recursive: true });

const db = require('../../src/database');
const registry = require('../../src/satellites/registry');
const loader = require('../../src/satellites/loader');
const directives = require('../../src/satellites/directives');

before(async () => { await db.init(); });
after(async () => {
  await loader.shutdown();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

test('directives — issue writes a JSON file to pending/', async () => {
  await registry.createInstance({ slug: 'd-1', name: 'Dir One', kind: 'test-kind' });
  const id = directives.issue('d-1', {
    kind: 'config.set',
    payload: { key: 'hours', value: '9-5' },
    issuedBy: 'test'
  });
  assert.ok(id);
  const pending = path.join(process.env.MOTHERSHIP_SATELLITES_DIR, 'd-1', 'directives', 'pending');
  const files = fs.readdirSync(pending);
  assert.strictEqual(files.length, 1);
  const body = JSON.parse(fs.readFileSync(path.join(pending, files[0]), 'utf8'));
  assert.strictEqual(body.kind, 'config.set');
  assert.strictEqual(body.payload.key, 'hours');
  assert.strictEqual(body.issued_by, 'test');
});

test('directives — consumer processes pending directives on register', async () => {
  await loader.register('d-1');
  // Wait for the startup sweep to run the directive.
  await sleep(200);

  const inst = path.join(process.env.MOTHERSHIP_SATELLITES_DIR, 'd-1', 'directives');
  assert.strictEqual(fs.readdirSync(path.join(inst, 'pending')).length, 0);
  assert.strictEqual(fs.readdirSync(path.join(inst, 'applied')).length, 1);

  // History row
  const entry = loader.get('d-1');
  const res = entry.db.exec('SELECT kind, status FROM satellite_directives_history');
  assert.strictEqual(res[0].values[0][0], 'config.set');
  assert.strictEqual(res[0].values[0][1], 'applied');

  // satellite_meta contains the key
  const meta = entry.db.exec("SELECT value FROM satellite_meta WHERE key = 'hours'");
  assert.strictEqual(JSON.parse(meta[0].values[0][0]), '9-5');
});

test('directives — unknown kind is rejected with error file', async () => {
  await registry.createInstance({ slug: 'd-2', name: 'Dir Two', kind: 'test-kind' });
  directives.issue('d-2', { kind: 'does.not.exist', payload: {}, issuedBy: 'test' });
  await loader.register('d-2');
  await sleep(200);

  const rejected = path.join(process.env.MOTHERSHIP_SATELLITES_DIR, 'd-2', 'directives', 'rejected');
  const files = fs.readdirSync(rejected);
  assert.ok(files.some(f => f.endsWith('.json')));
  assert.ok(files.some(f => f.endsWith('_error.txt')));
});

test('directives — hot-added directive is processed by chokidar', async () => {
  await registry.createInstance({ slug: 'd-3', name: 'Dir Three', kind: 'test-kind' });
  await loader.register('d-3');
  directives.issue('d-3', {
    kind: 'config.set',
    payload: { key: 'greeting', value: 'hi' },
    issuedBy: 'test'
  });
  await sleep(500);

  const entry = loader.get('d-3');
  const res = entry.db.exec("SELECT value FROM satellite_meta WHERE key = 'greeting'");
  assert.strictEqual(JSON.parse(res[0].values[0][0]), 'hi');
});

test('directives — issue rejects kind names with path separators or bad chars', () => {
  for (const badKind of ['config.set/../../applied', '../evil', 'has space', 'UPPER', '.leading-dot', '']) {
    assert.throws(
      () => directives.issue('d-1', { kind: badKind, payload: {}, issuedBy: 'test' }),
      /invalid directive kind/,
      `should reject: ${JSON.stringify(badKind)}`
    );
  }
});
