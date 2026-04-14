const test = require('node:test');
const assert = require('node:assert');
const hashing = require('../../src/auth/hashing');

test('hashing — hash returns a string with argon2id prefix', async () => {
  const encoded = await hashing.hash('correct-horse-battery-staple');
  assert.ok(typeof encoded === 'string');
  assert.ok(encoded.startsWith('$argon2id$'), `got: ${encoded.slice(0, 20)}`);
});

test('hashing — verify accepts correct password', async () => {
  const encoded = await hashing.hash('hunter2');
  assert.strictEqual(await hashing.verify(encoded, 'hunter2'), true);
});

test('hashing — verify rejects wrong password', async () => {
  const encoded = await hashing.hash('hunter2');
  assert.strictEqual(await hashing.verify(encoded, 'hunter3'), false);
});

test('hashing — verify returns false on malformed encoded string', async () => {
  assert.strictEqual(await hashing.verify('not-an-argon2-hash', 'whatever'), false);
});

test('hashing — two hashes of same password produce different outputs (random salt)', async () => {
  const a = await hashing.hash('same');
  const b = await hashing.hash('same');
  assert.notStrictEqual(a, b);
});
