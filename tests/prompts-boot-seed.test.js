const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-boot-seed-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const registry = require('../src/prompts/registry');

before(async () => {
  await db.init();
});

after(() => { try { fs.unlinkSync(tmpDb); } catch {} });

test('boot seed — seedFromHardcoded returns a positive count on fresh DB', () => {
  const n = registry.seedFromHardcoded();
  assert.ok(n >= 7, `expected at least 7 new rows, got ${n}`);
});

test('boot seed — every known prompt name is retrievable via getPrompt', () => {
  for (const name of [
    'system.conversation',
    'synthesis.mirror',
    'synthesis.wiki',
    'health.contradictions',
    'health.gap_analysis',
    'extractor.actions',
    'reflection.daily'
  ]) {
    const body = registry.getPrompt(name);
    assert.ok(body && body.length > 0, `getPrompt('${name}') returned empty`);
  }
});

test('boot seed — second call is idempotent and returns 0', () => {
  const n = registry.seedFromHardcoded();
  assert.strictEqual(n, 0);
});
