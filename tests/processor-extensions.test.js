const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDb = path.join(__dirname, `.tmp-proc-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const processor = require('../src/processor');

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

  const tmpFile = path.join(os.tmpdir(), `test-text-${Date.now()}.md`);
  fs.writeFileSync(tmpFile, '# Test Note\n\nSome markdown content here.');
  t.after(() => { try { fs.unlinkSync(tmpFile); } catch {} });

  const r = await processor.processText(tmpFile, { source: 'file-drop', baseMeta: { tag: 'test' } });
  assert.strictEqual(r.kind, 'text');
  assert.ok(r.content.includes('Some markdown content'));
  assert.ok(r.messageId);
  assert.strictEqual(r.title, path.basename(tmpFile));

  const rows = db.getMessages({ category: 'text-file' });
  assert.ok(rows.some(row => row.content.includes('Test Note')));
});

test('processText — truncates oversized content in DB but returns full text', async (t) => {
  const tmpFile = path.join(os.tmpdir(), `big-text-${Date.now()}.txt`);
  const big = 'x'.repeat(60000);
  fs.writeFileSync(tmpFile, big);
  t.after(() => { try { fs.unlinkSync(tmpFile); } catch {} });

  const r = await processor.processText(tmpFile, { source: 'file-drop' });
  assert.strictEqual(r.content.length, 60000); // full content in return value

  const rows = db.getMessages({ category: 'text-file' });
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
