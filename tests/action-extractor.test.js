const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-extractor-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const registry = require('../src/prompts/registry');
const extractor = require('../src/extractors/action-extractor');

before(async () => {
  await db.init();
  registry.seedFromHardcoded();
});

after(() => { try { fs.unlinkSync(tmpDb); } catch {} });

test('extract returns parsed candidates from mocked Claude', async () => {
  extractor._setClient({
    messages: { create: async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        candidates: [
          { kind: 'commitment', subject: 'ship mirror v2', data: { due_at: '2026-04-17' }, confidence: 0.92 },
          { kind: 'state', subject: 'exhausted', data: { dimension: 'energy', value: 3 }, confidence: 0.7 }
        ]
      }) }]
    }) }
  });
  const result = await extractor.extract({
    userText: "I'll ship mirror v2 by Friday. Exhausted today.",
    assistantText: 'noted',
    userId: 'test-user'
  });
  assert.strictEqual(result.candidates.length, 2);
  assert.strictEqual(result.candidates[0].kind, 'commitment');
  assert.strictEqual(result.candidates[1].confidence, 0.7);
});

test('extract returns empty candidates on malformed JSON', async () => {
  extractor._setClient({
    messages: { create: async () => ({
      content: [{ type: 'text', text: 'not json at all' }]
    }) }
  });
  const result = await extractor.extract({
    userText: "I'll do something with enough length to pass the guard",
    assistantText: 'ok',
    userId: 'test-user'
  });
  assert.deepStrictEqual(result.candidates, []);
});

test('extract short-circuits on short input (no API call)', async () => {
  let called = false;
  extractor._setClient({
    messages: { create: async () => { called = true; return { content: [{ type: 'text', text: '{}' }] }; } }
  });
  const result = await extractor.extract({
    userText: 'hi',
    assistantText: 'hey',
    userId: 'test-user'
  });
  assert.strictEqual(called, false);
  assert.deepStrictEqual(result.candidates, []);
});

test('extract recovers JSON from text with prose around it', async () => {
  extractor._setClient({
    messages: { create: async () => ({
      content: [{ type: 'text', text: 'Here is the JSON: { "candidates": [{"kind":"win","subject":"closed deal","data":{},"confidence":0.9}] } end.' }]
    }) }
  });
  const result = await extractor.extract({
    userText: 'I closed the Acme deal today — huge relief after months of back and forth',
    assistantText: 'congrats',
    userId: 'test-user'
  });
  assert.strictEqual(result.candidates.length, 1);
  assert.strictEqual(result.candidates[0].kind, 'win');
});

test('extract returns empty on Claude API error (no throw)', async () => {
  extractor._setClient({
    messages: { create: async () => { throw new Error('api down'); } }
  });
  const result = await extractor.extract({
    userText: 'long enough text to pass the guard threshold',
    assistantText: 'ok',
    userId: 'test-user'
  });
  assert.deepStrictEqual(result.candidates, []);
});

test('extract kill switch: ACTION_EXTRACTION_ENABLED=false skips API call', async () => {
  process.env.ACTION_EXTRACTION_ENABLED = 'false';
  let called = false;
  extractor._setClient({
    messages: { create: async () => { called = true; return { content: [{ type: 'text', text: '{}' }] }; } }
  });
  try {
    const result = await extractor.extract({
      userText: 'long enough text to normally trigger extraction',
      assistantText: 'ok',
      userId: 'test-user'
    });
    assert.strictEqual(called, false);
    assert.deepStrictEqual(result.candidates, []);
  } finally {
    delete process.env.ACTION_EXTRACTION_ENABLED;
  }
});

test('extract replaces {{userText}} and {{assistantText}} in the prompt', async () => {
  let capturedPrompt = '';
  extractor._setClient({
    messages: { create: async (opts) => {
      capturedPrompt = opts.messages[0].content;
      return { content: [{ type: 'text', text: '{"candidates":[]}' }] };
    } }
  });
  await extractor.extract({
    userText: 'SENTINEL-USER-TEXT with more than forty characters to pass the length guard',
    assistantText: 'SENTINEL-ASSISTANT-TEXT',
    userId: 'test-user'
  });
  assert.ok(capturedPrompt.includes('SENTINEL-USER-TEXT'));
  assert.ok(capturedPrompt.includes('SENTINEL-ASSISTANT-TEXT'));
  assert.ok(!capturedPrompt.includes('{{userText}}'));
  assert.ok(!capturedPrompt.includes('{{assistantText}}'));
});
