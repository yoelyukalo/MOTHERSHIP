/**
 * MOTHERSHIP — Obsidian exporter
 *
 * Writes Mirror/, Wiki/, and _reports/ as markdown files with YAML
 * frontmatter and [[wikilinks]] between semantically-similar entries.
 */

const fs = require('fs');
const path = require('path');
const db = require('../database');
const emb = require('../memory/embeddings');
const { LAYERS: TAXONOMY_LAYERS } = require('../mirror-taxonomy');

const WIKILINK_SIM_THRESHOLD = parseFloat(process.env.WIKILINK_SIM_THRESHOLD || '0.75');

function vaultPath() {
  return process.env.OBSIDIAN_VAULT_PATH || null;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
}

function yamlFrontmatter(obj) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) {
      lines.push(`${k}: [${v.map(x => JSON.stringify(String(x))).join(', ')}]`);
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

function findWikilinks(entry, allEntries) {
  if (!entry.embedding) return [];
  const qVec = emb.fromBuffer(entry.embedding);
  const others = allEntries
    .filter(e => e.id !== entry.id && e.embedding)
    .map(e => ({ ...e, vec: emb.fromBuffer(e.embedding) }));
  return emb.findRelevant(qVec, others, 10)
    .filter(r => r.score >= WIKILINK_SIM_THRESHOLD)
    .map(r => r.topic || `${r.entry_type}/${r.id.slice(0, 6)}`);
}

function renderMirrorEntryType(entryType, layer, entries) {
  const header = yamlFrontmatter({
    type: 'mirror',
    entry_type: entryType,
    layer,
    entry_count: entries.length,
    updated: new Date().toISOString()
  });
  const body = entries.map(e => {
    const statusLine = e.status && e.status !== 'active' ? `\n- **Status:** ${e.status}` : '';
    const related = Array.isArray(e.related_ids) && e.related_ids.length
      ? `\n- **Related:** ${e.related_ids.join(', ')}`
      : '';
    return `## ${e.id.slice(0, 8)}\n- **Confidence:** ${e.confidence.toFixed(2)}\n- **Source:** ${e.source_type}${e.source_id ? ` (${e.source_id})` : ''}\n- **Updated:** ${e.updated_at}${statusLine}${related}\n\n${e.content}\n`;
  }).join('\n---\n\n');
  return header + `# Mirror — ${layer}/${entryType}\n\n${body}`;
}

function renderWikiTopic(entry, wikilinks) {
  const header = yamlFrontmatter({
    type: 'wiki',
    topic: entry.topic,
    tags: entry.tags,
    source_count: entry.source_ids.length,
    updated: entry.updated_at
  });
  const links = wikilinks.length
    ? `\n\n## Related\n${wikilinks.map(l => `- [[${l}]]`).join('\n')}`
    : '';
  const contradictions = entry.contradictions
    ? `\n\n> ⚠ **Contradictions flagged:** ${entry.contradictions}`
    : '';
  return header + `# ${entry.topic}\n\n${entry.summary}${links}${contradictions}`;
}

function renderIndex(mirrorEntryTypesByLayer, wikiEntries) {
  const lines = [
    yamlFrontmatter({ type: 'index', generated: new Date().toISOString() }),
    '# Mothership Index',
    '',
    '## Mirror'
  ];
  for (const [layer, types] of mirrorEntryTypesByLayer) {
    lines.push(`### ${layer}`);
    for (const t of types) lines.push(`- [[Mirror/${t}]]`);
  }
  lines.push('', '## Wiki');
  lines.push(...wikiEntries
    .slice()
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
    .map(e => `- [[Wiki/${sanitizeFilename(e.topic)}]] — ${e.tags.join(', ')}`));
  return lines.join('\n');
}

async function exportAll() {
  const vault = vaultPath();
  if (!vault) {
    db.log('warn', 'obsidian', 'OBSIDIAN_VAULT_PATH not set — skipping export');
    return { mirror: 0, wiki: 0, skipped: true };
  }

  const mirrorDir = path.join(vault, 'Mirror');
  const wikiDir = path.join(vault, 'Wiki');
  const reportsDir = path.join(vault, '_reports');
  ensureDir(mirrorDir);
  ensureDir(wikiDir);
  ensureDir(reportsDir);

  const allMirror = db.getMirrorEntries({ activeOnly: true, limit: 10000, allUsers: true });
  const byType = new Map();
  const typesByLayer = new Map();
  for (const e of allMirror) {
    const type = e.entry_type || 'context';
    const layer = e.layer || 'world';
    if (!byType.has(type)) byType.set(type, { layer, entries: [] });
    byType.get(type).entries.push(e);
    if (!typesByLayer.has(layer)) typesByLayer.set(layer, new Set());
    typesByLayer.get(layer).add(type);
  }
  let mirrorCount = 0;
  for (const [type, { layer, entries }] of byType) {
    const file = path.join(mirrorDir, `${sanitizeFilename(type)}.md`);
    fs.writeFileSync(file, renderMirrorEntryType(type, layer, entries), 'utf8');
    mirrorCount += entries.length;
  }

  const allWiki = db.getAllWikiEntries({ allUsers: true });
  let wikiCount = 0;
  for (const entry of allWiki) {
    const links = findWikilinks(entry, allWiki);
    const file = path.join(wikiDir, `${sanitizeFilename(entry.topic)}.md`);
    fs.writeFileSync(file, renderWikiTopic(entry, links), 'utf8');
    wikiCount++;
  }

  // Ordered [layer, [entryTypes]] pairs for the index, using canonical layer order.
  const layerPairs = TAXONOMY_LAYERS
    .filter(l => typesByLayer.has(l))
    .map(l => [l, Array.from(typesByLayer.get(l)).sort()]);

  fs.writeFileSync(
    path.join(vault, '_index.md'),
    renderIndex(layerPairs, allWiki),
    'utf8'
  );

  db.log('info', 'obsidian', `exported ${mirrorCount} mirror + ${wikiCount} wiki entries`);
  return { mirror: mirrorCount, wiki: wikiCount, skipped: false };
}

module.exports = { exportAll };
