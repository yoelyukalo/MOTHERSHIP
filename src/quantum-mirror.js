/**
 * MOTHERSHIP — Dynamic Quantum Mirror
 *
 * Replaces the static-JSON mirror. After each meaningful turn, asks Claude
 * to extract what was just learned about Yoel and writes rows into
 * mirror_entries via the vector engine.
 */

/*
 * Note on prompt sourcing: MIRROR_SYNTHESIS is a template function that
 * takes { existing, turn } and returns a string. The Phase 5 prompt
 * registry stores only text bodies, not callable templates, so this module
 * imports MIRROR_SYNTHESIS directly from ./memory/synthesis-prompts and
 * calls it at runtime. The registry entry for 'synthesis.mirror' holds
 * the .toString() of the function for reflection-agent text diffing only —
 * approving a proposal to 'synthesis.mirror' creates a new prompt_versions
 * row but does NOT change this module's runtime behavior until the
 * template is migrated to a plain text body with {{}} placeholders.
 */

const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');
const ve = require('./memory/vector-engine');
const { MIRROR_SYNTHESIS } = require('./memory/synthesis-prompts');
const { logAction } = require('./action-logger');
const { parseLlmJson } = require('./util/parse-llm-json');

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

function getExistingCandidates(userId) {
  return db.getMirrorEntries({ activeOnly: true, limit: 200, userId })
    .map(r => ({
      id: r.id,
      entry_type: r.entry_type,
      layer: r.layer,
      content: r.content,
      confidence: r.confidence
    }));
}

async function synthesizeFromTurn({ userText, assistantText, sourceId, forceEntryType = null, userId }) {
  if (!userId) throw new Error('synthesizeFromTurn: userId required');
  const turn = `USER: ${userText}\n\nMOTHERSHIP: ${assistantText}`;
  const existing = getExistingCandidates(userId);
  const prompt = MIRROR_SYNTHESIS({ existing, turn });

  const c = getClient();
  const res = await c.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }]
  });
  const text = res.content.find(b => b.type === 'text')?.text || '{}';
  const parsed = parseLlmJson(text);
  if (!parsed) {
    db.log('warn', 'quantum-mirror', 'synthesis parse failed', { head: text.slice(0, 500) });
    return { created: 0, superseded: 0 };
  }

  let created = 0;
  for (const entry of parsed.new_entries || []) {
    try {
      await ve.storeMirrorEntry({
        entry_type: forceEntryType || entry.entry_type || entry.category,
        content: entry.content,
        confidence: entry.confidence ?? 0.6,
        source_type: 'conversation',
        source_id: sourceId,
        userId
      });
      created++;
    } catch (err) {
      db.log('error', 'quantum-mirror', `storeMirrorEntry failed: ${err.message}`);
    }
  }

  let superseded = 0;
  for (const s of parsed.supersede || []) {
    try {
      const old = db.getMirrorEntryById(s.old_id);
      if (!old || old.user_id !== userId || old.superseded_by) continue;
      await ve.supersedeMirrorEntry(s.old_id, {
        entry_type: old.entry_type,
        content: s.new_content,
        confidence: s.new_confidence ?? old.confidence,
        source_type: 'conversation',
        source_id: sourceId,
        userId
      });
      superseded++;
    } catch (err) {
      db.log('error', 'quantum-mirror', `supersede failed: ${err.message}`);
    }
  }

  db.log('info', 'quantum-mirror', `synthesis: +${created} new, ${superseded} superseded`);
  // logAction already swallows errors internally, so no outer try/catch here —
  // matches the bare db.log pattern above. Adding a guard would be dead code.
  logAction({
    kind: 'mothership_synthesis',
    subject: `mirror synthesis: +${created} new, ${superseded} superseded`,
    data: { created, superseded, prompt_version: 'synthesis.mirror' },
    sourceType: 'hook',
    sourceId,
    userId
  });
  return { created, superseded };
}

async function storeFromReflection({ proposals = [], userId, reflectionId }) {
  if (!userId) throw new Error('storeFromReflection: userId required');
  let stored = 0;
  for (const p of proposals) {
    if (!p || !p.content) continue;
    const entryType = p.entry_type || p.category;
    if (!entryType) continue;
    try {
      await ve.storeMirrorEntry({
        entry_type: entryType,
        content: p.content,
        confidence: p.confidence ?? 0.6,
        source_type: 'reflection',
        source_id: reflectionId,
        userId
      });
      stored++;
    } catch (err) {
      try { db.log('error', 'quantum-mirror', `storeFromReflection failed: ${err.message}`); } catch {}
    }
  }
  return { stored };
}

module.exports = { synthesizeFromTurn, storeFromReflection, _setClient };
