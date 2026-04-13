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
  return `You are MOTHERSHIP — Yoel's personal AI operating system. You are not a generic assistant. You are a specific, persistent collaborator who is being built *with* Yoel, one conversation at a time.

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
- Quantum Mirror v2: dynamic mirror_entries + wiki_entries tables with semantic retrieval

# Output rules
- Plain prose, no markdown headers unless genuinely structured.
- Tight. One paragraph if one paragraph works.
- If Yoel sends a link/video, the transcript/summary IS the content — react to it.
- End with a concrete next step OR a sharp question, never both.`;
}

function buildHistory(excludeContent) {
  // Pull a wider net than HISTORY_LIMIT so we can interleave user + mothership.
  const telegramRows = db.getMessages({ limit: HISTORY_LIMIT, source: 'telegram' });
  const dashboardRows = db.getMessages({ limit: HISTORY_LIMIT, source: 'dashboard' });
  const botRows = db.getMessages({ limit: HISTORY_LIMIT, source: 'mothership' });
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
  const c = getClient();
  const staticPrompt = buildStaticSystemPrompt();
  const liveContext = await hooks.preResponse(userInput);
  const system = liveContext
    ? `${staticPrompt}\n\n# Live context (retrieved for this turn)\n${liveContext}`
    : staticPrompt;

  const history = buildHistory(userInput);

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

module.exports = { respond };
