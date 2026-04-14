/**
 * MOTHERSHIP — Dynamic Quantum Mirror
 *
 * Replaces the static-JSON mirror. After each meaningful turn, asks Claude
 * to extract what was just learned about Yoel and writes rows into
 * mirror_entries via the vector engine.
 */

const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');
const ve = require('./memory/vector-engine');
const { MIRROR_SYNTHESIS } = require('./memory/synthesis-prompts');

const MODEL = process.env.SYNTHESIS_MODEL || 'claude-opus-4-6';
const MAX_TOKENS = 1200;

let client = null;
function _setClient(c) { client = c; }
function getClient() {
  if (client) return client;
  client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxRetries: 3,
    timeout: 120_000
  });
  return client;
}

function getExistingCandidates() {
  return db.getMirrorEntries({ activeOnly: true, limit: 200 })
    .map(r => ({ id: r.id, category: r.category, content: r.content, confidence: r.confidence }));
}

function parseJsonFromText(text) {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); }
  catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Synthesis returned non-JSON: ${trimmed.slice(0, 200)}`);
  }
}

async function synthesizeFromTurn({ userText, assistantText, sourceId, forceCategory = null }) {
  const turn = `USER: ${userText}\n\nMOTHERSHIP: ${assistantText}`;
  const existing = getExistingCandidates();
  const prompt = MIRROR_SYNTHESIS({ existing, turn });

  const c = getClient();
  const res = await c.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }]
  });
  const text = res.content.find(b => b.type === 'text')?.text || '{}';
  let parsed;
  try {
    parsed = parseJsonFromText(text);
  } catch (err) {
    db.log('warn', 'quantum-mirror', `synthesis parse failed: ${err.message}`, { text });
    return { created: 0, superseded: 0 };
  }

  let created = 0;
  for (const entry of parsed.new_entries || []) {
    try {
      await ve.storeMirrorEntry({
        category: forceCategory || entry.category,
        content: entry.content,
        confidence: entry.confidence ?? 0.6,
        source_type: 'conversation',
        source_id: sourceId
      });
      created++;
    } catch (err) {
      db.log('error', 'quantum-mirror', `storeMirrorEntry failed: ${err.message}`);
    }
  }

  let superseded = 0;
  for (const s of parsed.supersede || []) {
    try {
      const old = db.getMirrorEntries({ activeOnly: true, limit: 10000 }).find(r => r.id === s.old_id);
      if (!old) continue;
      await ve.supersedeMirrorEntry(s.old_id, {
        category: old.category,
        content: s.new_content,
        confidence: s.new_confidence ?? old.confidence,
        source_type: 'conversation',
        source_id: sourceId
      });
      superseded++;
    } catch (err) {
      db.log('error', 'quantum-mirror', `supersede failed: ${err.message}`);
    }
  }

  db.log('info', 'quantum-mirror', `synthesis: +${created} new, ${superseded} superseded`);
  return { created, superseded };
}

module.exports = { synthesizeFromTurn, _setClient };
