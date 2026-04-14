const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-schema-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');

before(async () => {
  await db.init();
});

after(() => {
  try { fs.unlinkSync(tmpDb); } catch {}
});

test('phase 5 schema — all four tables exist after init', () => {
  const raw = db._raw();
  const tables = raw.exec(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)[0].values.map(r => r[0]);

  assert.ok(tables.includes('actions'), 'actions table missing');
  assert.ok(tables.includes('reflections'), 'reflections table missing');
  assert.ok(tables.includes('prompt_versions'), 'prompt_versions table missing');
  assert.ok(tables.includes('prompt_proposals'), 'prompt_proposals table missing');
});

test('phase 5 schema — actions table has required columns', () => {
  const raw = db._raw();
  const cols = raw.exec(`PRAGMA table_info(actions)`)[0].values.map(r => r[1]);
  for (const c of ['id', 'user_id', 'kind', 'subject', 'data', 'confidence', 'status', 'source_type', 'source_id', 'created_at', 'resolved_at', 'parent_action_id']) {
    assert.ok(cols.includes(c), `actions.${c} missing`);
  }
});

test('phase 5 schema — reflections table has required columns', () => {
  const raw = db._raw();
  const cols = raw.exec(`PRAGMA table_info(reflections)`)[0].values.map(r => r[1]);
  for (const c of ['id', 'user_id', 'generated_at', 'window_start', 'window_end', 'briefing_md', 'action_count', 'pattern_json', 'self_critique_json', 'delivered_telegram', 'delivered_obsidian']) {
    assert.ok(cols.includes(c), `reflections.${c} missing`);
  }
});

test('phase 5 schema — prompt_versions has unique (name, version)', () => {
  const raw = db._raw();
  raw.run(`INSERT INTO prompt_versions (id, name, version, body, is_active, created_by) VALUES ('a','x',1,'b',1,'test')`);
  assert.throws(() => {
    raw.run(`INSERT INTO prompt_versions (id, name, version, body, is_active, created_by) VALUES ('c','x',1,'b',0,'test')`);
  }, /UNIQUE/);
});

test('phase 5 schema — prompt_proposals has required columns', () => {
  const raw = db._raw();
  const cols = raw.exec(`PRAGMA table_info(prompt_proposals)`)[0].values.map(r => r[1]);
  for (const c of ['id', 'prompt_name', 'base_version', 'proposed_body', 'rationale', 'replay_results_json', 'replay_error', 'status', 'created_at', 'resolved_at']) {
    assert.ok(cols.includes(c), `prompt_proposals.${c} missing`);
  }
});
