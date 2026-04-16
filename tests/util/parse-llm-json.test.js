const test = require('node:test');
const assert = require('node:assert');
const { parseLlmJson } = require('../../src/util/parse-llm-json');

test('parseLlmJson — plain JSON object', () => {
  const r = parseLlmJson('{"a":1,"b":"x"}');
  assert.deepStrictEqual(r, { a: 1, b: 'x' });
});

test('parseLlmJson — leading/trailing whitespace', () => {
  const r = parseLlmJson('\n  {"a":1}  \n');
  assert.deepStrictEqual(r, { a: 1 });
});

test('parseLlmJson — wrapped in ```json fence', () => {
  const body = '```json\n{"briefing_md": "## Today\\n\\nHere we go."}\n```';
  const r = parseLlmJson(body);
  assert.strictEqual(r.briefing_md, '## Today\n\nHere we go.');
});

test('parseLlmJson — wrapped in plain ``` fence', () => {
  const body = '```\n{"x":42}\n```';
  assert.deepStrictEqual(parseLlmJson(body), { x: 42 });
});

test('parseLlmJson — fenced with inline backtick content', () => {
  const obj = { briefing_md: 'Use `git status` to see state.' };
  const body = '```json\n' + JSON.stringify(obj) + '\n```';
  assert.deepStrictEqual(parseLlmJson(body), obj);
});

test('parseLlmJson — JSON buried inside prose', () => {
  const body = 'Here is your JSON:\n\n{"topics":[{"topic":"X","summary":"y"}]}';
  assert.deepStrictEqual(
    parseLlmJson(body),
    { topics: [{ topic: 'X', summary: 'y' }] }
  );
});

test('parseLlmJson — null for empty input', () => {
  assert.strictEqual(parseLlmJson(''), null);
  assert.strictEqual(parseLlmJson(null), null);
  assert.strictEqual(parseLlmJson(undefined), null);
  assert.strictEqual(parseLlmJson('   '), null);
});

test('parseLlmJson — null for genuinely malformed content', () => {
  assert.strictEqual(parseLlmJson('this is not JSON at all'), null);
  assert.strictEqual(parseLlmJson('{ broken: '), null);
});

test('parseLlmJson — handles fenced output with trailing commentary', () => {
  // The fence regex anchors to end-of-string, so trailing commentary outside
  // the fence falls into the generic brace-extractor path.
  const body = '```json\n{"ok":true}\n```\n\nLet me know if you want more detail.';
  // This specific shape is NOT handled by the fence path (anchor mismatch),
  // but the brace fallback should still extract {"ok":true}.
  assert.deepStrictEqual(parseLlmJson(body), { ok: true });
});
