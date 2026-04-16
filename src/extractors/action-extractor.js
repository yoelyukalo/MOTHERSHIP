/**
 * MOTHERSHIP — Action Extractor
 *
 * LLM pass that turns a conversation turn into structured action candidates.
 * Called by action-logger.logActionFromTurn() after each qualifying
 * postResponse hook.
 *
 * Uses claude-haiku-4-5 by default (much cheaper than the opus call running
 * for the reply itself). Swappable via _setClient() for tests.
 *
 * Short-circuit guards: skip if userText < MIN_TEXT_LENGTH, skip if
 * ACTION_EXTRACTION_ENABLED=false (cost runaway kill switch), return
 * empty candidates on any failure path — we NEVER throw because this
 * runs after a user reply has already shipped.
 */

const Anthropic = require('@anthropic-ai/sdk');
const db = require('../database');
const prompts = require('../prompts/registry');
const { parseLlmJson } = require('../util/parse-llm-json');

const MODEL = process.env.ACTION_EXTRACTOR_MODEL || 'claude-haiku-4-5';
const MAX_TOKENS = 800;
const MIN_TEXT_LENGTH = parseInt(process.env.ACTION_MIN_CHARS || '40', 10);

let client = null;
function _setClient(c) { client = c; }
function getClient() {
  if (client) return client;
  client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxRetries: 2,
    timeout: 60_000
  });
  return client;
}

function buildPrompt({ userText, assistantText }) {
  const template = prompts.getPrompt('extractor.actions');
  return template
    .replace('{{userText}}', userText || '')
    .replace('{{assistantText}}', assistantText || '');
}

async function extract({ userText, assistantText, userId }) {
  if (!userText || userText.length < MIN_TEXT_LENGTH) {
    return { candidates: [] };
  }
  if (process.env.ACTION_EXTRACTION_ENABLED === 'false') {
    return { candidates: [] };
  }

  try {
    const c = getClient();
    const prompt = buildPrompt({ userText, assistantText });
    const res = await c.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = res.content.find(b => b.type === 'text')?.text || '{}';
    const parsed = parseLlmJson(text);
    if (!parsed || !Array.isArray(parsed.candidates)) {
      try { db.log('warn', 'action-extractor', 'non-JSON response', { sample: text.slice(0, 200) }); } catch {}
      return { candidates: [] };
    }
    return { candidates: parsed.candidates };
  } catch (err) {
    try { db.log('error', 'action-extractor', err.message); } catch {}
    return { candidates: [] };
  }
}

module.exports = { extract, _setClient };
