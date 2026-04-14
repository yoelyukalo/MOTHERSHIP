const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const tmpDb = path.join(__dirname, `.tmp-proc-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const processor = require('../src/processor');
const users = require('../src/auth/users');
const authRoles = require('../src/auth/roles');
const systemOwner = require('../src/auth/system-owner');

test('kindFor — detects pdf', () => {
  assert.strictEqual(processor.kindFor('/tmp/paper.pdf'), 'pdf');
  assert.strictEqual(processor.kindFor('/tmp/PAPER.PDF'), 'pdf');
});

test('kindFor — detects audio', () => {
  assert.strictEqual(processor.kindFor('/tmp/song.mp3'), 'audio');
  assert.strictEqual(processor.kindFor('/tmp/voice.ogg'), 'audio');
  assert.strictEqual(processor.kindFor('/tmp/note.m4a'), 'audio');
});

test('kindFor — detects text', () => {
  assert.strictEqual(processor.kindFor('/tmp/notes.md'), 'text');
  assert.strictEqual(processor.kindFor('/tmp/data.json'), 'text');
  assert.strictEqual(processor.kindFor('/tmp/log.txt'), 'text');
});

test('kindFor — returns null for unknown', () => {
  assert.strictEqual(processor.kindFor('/tmp/file.xyz'), null);
});

test('processText — reads file and stores content', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });

  // Seed a mothership_admin so getSystemOwnerId() resolves for untethered pipelines
  await authRoles.seedOnce(db);
  const adminId = await users.createUser({ email: 'admin@test', password: 'pass' });
  const raw = db._raw();
  const stmt = raw.prepare("SELECT id FROM roles WHERE name = 'mothership_admin'");
  stmt.step();
  const adminRoleId = stmt.getAsObject().id;
  stmt.free();
  raw.run(
    `INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id)
     VALUES (?, 'user', ?, ?, NULL)`,
    [uuidv4(), adminId, adminRoleId]
  );
  db.save();
  systemOwner.clearCache();

  const tmpFile = path.join(os.tmpdir(), `test-text-${Date.now()}.md`);
  fs.writeFileSync(tmpFile, '# Test Note\n\nSome markdown content here.');
  t.after(() => { try { fs.unlinkSync(tmpFile); } catch {} });

  const r = await processor.processText(tmpFile, { source: 'file-drop', baseMeta: { tag: 'test' } });
  assert.strictEqual(r.kind, 'text');
  assert.ok(r.content.includes('Some markdown content'));
  assert.ok(r.messageId);
  assert.strictEqual(r.title, path.basename(tmpFile));

  const rows = db.getMessages({ category: 'text-file', allUsers: true });
  assert.ok(rows.some(row => row.content.includes('Test Note')));

  const actions = db.getActions({ userId: adminId, kind: 'mothership_categorize' });
  assert.ok(actions.length >= 1, 'mothership_categorize action not logged');
});

test('processText — truncates oversized content in DB but returns full text', async (t) => {
  const tmpFile = path.join(os.tmpdir(), `big-text-${Date.now()}.txt`);
  const big = 'x'.repeat(60000);
  fs.writeFileSync(tmpFile, big);
  t.after(() => { try { fs.unlinkSync(tmpFile); } catch {} });

  const r = await processor.processText(tmpFile, { source: 'file-drop' });
  assert.strictEqual(r.content.length, 60000); // full content in return value

  const rows = db.getMessages({ category: 'text-file', allUsers: true });
  const thisRow = rows.find(row => row.metadata.filename === path.basename(tmpFile));
  assert.ok(thisRow);
  assert.strictEqual(thisRow.metadata.text_truncated, true); // JSON round-trips true as true
  // Stored content should be <= 40000 chars + wrapper prefix
  assert.ok(thisRow.content.length < 50000);
});

test('processFile — dispatches text files correctly', async (t) => {
  const tmpFile = path.join(os.tmpdir(), `dispatch-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, 'dispatch test');
  t.after(() => { try { fs.unlinkSync(tmpFile); } catch {} });

  const r = await processor.processFile(tmpFile, { source: 'file-drop' });
  assert.strictEqual(r.kind, 'text');
  assert.ok(r.messageId);
});

test('processFile — returns null for unknown file types', async (t) => {
  const tmpFile = path.join(os.tmpdir(), `unknown-${Date.now()}.xyz`);
  fs.writeFileSync(tmpFile, 'mystery');
  t.after(() => { try { fs.unlinkSync(tmpFile); } catch {} });

  const r = await processor.processFile(tmpFile, { source: 'file-drop' });
  assert.strictEqual(r, null);
});
