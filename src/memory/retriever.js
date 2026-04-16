/**
 * MOTHERSHIP — Retrieval orchestrator
 *
 * Single entry point for "give me the top-k most relevant mirror + wiki
 * entries for this query" and format them into a system-prompt block.
 */

const ve = require('./vector-engine');

async function retrieve(query, { mirrorTopK = 5, wikiTopK = 5, userId = null } = {}) {
  if (!userId) throw new Error('retrieve: userId required');
  const [mirror, wiki] = await Promise.all([
    ve.searchMirror(query, { topK: mirrorTopK, userId }),
    ve.searchWiki(query, { topK: wikiTopK, userId })
  ]);
  return { mirror, wiki };
}

const { LAYERS } = require('../mirror-taxonomy');

function formatMirrorSection(entries) {
  if (!entries.length) return '';
  // Grouping by layer → entry_type preserves the taxonomy shape in the
  // injected context, so Claude sees the structure, not a flat list.
  const byLayer = new Map();
  for (const e of entries) {
    const layer = e.layer || 'world';
    const type = e.entry_type || 'context';
    if (!byLayer.has(layer)) byLayer.set(layer, new Map());
    const byType = byLayer.get(layer);
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(e);
  }
  const lines = ['## Mirror — what I know about Yoel (most relevant to this turn)'];
  for (const layer of LAYERS) {
    const byType = byLayer.get(layer);
    if (!byType) continue;
    lines.push(`### ${layer}`);
    for (const [type, list] of byType) {
      lines.push(`**${type}**`);
      for (const e of list) {
        lines.push(`- (${e.confidence.toFixed(2)}) ${e.content}`);
      }
    }
  }
  return lines.join('\n');
}

function formatWikiSection(entries) {
  if (!entries.length) return '';
  const lines = ['## Wiki — knowledge Mothership has synthesized (most relevant to this turn)'];
  for (const e of entries) {
    lines.push(`### ${e.topic}`);
    lines.push(e.summary);
  }
  return lines.join('\n');
}

async function buildContextBlock(query, opts = {}) {
  if (!opts.userId) throw new Error('buildContextBlock: userId required');
  const { mirror, wiki } = await retrieve(query, opts);
  return [formatMirrorSection(mirror), formatWikiSection(wiki)].filter(Boolean).join('\n\n');
}

module.exports = { retrieve, buildContextBlock, formatMirrorSection, formatWikiSection };
