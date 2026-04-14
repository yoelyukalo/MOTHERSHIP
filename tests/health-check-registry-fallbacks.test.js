const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-hc-fallbacks-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const registry = require('../src/prompts/registry');
// Requiring health-check triggers its module-load setFallback calls
require('../src/health-check');

before(async () => {
  await db.init();
});

after(() => { try { fs.unlinkSync(tmpDb); } catch {} });

test('health-check registers fallback for health.contradictions at module load', () => {
  const body = registry.getPrompt('health.contradictions');
  assert.ok(body && body.length > 0);
  // The body should be the stringified source of HEALTH_CONTRADICTIONS
  // (which is a template function, so its toString contains the word "contradictions")
  assert.ok(body.toLowerCase().includes('contradiction'));
});

test('health-check registers fallback for health.gap_analysis at module load', () => {
  const body = registry.getPrompt('health.gap_analysis');
  assert.ok(body && body.length > 0);
  assert.ok(body.toLowerCase().includes('gap') || body.toLowerCase().includes('mirror'));
});
