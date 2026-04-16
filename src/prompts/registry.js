/**
 * MOTHERSHIP — Prompt Registry
 *
 * Versioned prompt store. Every synthesis/system prompt used anywhere in the
 * codebase is loaded through registry.getPrompt(name). Versions are immutable;
 * activating a new version flips the is_active flag and invalidates the cache.
 *
 * If a prompt is requested but has no active row, a per-prompt FALLBACK string
 * is returned (registered via setFallback). Callers that need guaranteed
 * availability should always register their fallback at module load.
 */

const db = require('../database');
const {
  MIRROR_SYNTHESIS, WIKI_SYNTHESIS, HEALTH_CONTRADICTIONS, GAP_ANALYSIS
} = require('../memory/synthesis-prompts');

// ---------------------------------------------------------------------------
// Hardcoded fallback bodies — exact copies of the prompts currently in-use
// across the codebase. These back-fill the registry on first boot (via
// seedFromHardcoded) and serve as safe fallbacks when the DB is degraded.
// ---------------------------------------------------------------------------

const SYSTEM_CONVERSATION_FALLBACK = `You are MOTHERSHIP — Yoel's personal AI operating system. You are not a generic assistant. You are a specific, persistent collaborator who is being built *with* Yoel, one conversation at a time.

# What this conversation is for
Yoel is actively building Mothership (you). He sends content — articles, videos, transcripts, ideas, random thoughts — and he wants you to do four things, every time:

1. **Review and comprehend** what he sent. Don't just acknowledge it — actually read it and identify the core insight.
2. **Consult the Mirror + Wiki** injected below to connect the content to how Yoel thinks and what he's building.
3. **Propose concrete next moves** for Mothership itself — features, modules, prompts, architecture decisions. Name files, sketch interfaces, call out tradeoffs.
4. **Respond in Yoel's voice register.** He's a senior builder. Skip preamble, skip hedging, skip "great question!" energy. Be direct and pick sides.

# Current Mothership architecture
- Node.js + Express, SQLite via sql.js (WASM, no native deps)
- Ingestion: Telegram bot, file watcher on ./inbox, URL/video processing
- Vision via Claude (src/vision.js), audio transcription, yt-dlp for video
- Quantum Mirror v3: dynamic mirror_entries + wiki_entries tables with semantic retrieval. The mirror uses a 21-type entry taxonomy organised into 5 layers (identity/pattern/direction/world/resilience) — each row has an entry_type, layer, status, confidence, and related_ids.

# Output rules
- Plain prose, no markdown headers unless genuinely structured.
- Tight. One paragraph if one paragraph works.
- If Yoel sends a link/video, the transcript/summary IS the content — react to it.
- End with a concrete next step OR a sharp question, never both.`;

const EXTRACTOR_ACTIONS_FALLBACK = `You are an action extractor for MOTHERSHIP. Given a Yoel → Mothership conversation turn, identify structured events worth logging.

TURN:
USER: {{userText}}
MOTHERSHIP: {{assistantText}}

Extract up to 5 action candidates. Each candidate MUST match one of these kinds:
- commitment: Yoel stated an intention to do something (explicit, future-tense, first-person). Include data.what and data.due_at if stated (ISO date, null otherwise).
- win: Yoel reported completing or achieving something.
- stumble: Yoel reported failing, skipping, or falling short of something.
- state: Yoel reported a current physical, emotional, or mental state (energy, mood, focus, exhaustion). Include data.dimension ('energy'|'mood'|'focus'|'physical') and data.value (1-10 integer if parseable, null otherwise).
- preference: Yoel stated a durable preference ("I hate tools like X", "I always do Y first").

Output STRICT JSON:
{
  "candidates": [
    {"kind": "commitment", "subject": "short one-line description", "data": {...}, "confidence": 0.0-1.0}
  ]
}

Rules:
- confidence ≥ 0.8 for explicit first-person statements
- confidence 0.5-0.8 for strong implication
- confidence < 0.5 for weak hints (these will be dropped downstream)
- If the turn reveals no meaningful action, return {"candidates": []}.
- Subject is a single declarative phrase ≤100 chars.
- Output ONLY the JSON object.`;

const REFLECTION_DAILY_FALLBACK = `You are MOTHERSHIP's daily reflection agent. Your job is to review the last 24 hours of Yoel's actions and Mothership's own behavior, detect patterns, and propose improvements.

INPUTS (provided below):
- ACTIONS: structured events from the past 24h (user commitments/wins/stumbles/states/preferences, plus Mothership replies/synthesis/categorizations)
- ACTIVE MIRROR: currently-held cognitive profile entries
- ACTIVE PROMPTS: current bodies of Mothership's prompts that are eligible for self-critique

Produce a reflection with:
1. A markdown briefing for Yoel (warm but terse, like a senior peer running a morning check-in)
2. Patterns detected across the 24h window (commitment slippage, energy patterns, topic obsessions)
3. Self-critique items: any Mothership behavior that looked suboptimal, with concrete proposed prompt changes
4. Mirror proposals: any new or refined cognitive profile entries the patterns justify

Output STRICT JSON:
{
  "briefing_md": "string (markdown, 300-1500 chars)",
  "patterns": [{"description": "...", "evidence_action_ids": [...], "confidence": 0.0-1.0}],
  "self_critique": [{"prompt_name": "...", "issue": "...", "proposed_body": "...", "rationale": "..."}],
  "mirror_proposals": [{"entry_type": "...", "content": "...", "confidence": 0.0-1.0, "supporting_action_ids": [...]}]
}

Valid entry_type values (21 total): belief, identity, state, fear, loop, trigger, signal, contradiction, goal, commitment, decision, simulation, question, experiment, context, relationship, resource, influence, model, constraint, win.

Rules:
- briefing_md leads with what matters today (open commitments, wins, state)
- self_critique items only when you have clear evidence from the action log
- mirror_proposals should be durable patterns, not ephemeral facts — those stay in the action log
- Output ONLY the JSON object.`;

const cache = new Map();        // name -> body
const fallbacks = new Map();    // name -> body

function _invalidate(name) { cache.delete(name); }
function _invalidateAll() { cache.clear(); }

function setFallback(name, body) {
  fallbacks.set(name, body);
}

function getPrompt(name) {
  if (cache.has(name)) return cache.get(name);
  let row = null;
  try {
    row = db.getActivePromptVersion(name);
  } catch {
    // DB unavailable (e.g. not initialized, table missing). Fall through
    // to the registered fallback below — the whole point of fallbacks
    // is to keep load-bearing prompts reachable when the DB is degraded.
  }
  if (row && row.body) {
    cache.set(name, row.body);
    return row.body;
  }
  if (fallbacks.has(name)) {
    return fallbacks.get(name);
  }
  throw new Error(`getPrompt: '${name}' has no active version and no fallback`);
}

function listVersions(name) {
  return db.listPromptVersions(name);
}

function listActive() {
  return db.getActivePromptVersions();
}

function createVersion(name, body, { createdBy = 'manual', parentVersion = null, activate = false } = {}) {
  if (!name) throw new Error('createVersion: name required');
  if (!body) throw new Error('createVersion: body required');
  const maxV = db.getMaxPromptVersion(name);
  const version = maxV + 1;
  db.addPromptVersion({ name, version, body, isActive: 0, createdBy, parentVersion });
  if (activate) {
    activateVersion(name, version);
  }
  return version;
}

function activateVersion(name, version) {
  db.setActivePromptVersion(name, version);
  _invalidate(name);
}

function seedFromHardcoded() {
  // Register fallbacks first so getPrompt is safe even before DB rows land.
  setFallback('system.conversation', SYSTEM_CONVERSATION_FALLBACK);
  setFallback('extractor.actions', EXTRACTOR_ACTIONS_FALLBACK);
  setFallback('reflection.daily', REFLECTION_DAILY_FALLBACK);
  setFallback('synthesis.mirror', MIRROR_SYNTHESIS.toString());
  setFallback('synthesis.wiki', WIKI_SYNTHESIS.toString());
  setFallback('health.contradictions', HEALTH_CONTRADICTIONS.toString());
  setFallback('health.gap_analysis', GAP_ANALYSIS.toString());

  const seedEntries = [
    ['system.conversation', SYSTEM_CONVERSATION_FALLBACK],
    ['extractor.actions', EXTRACTOR_ACTIONS_FALLBACK],
    ['reflection.daily', REFLECTION_DAILY_FALLBACK],
    ['synthesis.mirror', MIRROR_SYNTHESIS.toString()],
    ['synthesis.wiki', WIKI_SYNTHESIS.toString()],
    ['health.contradictions', HEALTH_CONTRADICTIONS.toString()],
    ['health.gap_analysis', GAP_ANALYSIS.toString()]
  ];

  let created = 0;
  for (const [name, body] of seedEntries) {
    const existing = db.getActivePromptVersion(name);
    if (existing) continue;
    createVersion(name, body, { createdBy: 'bootstrap', activate: true });
    created++;
  }
  return created;
}

module.exports = {
  getPrompt, listVersions, listActive,
  createVersion, activateVersion,
  setFallback, seedFromHardcoded,
  SYSTEM_CONVERSATION_FALLBACK,
  _invalidate, _invalidateAll
};
