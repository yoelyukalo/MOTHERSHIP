const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const tmpDb = path.join(__dirname, `.tmp-pdf-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const pdf = require('../src/pdf');
const users = require('../src/auth/users');
const authRoles = require('../src/auth/roles');
const systemOwner = require('../src/auth/system-owner');

// Fake PDFParse class for tests — mirrors the real v2 API
function makeFakeParser({ text = 'hello pdf world', pages = 3 } = {}) {
  return class FakePDFParse {
    constructor(opts) { this.data = opts.data; this.destroyed = false; }
    async getText() {
      return { text, total: pages, pages: [{ num: 1, text }] };
    }
    async destroy() { this.destroyed = true; }
  };
}

test('parsePdfBuffer — extracts text and page count via injected parser', async (t) => {
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

  const FakeParser = makeFakeParser({ text: 'test content', pages: 5 });
  const result = await pdf.parsePdfBuffer(Buffer.from('fake-pdf-bytes'), { _Parser: FakeParser });
  assert.strictEqual(result.text, 'test content');
  assert.strictEqual(result.pageCount, 5);
  assert.ok(Array.isArray(result.pages));
});

test('processPdfUrl — downloads, parses, stores to DB', async () => {
  const fakeBuf = Buffer.from('%PDF-1.4 fake');
  const fakeFetcher = async (url, opts) => ({
    ok: true,
    status: 200,
    headers: { get: (k) => k.toLowerCase() === 'content-length' ? String(fakeBuf.length) : null },
    arrayBuffer: async () => fakeBuf.buffer.slice(fakeBuf.byteOffset, fakeBuf.byteOffset + fakeBuf.byteLength)
  });

  const FakeParser = makeFakeParser({ text: 'URL PDF content', pages: 7 });
  const r = await pdf.processPdfUrl('https://example.com/paper.pdf', {
    source: 'telegram',
    baseMeta: { tag: 'test' },
    _fetcher: fakeFetcher,
    _Parser: FakeParser
  });

  assert.strictEqual(r.kind, 'pdf');
  assert.strictEqual(r.pageCount, 7);
  assert.strictEqual(r.text, 'URL PDF content');
  assert.ok(r.messageId);
  assert.strictEqual(r.title, 'paper.pdf');

  const rows = db.getMessages({ category: 'pdf-summary', allUsers: true });
  assert.strictEqual(rows.length, 1);
  assert.ok(rows[0].content.includes('URL PDF content'));
  assert.ok(rows[0].content.includes('7 pages'));
  assert.strictEqual(rows[0].metadata.page_count, 7);
  assert.strictEqual(rows[0].metadata.source_url, 'https://example.com/paper.pdf');
});

test('processPdfUrl — rejects oversized content-length', async () => {
  const fakeFetcher = async () => ({
    ok: true,
    status: 200,
    headers: { get: (k) => k.toLowerCase() === 'content-length' ? String(200 * 1024 * 1024) : null }, // 200MB
    arrayBuffer: async () => Buffer.alloc(0).buffer
  });

  await assert.rejects(
    () => pdf.processPdfUrl('https://example.com/huge.pdf', { _fetcher: fakeFetcher, _Parser: makeFakeParser() }),
    /too large/i
  );
});

test('processPdfUrl — rejects HTTP errors', async () => {
  const fakeFetcher = async () => ({
    ok: false,
    status: 404,
    headers: { get: () => null },
    arrayBuffer: async () => Buffer.alloc(0).buffer
  });

  await assert.rejects(
    () => pdf.processPdfUrl('https://example.com/missing.pdf', { _fetcher: fakeFetcher, _Parser: makeFakeParser() }),
    /HTTP 404/
  );
});

test('processPdfFile — reads local file, parses, stores to DB', async (t) => {
  const tmpPdf = path.join(os.tmpdir(), `test-pdf-${Date.now()}.pdf`);
  fs.writeFileSync(tmpPdf, Buffer.from('%PDF-1.4 fake local'));
  t.after(() => { try { fs.unlinkSync(tmpPdf); } catch {} });

  const FakeParser = makeFakeParser({ text: 'local file text', pages: 2 });
  const r = await pdf.processPdfFile(tmpPdf, { source: 'file-drop', _Parser: FakeParser });

  assert.strictEqual(r.kind, 'pdf');
  assert.strictEqual(r.pageCount, 2);
  assert.strictEqual(r.text, 'local file text');
  assert.ok(r.messageId);
  assert.strictEqual(r.title, path.basename(tmpPdf));

  const rows = db.getMessages({ category: 'pdf-summary', allUsers: true });
  // Includes rows from previous test — find by title
  const thisRow = rows.find(r => r.metadata.title === path.basename(tmpPdf));
  assert.ok(thisRow);
  assert.strictEqual(thisRow.metadata.filepath, tmpPdf);
});

test('parsePdfBuffer — destroys parser even when getText throws', async () => {
  let destroyed = false;
  class ThrowingParser {
    constructor(opts) { this.data = opts.data; }
    async getText() { throw new Error('parse failed'); }
    async destroy() { destroyed = true; }
  }

  await assert.rejects(
    () => pdf.parsePdfBuffer(Buffer.from('fake'), { _Parser: ThrowingParser }),
    /parse failed/
  );
  assert.strictEqual(destroyed, true);
});
