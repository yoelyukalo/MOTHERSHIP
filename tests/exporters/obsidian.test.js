const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDb = path.join(__dirname, `.tmp-obs-${Date.now()}.db`);
const tmpVault = path.join(os.tmpdir(), `vault-${Date.now()}`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;
process.env.OBSIDIAN_VAULT_PATH = tmpVault;

const db = require('../../src/database');
const ve = require('../../src/memory/vector-engine');
const obsidian = require('../../src/exporters/obsidian');
const users = require('../../src/auth/users');
const authRoles = require('../../src/auth/roles');

test('obsidian exporter — writes mirror + wiki markdown with frontmatter', async (t) => {
  await db.init();
  t.after(() => {
    try { fs.unlinkSync(tmpDb); } catch {}
    try { fs.rmSync(tmpVault, { recursive: true, force: true }); } catch {}
  });

  await authRoles.seedOnce(db);
  const testUserId = await users.createUser({ email: 't@x', password: 'p' });

  ve._setClient({
    embeddings: { create: async () => ({ data: [{ embedding: new Array(3).fill(0.3) }] }) }
  });

  await ve.storeMirrorEntry({
    entry_type: 'model', content: 'Thinks in systems',
    confidence: 0.9, source_type: 'conversation', source_id: 'x',
    userId: testUserId
  });
  await ve.storeWikiEntry({
    topic: 'RAG',
    summary: 'Retrieval augmented generation pairs vector search with LLMs.',
    source_ids: ['msg-a'], tags: ['ai', 'architecture'],
    userId: testUserId
  });

  const report = await obsidian.exportAll();

  // v3 exporter writes one file per entry_type (not per legacy category)
  const mirrorFile = path.join(tmpVault, 'Mirror', 'model.md');
  const wikiFile = path.join(tmpVault, 'Wiki', 'RAG.md');
  const indexFile = path.join(tmpVault, '_index.md');

  assert.ok(fs.existsSync(mirrorFile));
  assert.ok(fs.existsSync(wikiFile));
  assert.ok(fs.existsSync(indexFile));

  const wikiContent = fs.readFileSync(wikiFile, 'utf8');
  assert.ok(wikiContent.startsWith('---'));
  assert.ok(wikiContent.includes('tags:'));
  assert.ok(wikiContent.includes('Retrieval augmented generation'));

  assert.ok(report.mirror >= 1);
  assert.ok(report.wiki >= 1);
});

test('obsidian exporter — skipped when OBSIDIAN_VAULT_PATH unset', async () => {
  const saved = process.env.OBSIDIAN_VAULT_PATH;
  delete process.env.OBSIDIAN_VAULT_PATH;
  try {
    const r = await obsidian.exportAll();
    assert.strictEqual(r.skipped, true);
    assert.strictEqual(r.mirror, 0);
    assert.strictEqual(r.wiki, 0);
  } finally {
    process.env.OBSIDIAN_VAULT_PATH = saved;
  }
});
