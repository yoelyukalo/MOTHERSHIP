/**
 * MOTHERSHIP — Prompt Replay Eval
 *
 * Runs a proposed prompt body against historical actions and compares it to
 * the currently-active body. Used by reflection.js to preview prompt changes
 * before they go into prompt_proposals for user approval.
 *
 * Uses claude-haiku-4-5 by default (cheap). Deliberately not used at
 * production runtime — replay is a previewing/evaluation tool. The live
 * synthesis/reply paths still use whatever is active in the registry.
 */

const Anthropic = require('@anthropic-ai/sdk');
const db = require('../database');
const registry = require('./registry');

const MODEL = process.env.REPLAY_MODEL || 'claude-haiku-4-5';
const MAX_TOKENS = 800;
const MIN_SAMPLES = 5;

let client = null;
function _setClient(c) { client = c; }
function getClient() {
  if (client) return client;
  client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxRetries: 2,
    timeout: 60_000
  });
  return client;
}

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

// Maps a prompt name to the action kind whose source_ids we should replay.
function mapPromptNameToActionKind(promptName) {
  if (promptName === 'synthesis.mirror') return 'mothership_synthesis';
  if (promptName === 'synthesis.wiki') return 'mothership_synthesis';
  if (promptName === 'system.conversation') return 'mothership_reply';
  return null;
}

async function runOne(body, sampleInput) {
  const c = getClient();
  const res = await c.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: `${body}\n\nINPUT:\n${sampleInput}` }]
  });
  const text = res.content.find(b => b.type === 'text')?.text || '';
  return parseJsonFromText(text) || { raw: text };
}

function reconstructInput(action) {
  if (!action.source_id) return null;
  try {
    const stmt = db._raw().prepare(`SELECT content FROM messages WHERE id = ?`);
    stmt.bind([action.source_id]);
    let content = null;
    if (stmt.step()) content = stmt.getAsObject().content;
    stmt.free();
    return content;
  } catch {
    return null;
  }
}

async function run({ promptName, proposedBody, sampleSize = 20, userId }) {
  if (!promptName || !proposedBody) throw new Error('replay.run: promptName and proposedBody required');
  if (!userId) throw new Error('replay.run: userId required');

  const kind = mapPromptNameToActionKind(promptName);
  if (!kind) {
    return { sample_size: 0, skipped: true, reason: 'unknown_prompt_name' };
  }

  const allActions = db.getActions({ userId, kind, limit: sampleSize * 2 });
  const withInputs = allActions
    .map(a => ({ action: a, input: reconstructInput(a) }))
    .filter(x => x.input);

  if (withInputs.length < MIN_SAMPLES) {
    return {
      sample_size: withInputs.length,
      skipped: true,
      reason: 'insufficient_history'
    };
  }

  const samples = withInputs.slice(0, sampleSize);

  let activeBody;
  try {
    activeBody = registry.getPrompt(promptName);
  } catch {
    return { sample_size: 0, skipped: true, reason: 'no_active_prompt' };
  }

  const baseline_outputs = [];
  const proposed_outputs = [];

  for (const s of samples) {
    try {
      const b = await runOne(activeBody, s.input);
      const p = await runOne(proposedBody, s.input);
      baseline_outputs.push({ sample_id: s.action.id, output: b });
      proposed_outputs.push({ sample_id: s.action.id, output: p });
    } catch (err) {
      try { db.log('warn', 'replay', `sample ${s.action.id} failed: ${err.message}`); } catch {}
    }
  }

  const surviving = baseline_outputs.length;
  let agreements = 0;
  const regressions = [];
  const improvements = [];

  for (let i = 0; i < surviving; i++) {
    const b = JSON.stringify(baseline_outputs[i].output);
    const p = JSON.stringify(proposed_outputs[i].output);
    if (b === p) {
      agreements++;
      continue;
    }
    const baseCount = baseline_outputs[i].output?.new_entries?.length || 0;
    const propCount = proposed_outputs[i].output?.new_entries?.length || 0;
    if (propCount < baseCount) {
      regressions.push({ sample_id: baseline_outputs[i].sample_id, issue: 'dropped_entries' });
    } else if (propCount > baseCount) {
      improvements.push({ sample_id: baseline_outputs[i].sample_id, note: 'added_entries' });
    }
  }

  return {
    sample_size: surviving,
    agreement_rate: surviving > 0 ? agreements / surviving : 0,
    regressions,
    improvements,
    baseline_sample: baseline_outputs.slice(0, 3),
    proposed_sample: proposed_outputs.slice(0, 3)
  };
}

module.exports = { run, _setClient };
