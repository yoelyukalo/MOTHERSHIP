const test = require('node:test');
const assert = require('node:assert');

test('smoke — node:test is wired', () => {
  assert.strictEqual(1 + 1, 2);
});
