/**
 * MOTHERSHIP — Weekly health check
 *
 * Three passes:
 * 1. Contradiction scan  (Claude)
 * 2. Confidence decay    (deterministic)
 * 3. Gap analysis        (Claude)
 *
 * Writes _reports/health_YYYY-MM-DD.md to the Obsidian vault and returns
 * a summary usable by Telegram notifications.
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const db = require('./database');
const { HEALTH_CONTRADICTIONS, GAP_ANALYSIS } = require('./memory/synthesis-prompts');

const MODEL = process.env.SYNTHESIS_MODEL || 'claude-opus-4-6';
const DECAY_AFTER_DAYS = parseInt(process.env.DECAY_AFTER_DAYS || '30', 10);
const DECAY_STEP = parseFloat(process.env.DECAY_STEP || '0.1');
const MIN_CONFIDENCE = parseFloat(process.env.MIN_CONFIDENCE || '0.2');

let client = null;
function _setClient(c) { client = c; }
function getClient() {
  if (client) return client;
  client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 3, timeout: 120_000 });
  return client;
}

function daysSince(iso) {
  return (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24);
}

function parseJsonFromText(text) {
  try { return JSON.parse(text.trim()); }
  catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    return null;
  }
}

async function decayStale() {
  const rows = db.getMirrorEntries({ activeOnly: true, limit: 10000 });
  let decayed = 0;
  for (const r of rows) {
    if (daysSince(r.updated_at) >= DECAY_AFTER_DAYS) {
      const next = Math.max(MIN_CONFIDENCE, r.confidence - DECAY_STEP);
      if (next < r.confidence) {
        db.updateMirrorEntryConfidence(r.id, next, { skipSave: true });
        decayed++;
      }
    }
  }
  if (decayed > 0) db.save();
  return decayed;
}

async function scanContradictions() {
  const rows = db.getMirrorEntries({ activeOnly: true, limit: 200 });
  if (rows.length < 2) return [];
  const c = getClient();
  const res = await c.messages.create({
    model: MODEL,
    max_tokens: 1500,
    messages: [{ role: 'user', content: HEALTH_CONTRADICTIONS({ entries: rows }) }]
  });
  const text = res.content.find(b => b.type === 'text')?.text || '{}';
  const parsed = parseJsonFromText(text) || { contradictions: [] };
  return parsed.contradictions || [];
}

async function gapAnalysis() {
  const rows = db.getMirrorEntries({ activeOnly: true, limit: 200 });
  const wiki = db.getAllWikiEntries().map(w => w.topic);
  const snapshot = rows.map(r => `- [${r.category}] ${r.content}`).join('\n');
  const c = getClient();
  const res = await c.messages.create({
    model: MODEL,
    max_tokens: 1200,
    messages: [{ role: 'user', content: GAP_ANALYSIS({ mirror: snapshot, wikiTopics: wiki }) }]
  });
  const text = res.content.find(b => b.type === 'text')?.text || '{}';
  return parseJsonFromText(text) || { knowledge_gaps: [], thin_mirror_categories: [] };
}

function writeReport(summary) {
  const vault = process.env.OBSIDIAN_VAULT_PATH;
  if (!vault) return null;
  const dir = path.join(vault, '_reports');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filename = `health_${new Date().toISOString().slice(0, 10)}.md`;
  const file = path.join(dir, filename);
  const body = [
    '---',
    `type: health_report`,
    `generated: ${new Date().toISOString()}`,
    '---',
    `# Health Report — ${new Date().toISOString().slice(0, 10)}`,
    '',
    `## Summary`,
    `- Contradictions: ${summary.contradictions}`,
    `- Decayed entries: ${summary.decayed}`,
    `- Knowledge gaps: ${summary.gaps}`,
    '',
    `## Contradictions`,
    ...(summary.contradictionDetail || []).map(c => `- ${c.note} (entries: ${(c.entry_ids || []).join(', ')})`),
    '',
    `## Knowledge gaps`,
    ...(summary.gapDetail?.knowledge_gaps || []).map(g => `- ${g.gap} — ${g.why_it_matters}`),
    '',
    `## Thin mirror categories`,
    ...(summary.gapDetail?.thin_mirror_categories || []).map(t => `- ${t.category}: ${t.suggestion}`)
  ].join('\n');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

async function runNow() {
  const decayed = await decayStale();
  let contradictions = [];
  let gapDetail = { knowledge_gaps: [], thin_mirror_categories: [] };

  try { contradictions = await scanContradictions(); }
  catch (err) { db.log('warn', 'healthcheck', `contradiction scan failed: ${err.message}`); }

  try { gapDetail = await gapAnalysis(); }
  catch (err) { db.log('warn', 'healthcheck', `gap analysis failed: ${err.message}`); }

  const summary = {
    decayed,
    contradictions: contradictions.length,
    contradictionDetail: contradictions,
    gaps: gapDetail.knowledge_gaps?.length || 0,
    gapDetail
  };
  const reportFile = writeReport(summary);
  db.log('info', 'healthcheck', `run complete: ${decayed} decayed, ${contradictions.length} contradictions, ${summary.gaps} gaps`, { reportFile });
  return summary;
}

let intervalHandle = null;
function start() {
  const hours = parseFloat(process.env.HEALTH_CHECK_INTERVAL_HOURS || '168'); // weekly
  const ms = hours * 60 * 60 * 1000;
  intervalHandle = setInterval(() => {
    runNow().catch(err => db.log('error', 'healthcheck', `scheduled run failed: ${err.message}`));
  }, ms);
  if (intervalHandle.unref) intervalHandle.unref(); // don't keep node alive just for this
  db.log('info', 'healthcheck', `scheduled every ${hours}h`);
}
function stop() { if (intervalHandle) clearInterval(intervalHandle); intervalHandle = null; }

module.exports = { runNow, start, stop, _setClient };
