const test = require('node:test');
const assert = require('node:assert');
const initSqlJs = require('sql.js');

const sovereignty = require('../../src/satellites/sovereignty');

let SQL;
test.before(async () => { SQL = await initSqlJs(); });

function fresh() {
  const db = new SQL.Database();
  db.run(`CREATE TABLE satellite_meta (key TEXT PRIMARY KEY, value TEXT)`);
  db.run(`CREATE TABLE satellite_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT)`);
  db.run(`CREATE TABLE satellite_directives_history (id TEXT PRIMARY KEY, kind TEXT)`);
  db.run(`CREATE TABLE customers (id TEXT PRIMARY KEY, name TEXT)`);
  db.run(`INSERT INTO satellite_meta (key, value) VALUES ('greeting', '"hello"')`);
  db.run(`INSERT INTO customers (id, name) VALUES ('c1', 'Acme')`);
  return db;
}

test('sovereignty — full visibility: reads on any table pass', () => {
  const wrapped = sovereignty.wrap(fresh(), { visibility: 'full' });
  const res = wrapped.exec('SELECT * FROM customers');
  assert.strictEqual(res[0].values[0][1], 'Acme');
});

test('sovereignty — full visibility: INSERT on exec throws', () => {
  const wrapped = sovereignty.wrap(fresh(), { visibility: 'full' });
  assert.throws(
    () => wrapped.exec("INSERT INTO customers (id, name) VALUES ('c2', 'Beta')"),
    /SovereigntyViolation/
  );
});

test('sovereignty — full visibility: run UPDATE throws', () => {
  const wrapped = sovereignty.wrap(fresh(), { visibility: 'full' });
  assert.throws(
    () => wrapped.run("UPDATE customers SET name = ? WHERE id = ?", ['X', 'c1']),
    /SovereigntyViolation/
  );
});

test('sovereignty — full visibility: prepare on INSERT throws', () => {
  const wrapped = sovereignty.wrap(fresh(), { visibility: 'full' });
  assert.throws(
    () => wrapped.prepare("INSERT INTO customers (id, name) VALUES (?, ?)"),
    /SovereigntyViolation/
  );
});

test('sovereignty — full visibility: prepare on SELECT returns a wrapped stmt', () => {
  const wrapped = sovereignty.wrap(fresh(), { visibility: 'full' });
  const stmt = wrapped.prepare("SELECT name FROM customers WHERE id = ?");
  stmt.bind(['c1']);
  stmt.step();
  assert.strictEqual(stmt.getAsObject().name, 'Acme');
  stmt.free();
});

test('sovereignty — limited visibility: allowed tables pass', () => {
  const wrapped = sovereignty.wrap(fresh(), { visibility: 'limited' });
  const res = wrapped.exec('SELECT * FROM satellite_meta');
  assert.strictEqual(res[0].values[0][0], 'greeting');
});

test('sovereignty — limited visibility: disallowed table throws', () => {
  const wrapped = sovereignty.wrap(fresh(), { visibility: 'limited' });
  assert.throws(
    () => wrapped.exec('SELECT * FROM customers'),
    /VisibilityViolation/
  );
});

test('sovereignty — none visibility: all reads throw', () => {
  const wrapped = sovereignty.wrap(fresh(), { visibility: 'none' });
  assert.throws(() => wrapped.exec('SELECT * FROM satellite_meta'), /VisibilityViolation/);
});

test('sovereignty — writes are blocked regardless of visibility', () => {
  for (const vis of ['full', 'limited', 'none']) {
    const wrapped = sovereignty.wrap(fresh(), { visibility: vis });
    assert.throws(
      () => wrapped.run('DELETE FROM customers'),
      /SovereigntyViolation/,
      `visibility=${vis} should still block writes`
    );
  }
});

test('sovereignty — unclassified SQL (BEGIN / ROLLBACK / SAVEPOINT) is blocked', () => {
  const wrapped = sovereignty.wrap(fresh(), { visibility: 'full' });
  for (const sql of ['BEGIN', 'BEGIN TRANSACTION', 'COMMIT', 'ROLLBACK', 'SAVEPOINT s1', 'RELEASE s1']) {
    assert.throws(
      () => wrapped.exec(sql),
      /SovereigntyViolation/,
      `should block: ${sql}`
    );
    assert.throws(
      () => wrapped.run(sql),
      /SovereigntyViolation/,
      `should block: ${sql}`
    );
    assert.throws(
      () => wrapped.prepare(sql),
      /SovereigntyViolation/,
      `should block: ${sql}`
    );
  }
});

test('sovereignty — PRAGMA carve-out under limited visibility', () => {
  const wrapped = sovereignty.wrap(fresh(), { visibility: 'limited' });
  // PRAGMA statements have no FROM clause and are treated as metadata —
  // the limited tier allows them for health checks and schema inspection.
  const res = wrapped.exec('PRAGMA table_info(satellite_meta)');
  assert.ok(Array.isArray(res));
});
