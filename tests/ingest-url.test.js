const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-iu-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const { ingestUrl } = require('../src/ingest-url');

// Define a fake NoVideoError class; tests pass this via _ytdlp
class FakeNoVideoError extends Error {
  constructor(msg) { super(msg); this.name = 'NoVideoError'; }
}

test('ingestUrl — pdf route via extension', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });

  const fakes = {
    _router: { classify: async () => ({ kind: 'pdf', source: 'extension' }) },
    _pdf: { processPdfUrl: async (url, { source, baseMeta }) => ({
      kind: 'pdf', title: 'Test.pdf', pageCount: 5, text: 'pdf content', messageId: 'pdf-msg-1', byteSize: 1024
    }) }
  };

  const r = await ingestUrl('https://example.com/paper.pdf', fakes);
  assert.strictEqual(r.kind, 'pdf');
  assert.strictEqual(r.messageId, 'pdf-msg-1');
  assert.ok(r.display.includes('Test.pdf'));
  assert.ok(r.display.includes('5 pages'));
  assert.strictEqual(r.content, 'pdf content');
});

test('ingestUrl — video route via extension', async () => {
  const fakes = {
    _router: { classify: async () => ({ kind: 'video', source: 'extension' }) },
    _ytdlp: {
      downloadVideo: async () => ({ filePath: '/tmp/video.mp4', meta: { title: 'Cool Video', uploader: 'Alice' } }),
      NoVideoError: FakeNoVideoError
    },
    _processor: {
      processVideo: async () => ({ kind: 'video', vision: { description: 'A cat running' }, transcript: 'hello world', messageId: 'video-msg-1' })
    }
  };

  const r = await ingestUrl('https://cdn.example.com/clip.mp4', fakes);
  assert.strictEqual(r.kind, 'video');
  assert.strictEqual(r.messageId, 'video-msg-1');
  assert.ok(r.display.includes('Cool Video'));
  assert.ok(r.display.includes('Alice'));
  assert.ok(r.content.includes('hello world'));
  assert.ok(r.content.includes('A cat running'));
});

test('ingestUrl — webpage route falls to URL summary when ytdlp throws NoVideoError', async () => {
  const fakes = {
    _router: { classify: async () => ({ kind: 'webpage', source: 'head' }) },
    _ytdlp: {
      downloadVideo: async () => { throw new FakeNoVideoError('no video here'); },
      NoVideoError: FakeNoVideoError
    },
    _urlSummary: {
      processUrl: async () => ({ url: 'https://example.com/article', title: 'Test Article', description: 'A blog post', summary: 'This is the summary of the article.' })
    }
  };

  const r = await ingestUrl('https://example.com/article', fakes);
  assert.strictEqual(r.kind, 'webpage');
  assert.ok(r.messageId);
  assert.ok(r.display.includes('Test Article'));
  assert.ok(r.display.includes('summary of the article'));
  assert.strictEqual(r.content, 'This is the summary of the article.');

  // Verify the row was stored with link-summary category
  const rows = db.getMessages({ category: 'link-summary' });
  assert.ok(rows.some(row => row.metadata.title === 'Test Article'));
});

test('ingestUrl — webpage route catches a video when ytdlp succeeds', async () => {
  const fakes = {
    _router: { classify: async () => ({ kind: 'webpage', source: 'head' }) },
    _ytdlp: {
      downloadVideo: async () => ({ filePath: '/tmp/yt.mp4', meta: { title: 'YouTube Vid', uploader: 'Bob' } }),
      NoVideoError: FakeNoVideoError
    },
    _processor: {
      processVideo: async () => ({ kind: 'video', vision: { description: 'people talking' }, transcript: 'transcript text', messageId: 'yt-msg' })
    }
  };

  const r = await ingestUrl('https://youtube.com/watch?v=xyz', fakes);
  assert.strictEqual(r.kind, 'video');
  assert.strictEqual(r.messageId, 'yt-msg');
});

test('ingestUrl — webpage route propagates non-NoVideoError from ytdlp', async () => {
  const fakes = {
    _router: { classify: async () => ({ kind: 'webpage', source: 'head' }) },
    _ytdlp: {
      downloadVideo: async () => { throw new Error('network timeout'); },
      NoVideoError: FakeNoVideoError
    }
  };

  await assert.rejects(
    () => ingestUrl('https://example.com/page', fakes),
    /network timeout/
  );
});

test('ingestUrl — image route falls through to webpage summary', async () => {
  const fakes = {
    _router: { classify: async () => ({ kind: 'image', source: 'head' }) },
    _ytdlp: {
      downloadVideo: async () => { throw new FakeNoVideoError('not video'); },
      NoVideoError: FakeNoVideoError
    },
    _urlSummary: {
      processUrl: async () => ({ url: 'https://example.com/image.png', title: 'Image Preview', description: '', summary: 'An image on a page.' })
    }
  };

  const r = await ingestUrl('https://example.com/image.png', fakes);
  // Falls through to webpage handling
  assert.strictEqual(r.kind, 'webpage');
});
