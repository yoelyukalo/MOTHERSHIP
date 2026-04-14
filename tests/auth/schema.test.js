const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-auth-schema-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');

const db = require('../../src/database');

before(async () => { await db.init(); });
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test('auth schema — all 10 auth tables exist after init', () => {
  const raw = db._raw();
  const tables = raw.exec(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  )[0].values.map(r => r[0]);

  for (const t of [
    'users', 'sessions', 'api_keys', 'groups', 'group_memberships',
    'roles', 'permissions', 'role_permissions', 'role_assignments', 'invitations'
  ]) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
});

test('auth schema — users has expected columns', () => {
  const raw = db._raw();
  const cols = raw.exec("PRAGMA table_info(users)")[0].values.map(r => r[1]);
  for (const col of ['id', 'email', 'display_name', 'auth_method', 'password_hash', 'created_at', 'disabled_at', 'notes']) {
    assert.ok(cols.includes(col), `users missing column ${col}`);
  }
});

test('auth schema — role_assignments has principal_type and nullable satellite_id', () => {
  const raw = db._raw();
  const cols = raw.exec("PRAGMA table_info(role_assignments)")[0].values;
  const byName = Object.fromEntries(cols.map(r => [r[1], r]));
  assert.ok(byName.principal_type, 'missing principal_type');
  assert.ok(byName.principal_id, 'missing principal_id');
  assert.ok(byName.satellite_id, 'missing satellite_id');
  assert.strictEqual(byName.satellite_id[3], 0, 'satellite_id should be nullable (notnull=0)');
});

test('auth schema — messages/mirror_entries/wiki_entries have user_id column', () => {
  const raw = db._raw();
  for (const t of ['messages', 'mirror_entries', 'wiki_entries']) {
    const cols = raw.exec(`PRAGMA table_info(${t})`)[0].values.map(r => r[1]);
    assert.ok(cols.includes('user_id'), `${t} missing user_id column`);
  }
});
