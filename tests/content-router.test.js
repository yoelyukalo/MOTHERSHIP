const test = require('node:test');
const assert = require('node:assert');
const router = require('../src/content-router');

// Helper: build a fake fetcher that returns a fake HEAD response
function fakeHead({ ok = true, contentType = '', throws = null } = {}) {
  return async (url, opts) => {
    if (throws) throw throws;
    assert.strictEqual(opts.method, 'HEAD');
    return {
      ok,
      status: ok ? 200 : 404,
      headers: { get: (k) => k.toLowerCase() === 'content-type' ? contentType : null }
    };
  };
}

test('classify — pdf by extension', async () => {
  const r = await router.classify('https://example.com/paper.pdf?ref=twitter');
  assert.strictEqual(r.kind, 'pdf');
  assert.strictEqual(r.source, 'extension');
});

test('classify — video by extension', async () => {
  const r = await router.classify('https://example.com/movie.mp4');
  assert.strictEqual(r.kind, 'video');
  assert.strictEqual(r.source, 'extension');
});

test('classify — image by extension', async () => {
  const r = await router.classify('https://example.com/photo.JPG');
  assert.strictEqual(r.kind, 'image');
  assert.strictEqual(r.source, 'extension');
});

test('classify — HEAD says pdf', async () => {
  const r = await router.classify('https://example.com/somepath', { _fetcher: fakeHead({ contentType: 'application/pdf' }) });
  assert.strictEqual(r.kind, 'pdf');
  assert.strictEqual(r.source, 'head');
  assert.strictEqual(r.contentType, 'application/pdf');
});

test('classify — HEAD says video', async () => {
  const r = await router.classify('https://example.com/stream', { _fetcher: fakeHead({ contentType: 'video/mp4' }) });
  assert.strictEqual(r.kind, 'video');
  assert.strictEqual(r.source, 'head');
});

test('classify — HEAD says image', async () => {
  const r = await router.classify('https://example.com/img', { _fetcher: fakeHead({ contentType: 'image/png' }) });
  assert.strictEqual(r.kind, 'image');
  assert.strictEqual(r.source, 'head');
});

test('classify — HEAD says html → webpage', async () => {
  const r = await router.classify('https://example.com/article', { _fetcher: fakeHead({ contentType: 'text/html; charset=utf-8' }) });
  assert.strictEqual(r.kind, 'webpage');
  assert.strictEqual(r.source, 'head');
});

test('classify — HEAD not-ok → webpage', async () => {
  const r = await router.classify('https://example.com/404', { _fetcher: fakeHead({ ok: false }) });
  assert.strictEqual(r.kind, 'webpage');
});

test('classify — HEAD throws → webpage fallback with error', async () => {
  const err = new Error('ECONNRESET');
  const r = await router.classify('https://example.com/flaky', { _fetcher: fakeHead({ throws: err }) });
  assert.strictEqual(r.kind, 'webpage');
  assert.strictEqual(r.source, 'fallback');
  assert.ok(r.error.includes('ECONNRESET'));
});

test('classify — invalid URL → webpage fallback', async () => {
  const r = await router.classify('not a url');
  assert.strictEqual(r.kind, 'webpage');
  assert.strictEqual(r.source, 'fallback');
});

test('classify — pdf extension with uppercase wins over HEAD', async () => {
  let headCalled = false;
  const r = await router.classify('https://example.com/file.PDF', { _fetcher: async () => { headCalled = true; return {}; } });
  assert.strictEqual(r.kind, 'pdf');
  assert.strictEqual(headCalled, false, 'HEAD should not be called when extension matches');
});
