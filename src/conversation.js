/**
 * MOTHERSHIP — Conversation Engine
 *
 * Turns incoming messages into a dialogue. Pulls live Quantum Mirror context
 * via conversation-hooks (retriever-based) and recent message history, then
 * asks Claude to respond as the Mothership — a collaborator helping Yoel
 * design and build the rest of itself from the content he feeds in.
 *
 * Swappable via the same adapter pattern as vision.js — swap the
 * client here to move off Claude.
 */

const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');
const hooks = require('./conversation-hooks');
const prompts = require('./prompts/registry');
const { logAction } = require('./action-logger');

// Register the canonical fallback at module load. The registry keeps the
// authoritative copy; this registration ensures getPrompt returns a sensible
// body even in test environments that skip seedFromHardcoded.
prompts.setFallback('system.conversation', prompts.SYSTEM_CONVERSATION_FALLBACK);

const MODEL = process.env.CONVERSATION_MODEL || 'claude-opus-4-6';
const MAX_TOKENS = 1500;
const HISTORY_LIMIT = 12;

let client = null;
function getClient() {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  client = new Anthropic({ apiKey, maxRetries: 3, timeout: 120_000 });
  return client;
}

function buildStaticSystemPrompt() {
  return prompts.getPrompt('system.conversation');
}

function buildHistory(excludeContent, userId) {
  if (!userId) throw new Error('buildHistory: userId required');
  // Pull a wider net than HISTORY_LIMIT so we can interleave user + mothership.
  const telegramRows = db.getMessages({ limit: HISTORY_LIMIT, source: 'telegram', userId });
  const dashboardRows = db.getMessages({ limit: HISTORY_LIMIT, source: 'dashboard', userId });
  const botRows = db.getMessages({ limit: HISTORY_LIMIT, source: 'mothership', userId });
  const combined = [...telegramRows, ...dashboardRows, ...botRows]
    .filter(r => r.content && r.content.trim())
    .sort((a, b) => (a.created_at > b.created_at ? 1 : -1));

  // Drop the current turn if it's already in the DB.
  const trimmed = excludeContent
    ? combined.filter(r => r.content !== excludeContent)
    : combined;

  // Keep the last N turns.
  const tail = trimmed.slice(-HISTORY_LIMIT * 2);

  return tail.map(r => ({
    role: r.source === 'mothership' ? 'assistant' : 'user',
    content: r.content.slice(0, 4000)
  }));
}

/**
 * Generate a Mothership reply.
 * @param {string} userInput — the text (or content summary) the user just sent
 * @param {object} opts
 * @param {string} [opts.contextKind] — 'text' | 'link' | 'video' | 'image'
 * @param {string} [opts.sourceHint] — extra framing to prepend to the user turn
 */
async function respond(userInput, opts = {}) {
  const { userId } = opts;
  if (!userId) throw new Error('respond: userId required');
  const c = getClient();
  const staticPrompt = buildStaticSystemPrompt();
  const liveContext = await hooks.preResponse(userInput, { userId });
  const system = liveContext
    ? `${staticPrompt}\n\n# Live context (retrieved for this turn)\n${liveContext}`
    : staticPrompt;

  const history = buildHistory(userInput, userId);

  const framedInput = opts.sourceHint
    ? `${opts.sourceHint}\n\n${userInput}`
    : userInput;

  const messages = [...history, { role: 'user', content: framedInput }];

  const response = await c.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages
  });

  const text = response.content.find(b => b.type === 'text')?.text?.trim() || '';
  logUsage(opts.contextKind || 'text', response.usage);
  try {
    logAction({
      kind: 'mothership_reply',
      subject: `reply to ${opts.contextKind || 'text'} turn`,
      data: {
        prompt_version: 'system.conversation',
        tokens_in: response.usage?.input_tokens || 0,
        tokens_out: response.usage?.output_tokens || 0,
        context_kind: opts.contextKind || 'text'
      },
      sourceType: 'conversation',
      sourceId: null,
      userId
    });
  } catch {}
  return text;
}

function logUsage(kind, usage) {
  try {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), kind, ...usage }) + '\n';
    fs.appendFileSync(path.join(dir, 'conversation-usage.jsonl'), line);
  } catch { /* never break on logging */ }
}

module.exports = { respond, _buildStaticSystemPrompt: buildStaticSystemPrompt };
