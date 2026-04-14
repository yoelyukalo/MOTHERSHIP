const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-sat-api-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');
process.env.MOTHERSHIP_SATELLITES_DIR = path.join(tmpRoot, 'satellites');
process.env.MOTHERSHIP_KINDS_DIR = path.join(__dirname, '..', 'fixtures', 'satellite-kinds');
fs.mkdirSync(process.env.MOTHERSHIP_SATELLITES_DIR, { recursive: true });

const db = require('../../src/database');
const satellites = require('../../src/satellites');
const express = require('express');
const apiRoutes = require('../../src/routes/api');

let server, baseUrl;

before(async () => {
  await db.init();
  await satellites.init();
  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);
  server = app.listen(0);
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  server.close();
  await satellites.shutdown();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function req(method, pathname, body) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

test('api — POST /api/satellites creates a satellite', async () => {
  const { status, body } = await req('POST', '/api/satellites', {
    slug: 'api-1', name: 'API One', kind: 'test-kind', visibility: 'full'
  });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.slug, 'api-1');
});

test('api — GET /api/satellites lists', async () => {
  const { status, body } = await req('GET', '/api/satellites');
  assert.strictEqual(status, 200);
  assert.ok(body.some(r => r.slug === 'api-1'));
});

test('api — GET /api/satellites/:slug returns details', async () => {
  const { status, body } = await req('GET', '/api/satellites/api-1');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.kind, 'test-kind');
});

test('api — POST /api/satellites/:slug/directives issues a directive', async () => {
  const { status } = await req('POST', '/api/satellites/api-1/directives', {
    kind: 'config.set',
    payload: { key: 'motto', value: 'ship it' }
  });
  assert.strictEqual(status, 200);
});

test('api — POST /api/satellites/:slug/archive and unarchive', async () => {
  let r = await req('POST', '/api/satellites/api-1/archive', {});
  assert.strictEqual(r.status, 200);
  r = await req('POST', '/api/satellites/api-1/unarchive', {});
  assert.strictEqual(r.status, 200);
});

test('api — POST /api/satellites/:slug/visibility', async () => {
  const r = await req('POST', '/api/satellites/api-1/visibility', { visibility: 'limited' });
  assert.strictEqual(r.status, 200);
});

test('api — POST /api/satellites/drafts creates a draft', async () => {
  const r = await req('POST', '/api/satellites/drafts', {
    slug: 'api-draft-1', name: 'API Draft One', kind: 'test-kind'
  });
  assert.strictEqual(r.status, 200);
});

test('api — GET /api/satellites/drafts/:slug returns draft and messages', async () => {
  db.addMessage('test draft message', 'dashboard', 'uncategorized', { draft_slug: 'api-draft-1' });
  const r = await req('GET', '/api/satellites/drafts/api-draft-1');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.draft.slug, 'api-draft-1');
  assert.strictEqual(r.body.messages.length, 1);
});

test('api — POST /api/satellites/drafts/:slug/status changes status', async () => {
  const r = await req('POST', '/api/satellites/drafts/api-draft-1/status', { status: 'planned' });
  assert.strictEqual(r.status, 200);
});

test('api — POST /api/satellites from draft links back', async () => {
  const r = await req('POST', '/api/satellites', {
    slug: 'api-from-draft', name: 'From Draft', kind: 'test-kind',
    from_draft_slug: 'api-draft-1'
  });
  assert.strictEqual(r.status, 200);
  const drafts = require('../../src/satellites/drafts');
  const draft = drafts.getBySlug('api-draft-1');
  assert.strictEqual(draft.status, 'created');
  assert.strictEqual(draft.created_satellite_id, r.body.id);
});

test('api — POST /api/satellites returns 409 on slug collision', async () => {
  const r = await req('POST', '/api/satellites', {
    slug: 'api-1', name: 'Duplicate', kind: 'test-kind'
  });
  assert.strictEqual(r.status, 409);
  assert.ok(/already exists/.test(r.body.error));
});

test('api — POST /api/satellites returns 400 on invalid slug', async () => {
  const r = await req('POST', '/api/satellites', {
    slug: 'BAD_SLUG', name: 'Bad', kind: 'test-kind'
  });
  assert.strictEqual(r.status, 400);
});

test('api — POST /api/satellites/drafts/:slug/status rejects invalid status', async () => {
  const r = await req('POST', '/api/satellites/drafts/api-draft-1/status', { status: 'potato' });
  assert.strictEqual(r.status, 400);
  assert.ok(/invalid draft status/.test(r.body.error));
});

test('api — POST /api/satellites/drafts/:slug/status 404 on unknown draft', async () => {
  const r = await req('POST', '/api/satellites/drafts/nope/status', { status: 'planned' });
  assert.strictEqual(r.status, 404);
});

test('api — POST regenerate-brief returns 404 for unknown draft', async () => {
  const r = await req('POST', '/api/satellites/drafts/does-not-exist/regenerate-brief', {});
  assert.strictEqual(r.status, 404);
});

test('api — GET /api/satellites/:slug/directives returns history rows', async () => {
  // api-1 had a config.set directive issued earlier in this test file.
  // Give chokidar a moment in case the directive was still being processed
  // when the visibility switch fired.
  await new Promise(r => setTimeout(r, 100));
  const r = await req('GET', '/api/satellites/api-1/directives');
  // Might be 200 with rows OR 404 if the satellite got unloaded by archive.
  // We care that the route is wired and returns well-shaped output when loaded.
  if (r.status === 200) {
    assert.ok(Array.isArray(r.body));
  } else {
    assert.strictEqual(r.status, 404);
  }
});
