const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'satellite-kinds');
process.env.MOTHERSHIP_KINDS_DIR = FIXTURES;

const kinds = require('../../src/satellites/kinds');

test('kinds — loadKind returns module with schema attached', () => {
  const k = kinds.loadKind('test-kind');
  assert.strictEqual(k.kind, 'test-kind');
  assert.ok(k.schema.includes('CREATE TABLE IF NOT EXISTS test_widgets'));
  assert.ok(k.directiveHandlers['config.set']);
});

test('kinds — loadKind throws on missing kind', () => {
  assert.throws(() => kinds.loadKind('does-not-exist'), /kind not found/i);
});

test('kinds — mergeCustom overrides top-level keys only', async () => {
  const base = kinds.loadKind('test-kind');
  const custom = {
    defaultConfig: { greeting: 'howdy' },
    directiveHandlers: {
      'config.set': async () => ({ status: 'applied', from: 'custom' })
    }
  };
  const merged = kinds.mergeCustom(base, custom);
  assert.strictEqual(merged.defaultConfig.greeting, 'howdy');
  // directiveHandlers is REPLACED, not merged — so only the custom handler exists.
  const result = await merged.directiveHandlers['config.set']({ payload: {}, db: null });
  assert.strictEqual(result.from, 'custom');
  // Top-level base fields survive the merge
  assert.strictEqual(merged.kind, 'test-kind');
  assert.strictEqual(merged.version, '0.0.1');
});
