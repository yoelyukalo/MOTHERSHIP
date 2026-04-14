const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-conv-cutover-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const registry = require('../src/prompts/registry');
const conversation = require('../src/conversation');

before(async () => {
  await db.init();
  // Seed the registry so getPrompt has a DB row to return
  registry.seedFromHardcoded();
});

after(() => { try { fs.unlinkSync(tmpDb); } catch {} });

test('_buildStaticSystemPrompt returns the seeded body', () => {
  const prompt = conversation._buildStaticSystemPrompt();
  assert.ok(prompt.includes('MOTHERSHIP'));
  assert.ok(prompt.includes('voice register') || prompt.includes('senior builder'));
});

test('_buildStaticSystemPrompt reflects registry after activateVersion', () => {
  registry.createVersion('system.conversation', 'CUSTOM BODY FOR CUTOVER TEST', {
    createdBy: 'test', activate: true
  });
  const prompt = conversation._buildStaticSystemPrompt();
  assert.strictEqual(prompt, 'CUSTOM BODY FOR CUTOVER TEST');
});

test('_buildStaticSystemPrompt uses fallback when registry is degraded', () => {
  // Delete all active rows for system.conversation to force the fallback path
  const raw = db._raw();
  raw.run(`DELETE FROM prompt_versions WHERE name = 'system.conversation'`);
  registry._invalidateAll();
  const prompt = conversation._buildStaticSystemPrompt();
  // Fallback should have been registered at module load — should contain the
  // canonical hardcoded body we seeded from
  assert.ok(prompt.includes('MOTHERSHIP'));
  assert.ok(prompt.length > 100);
});
