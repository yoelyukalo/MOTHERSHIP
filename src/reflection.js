/**
 * MOTHERSHIP — Reflection Agent
 *
 * Daily self-improvement pass. Walks the last 24h of actions (user + Mothership),
 * asks Claude to critique Mothership's behavior and detect user patterns,
 * writes a reflection row, flows proposed Mirror entries through the vector
 * engine, and queues prompt_proposals (with replay eval) for user approval.
 *
 * Structure mirrors health-check.js: opus Claude call, structured JSON output,
 * report delivery. Task 19 implements runNow() only — start/stop/deliverBriefing
 * come in Task 20.
 */

const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');
const registry = require('./prompts/registry');
const replay = require('./prompts/replay');
const qm = require('./quantum-mirror');

const MODEL = process.env.REFLECTION_MODEL || 'claude-opus-4-6';
const MAX_TOKENS = 3000;
const WINDOW_HOURS = parseFloat(process.env.REFLECTION_WINDOW_HOURS || '24');
const MAX_PENDING_PROPOSALS = parseInt(process.env.MAX_PENDING_PROPOSALS || '20', 10);

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

let reflectionInProgress = false;

function parseJsonFromText(text) {
  const trimmed = (text || '').trim();
  try { return JSON.parse(trimmed); }
  catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { return null; }
    }
    return null;
  }
}

function buildWindow() {
  const end = new Date();
  const start = new Date(end.getTime() - WINDOW_HOURS * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function buildReflectionPrompt({ actions, mirrorSnapshot, activePrompts, windowStart, windowEnd }) {
  const template = registry.getPrompt('reflection.daily');
  const actionsDump = actions.map(a =>
    `- [${a.id.slice(0, 8)}] (${a.kind}, conf=${a.confidence}, ${a.created_at}) ${a.subject}` +
    (Object.keys(a.data || {}).length ? ` ${JSON.stringify(a.data)}` : '')
  ).join('\n') || '(none)';

  return `${template}

WINDOW: ${windowStart} to ${windowEnd}

ACTIONS:
${actionsDump}

ACTIVE MIRROR (cognitive profile):
${mirrorSnapshot}

ACTIVE PROMPTS ELIGIBLE FOR CRITIQUE:
${activePrompts.map(p => `## ${p.name} (v${p.version})\n${p.body}`).join('\n\n')}
`;
}

async function runNow({ userId }) {
  if (!userId) throw new Error('runNow: userId required');

  if (reflectionInProgress) {
    return { status: 'already_running', started_at: reflectionInProgress };
  }
  reflectionInProgress = new Date().toISOString();

  try {
    const { start, end } = buildWindow();
    const actions = db.getActionsByWindow({ userId, windowStart: start, windowEnd: end });

    const mirrorRows = db.getMirrorEntries({ userId, limit: 100, activeOnly: true });
    const mirrorSnapshot = mirrorRows
      .map(r => `- [${r.category}] (${r.confidence}) ${r.content}`)
      .join('\n') || '(empty)';

    const activePrompts = registry.listActive();

    const prompt = buildReflectionPrompt({
      actions, mirrorSnapshot, activePrompts,
      windowStart: start, windowEnd: end
    });

    let parsed;
    try {
      const c = getClient();
      const res = await c.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }]
      });
      const text = res.content.find(b => b.type === 'text')?.text || '{}';
      parsed = parseJsonFromText(text);
    } catch (err) {
      try { db.log('error', 'reflection', `LLM call failed: ${err.message}`); } catch {}
      return { status: 'failed', error: err.message };
    }

    if (!parsed) {
      return { status: 'failed', error: 'unparseable_response' };
    }

    const reflectionId = db.addReflection({
      userId,
      windowStart: start,
      windowEnd: end,
      briefingMd: parsed.briefing_md || '(no briefing generated)',
      actionCount: actions.length,
      patternJson: { patterns: parsed.patterns || [] },
      selfCritiqueJson: { items: parsed.self_critique || [] }
    });

    let mirrorProposalsStored = 0;
    if (Array.isArray(parsed.mirror_proposals) && parsed.mirror_proposals.length) {
      try {
        const res = await qm.storeFromReflection({
          proposals: parsed.mirror_proposals,
          userId,
          reflectionId
        });
        mirrorProposalsStored = res.stored;
      } catch (err) {
        try { db.log('error', 'reflection', `mirror proposals failed: ${err.message}`); } catch {}
      }
    }

    let promptProposalsCreated = 0;
    for (const sc of parsed.self_critique || []) {
      if (!sc?.prompt_name || !sc?.proposed_body) continue;

      const pending = db.countPromptProposals({ promptName: sc.prompt_name, status: 'pending' });
      if (pending >= MAX_PENDING_PROPOSALS) {
        try { db.log('warn', 'reflection', `skipping proposal — backlog cap hit for ${sc.prompt_name}`); } catch {}
        continue;
      }

      const activeRow = db.getActivePromptVersion(sc.prompt_name);
      const baseVersion = activeRow?.version || 1;

      let replayResults = null;
      let replayError = null;
      try {
        replayResults = await replay.run({
          promptName: sc.prompt_name,
          proposedBody: sc.proposed_body,
          sampleSize: 20,
          userId
        });
      } catch (err) {
        replayError = err.message;
        try { db.log('warn', 'reflection', `replay failed for ${sc.prompt_name}: ${err.message}`); } catch {}
      }

      db.addPromptProposal({
        promptName: sc.prompt_name,
        baseVersion,
        proposedBody: sc.proposed_body,
        rationale: sc.rationale || sc.issue || 'reflection self-critique',
        replayResultsJson: replayResults,
        replayError
      });
      promptProposalsCreated++;
    }

    return {
      status: 'ok',
      reflectionId,
      actionCount: actions.length,
      mirrorProposalsStored,
      promptProposalsCreated
    };
  } finally {
    reflectionInProgress = false;
  }
}

module.exports = { runNow, _setClient };
