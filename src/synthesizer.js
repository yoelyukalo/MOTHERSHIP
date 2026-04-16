/**
 * MOTHERSHIP — Wiki Synthesizer
 *
 * After new content is ingested, ask Claude to distill it into wiki topics,
 * using the active mirror entries as a lens for what matters to Yoel.
 */

/*
 * Note on prompt sourcing: WIKI_SYNTHESIS is a template function that
 * takes { existing, turn } and returns a string. The Phase 5 prompt
 * registry stores only text bodies, not callable templates, so this module
 * imports WIKI_SYNTHESIS directly from ./memory/synthesis-prompts and
 * calls it at runtime. The registry entry for 'synthesis.wiki' holds
 * the .toString() of the function for reflection-agent text diffing only —
 * approving a proposal to 'synthesis.wiki' creates a new prompt_versions
 * row but does NOT change this module's runtime behavior until the
 * template is migrated to a plain text body with {{}} placeholders.
 */

const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');
const ve = require('./memory/vector-engine');
const { WIKI_SYNTHESIS } = require('./memory/synthesis-prompts');
const { logAction } = require('./action-logger');
const { parseLlmJson } = require('./util/parse-llm-json');

const MODEL = process.env.SYNTHESIS_MODEL || 'claude-opus-4-6';
const MAX_TOKENS = 1500;

let client = null;
function _setClient(c) { client = c; }
function getClient() {
  if (client) return client;
  client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 3, timeout: 120_000 });
  return client;
}

function mirrorSnapshotForPrompt(userId) {
  const rows = db.getMirrorEntries({ activeOnly: true, limit: 50, userId });
  if (!rows.length) return '(no profile yet)';
  const byType = {};
  for (const r of rows) (byType[r.entry_type] ||= []).push(r.content);
  return Object.entries(byType)
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

  const parsed = parseLlmJson(text);
  if (!parsed) {
    db.log('warn', 'synthesizer', 'parse failed', { head: text.slice(0, 500) });
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
  try {
    logAction({
      kind: 'mothership_synthesis',
      subject: `wiki synthesis: +${created} new, ${merged} merged`,
      data: { created, merged, prompt_version: 'synthesis.wiki' },
      sourceType: 'hook',
      sourceId,
      userId
    });
  } catch {}
  return { created, merged };
}

module.exports = { synthesizeFromContent, _setClient };
