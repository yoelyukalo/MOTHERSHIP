const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-auth-api-keys-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');

const db = require('../../src/database');
const users = require('../../src/auth/users');
const apiKeys = require('../../src/auth/api-keys');

let userId;
before(async () => {
  await db.init();
  userId = await users.createUser({ email: 'bot@x', auth_method: 'api_key_only' });
});
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test('api-keys — generateApiKey returns plaintext with mk_live_ prefix', async () => {
  const { id, plaintext } = await apiKeys.generateApiKey(userId, 'claude-code-dev');
  assert.ok(id);
  assert.ok(plaintext.startsWith('mk_live_'));
  assert.ok(plaintext.length > 20);
});

test('api-keys — lookupByToken finds the key by plaintext', async () => {
  const { plaintext } = await apiKeys.generateApiKey(userId, 'k2');
  const found = await apiKeys.lookupByToken(plaintext);
  assert.ok(found);
  assert.strictEqual(found.user_id, userId);
  assert.strictEqual(found.name, 'k2');
});

test('api-keys — lookupByToken returns null for wrong plaintext', async () => {
  const found = await apiKeys.lookupByToken('mk_live_totallywrong');
  assert.strictEqual(found, null);
});

test('api-keys — lookupByToken returns null for disabled key', async () => {
  const { id, plaintext } = await apiKeys.generateApiKey(userId, 'k3');
  apiKeys.disableApiKey(id);
  const found = await apiKeys.lookupByToken(plaintext);
  assert.strictEqual(found, null);
});

test('api-keys — listForUser returns only non-disabled keys by default', async () => {
  const keys = apiKeys.listForUser(userId);
  assert.ok(keys.length >= 2);
  assert.ok(keys.every(k => !k.disabled_at));
});
