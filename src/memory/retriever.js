/**
 * MOTHERSHIP — Retrieval orchestrator
 *
 * Single entry point for "give me the top-k most relevant mirror + wiki
 * entries for this query" and format them into a system-prompt block.
 */

const ve = require('./vector-engine');

async function retrieve(query, { mirrorTopK = 5, wikiTopK = 5 } = {}) {
  const [mirror, wiki] = await Promise.all([
    ve.searchMirror(query, { topK: mirrorTopK }),
    ve.searchWiki(query, { topK: wikiTopK })
  ]);
  return { mirror, wiki };
}

function formatMirrorSection(entries) {
  if (!entries.length) return '';
  const byCat = new Map();
  for (const e of entries) {
    if (!byCat.has(e.category)) byCat.set(e.category, []);
    byCat.get(e.category).push(e);
  }
  const lines = ['## Mirror — what I know about Yoel (most relevant to this turn)'];
  for (const [cat, list] of byCat) {
    lines.push(`### ${cat}`);
    for (const e of list) {
      lines.push(`- (${e.confidence.toFixed(2)}) ${e.content}`);
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
  const { mirror, wiki } = await retrieve(query, opts);
  return [formatMirrorSection(mirror), formatWikiSection(wiki)].filter(Boolean).join('\n\n');
}

module.exports = { retrieve, buildContextBlock, formatMirrorSection, formatWikiSection };
