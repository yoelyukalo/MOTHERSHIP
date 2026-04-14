const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-auth-users-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');

const db = require('../../src/database');
const users = require('../../src/auth/users');

before(async () => { await db.init(); });
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test('users — createUser inserts a password user and returns id', async () => {
  const id = await users.createUser({
    email: 'yoel@example.com', display_name: 'Yoel',
    password: 'correct-horse', auth_method: 'password'
  });
  assert.ok(id);
  const row = users.getUserByEmail('yoel@example.com');
  assert.strictEqual(row.email, 'yoel@example.com');
  assert.strictEqual(row.auth_method, 'password');
  assert.ok(row.password_hash);
  assert.ok(row.password_hash.startsWith('$argon2id$'));
});

test('users — createUser rejects duplicate email', async () => {
  await assert.rejects(
    users.createUser({ email: 'yoel@example.com', password: 'x' }),
    /already exists/
  );
});

test('users — createUser with auth_method api_key_only has no password_hash', async () => {
  await users.createUser({
    email: 'bot@mothership', auth_method: 'api_key_only', display_name: 'Claude Bot'
  });
  const row = users.getUserByEmail('bot@mothership');
  assert.strictEqual(row.auth_method, 'api_key_only');
  assert.strictEqual(row.password_hash, null);
});

test('users — listUsers returns all users', () => {
  const all = users.listUsers();
  assert.ok(all.length >= 2);
});

test('users — disableUser sets disabled_at', () => {
  const before = users.getUserByEmail('bot@mothership');
  users.disableUser(before.id);
  const after = users.getUserByEmail('bot@mothership');
  assert.ok(after.disabled_at);
});

test('users — updatePassword rehashes', async () => {
  const before = users.getUserByEmail('yoel@example.com');
  await users.updatePassword(before.id, 'new-pass-phrase');
  const after = users.getUserByEmail('yoel@example.com');
  assert.notStrictEqual(after.password_hash, before.password_hash);
});
