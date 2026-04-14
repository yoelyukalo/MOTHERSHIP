const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-sat-drafts-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');

const db = require('../../src/database');
const drafts = require('../../src/satellites/drafts');
const users = require('../../src/auth/users');

let testUserId;

before(async () => {
  await db.init();
  testUserId = await users.createUser({ email: 'drafts-test@x', password: 'p' });
});
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test('drafts — create inserts a row with discussing status', () => {
  const id = drafts.create({ slug: 'dr-1', name: 'Draft One', kind: 'test-kind' });
  assert.ok(id);
  const row = drafts.getBySlug('dr-1');
  assert.strictEqual(row.status, 'discussing');
  assert.strictEqual(row.kind, 'test-kind');
});

test('drafts — create accepts missing kind', () => {
  drafts.create({ slug: 'dr-2', name: 'Fuzzy idea' });
  const row = drafts.getBySlug('dr-2');
  assert.strictEqual(row.kind, null);
});

test('drafts — list returns all drafts', () => {
  const all = drafts.list();
  assert.ok(all.length >= 2);
});

test('drafts — getDraftWithMessages returns linked messages', () => {
  db.addMessage('What if we build a dental satellite?', 'dashboard', 'uncategorized', { draft_slug: 'dr-1' }, testUserId);
  db.addMessage("Sure — what's the main workflow?", 'mothership', 'reply', { draft_slug: 'dr-1' }, testUserId);
  db.addMessage('Unrelated chatter', 'dashboard', 'uncategorized', {}, testUserId);

  const { draft, messages } = drafts.getDraftWithMessages('dr-1');
  assert.strictEqual(draft.slug, 'dr-1');
  assert.strictEqual(messages.length, 2);
  assert.ok(messages.find(m => m.content.includes('dental satellite')));
  assert.ok(messages.find(m => m.content.includes('main workflow')));
});

test('drafts — setBrief stores markdown and bumps updated timestamp', () => {
  drafts.setBrief('dr-1', '# Brief\n\nThis is the brief.');
  const row = drafts.getBySlug('dr-1');
  assert.ok(row.brief_md.includes('# Brief'));
  assert.ok(row.brief_updated_at);
});

test('drafts — setStatus updates status', () => {
  drafts.setStatus('dr-1', 'planned');
  assert.strictEqual(drafts.getBySlug('dr-1').status, 'planned');
});

test('drafts — linkToSatellite sets status created and fk', () => {
  drafts.linkToSatellite('dr-1', 'sat-id-fake');
  const row = drafts.getBySlug('dr-1');
  assert.strictEqual(row.status, 'created');
  assert.strictEqual(row.created_satellite_id, 'sat-id-fake');
});

test('drafts — regenerateBrief uses injected conversation and stores result', async () => {
  drafts.create({ slug: 'dr-brief', name: 'Brief Test', kind: 'test-kind' });
  db.addMessage('Some chatter about the brief test', 'dashboard', 'uncategorized', { draft_slug: 'dr-brief' }, testUserId);

  const fakeConv = {
    respond: async (prompt) => `# Synthesized\nGot prompt starting with: ${prompt.slice(0, 30)}`
  };
  const result = await drafts.regenerateBrief('dr-brief', { conversation: fakeConv });
  assert.ok(result.includes('# Synthesized'));

  const row = drafts.getBySlug('dr-brief');
  assert.ok(row.brief_md.includes('# Synthesized'));
  assert.ok(row.brief_updated_at);
});

test('drafts — regenerateBrief throws on unknown slug', async () => {
  await assert.rejects(
    drafts.regenerateBrief('does-not-exist'),
    /no such draft/
  );
});
