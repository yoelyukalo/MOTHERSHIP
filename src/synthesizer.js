/**
 * MOTHERSHIP — Wiki Synthesizer
 *
 * After new content is ingested, ask Claude to distill it into wiki topics,
 * using the active mirror entries as a lens for what matters to Yoel.
 */

const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');
const ve = require('./memory/vector-engine');
const { WIKI_SYNTHESIS } = require('./memory/synthesis-prompts');

const MODEL = process.env.SYNTHESIS_MODEL || 'claude-opus-4-6';
const MAX_TOKENS = 1500;

let client = null;
function _setClient(c) { client = c; }
function getClient() {
  if (client) return client;
  client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 3, timeout: 120_000 });
  return client;
}

function parseJsonFromText(text) {
  try { return JSON.parse(text.trim()); }
  catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('non-JSON synthesis');
  }
}

function mirrorSnapshotForPrompt(userId) {
  const rows = db.getMirrorEntries({ activeOnly: true, limit: 50, userId });
  if (!rows.length) return '(no profile yet)';
  const byCat = {};
  for (const r of rows) (byCat[r.category] ||= []).push(r.content);
  return Object.entries(byCat)
    .map(([k, v]) => `${k}: ${v.slice(0, 5).join('; ')}`)
    .join('\n');
}

async function synthesizeFromContent({ content, sourceId, userId }) {
  if (!userId) throw new Error('synthesizeFromContent: userId required');
  const existingTopics = db.getAllWikiEntries({ userId }).map(r => r.topic);
  const mirrorSnapshot = mirrorSnapshotForPrompt(userId);
  const prompt = WIKI_SYNTHESIS({ existingTopics, mirrorSnapshot, content });

  const c = getClient();
  const res = await c.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }]
  });
  const text = res.content.find(b => b.type === 'text')?.text || '{}';

  let parsed;
  try { parsed = parseJsonFromText(text); }
  catch (err) {
    db.log('warn', 'synthesizer', `parse failed: ${err.message}`, { text });
    return { created: 0, merged: 0 };
  }

  let created = 0, merged = 0;
  for (const topic of parsed.topics || []) {
    const existing = db.getWikiEntries({ topic: topic.topic, userId })[0];
    if (existing) {
      const mergedSources = Array.from(new Set([...(existing.source_ids || []), sourceId]));
      const mergedTags = Array.from(new Set([...(existing.tags || []), ...(topic.tags || [])]));
      await ve.updateWikiEntry(existing.id, {
        topic: topic.topic,
        summary: topic.summary,
        source_ids: mergedSources,
        tags: mergedTags
      });
      merged++;
    } else {
      await ve.storeWikiEntry({
        topic: topic.topic,
        summary: topic.summary,
        source_ids: [sourceId],
        tags: topic.tags || [],
        userId
      });
      created++;
    }
  }

  db.log('info', 'synthesizer', `wiki synthesis: +${created} new, ${merged} merged`);
  return { created, merged };
}

module.exports = { synthesizeFromContent, _setClient };
