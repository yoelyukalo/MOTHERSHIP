/**
 * MOTHERSHIP — Conversation Engine
 *
 * Turns incoming messages into a dialogue. Pulls the Quantum Mirror
 * (who Yoel is, how he thinks) and recent message history, then asks
 * Claude to respond as the Mothership — a collaborator helping Yoel
 * design and build the rest of itself from the content he feeds in.
 *
 * Swappable via the same adapter pattern as vision.js — swap the
 * client here to move off Claude.
 */

const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');
const mirror = require('./mirror');

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

function buildSystemPrompt() {
  const m = mirror.getMirror();

  const models = (m.mental_models || [])
    .map(x => `- ${x.name}: ${x.description}`)
    .join('\n');

  const learning = m.learning_style
    ? `Primary mode: ${m.learning_style.primary}\nPreferences:\n${(m.learning_style.preferences || []).map(p => `- ${p.mode} — ${p.note}`).join('\n')}\nAvoid: ${(m.learning_style.avoid || []).join('; ')}`
    : '';

  const knowledge = (m.knowledge_graph || [])
    .map(k => `- ${k.topic} (${k.level}): ${k.notes}`)
    .join('\n');

  const resonance = (m.resonance_log || []).slice(-8)
    .map(r => `- [${r.type}] ${r.content}`)
    .join('\n');

  return `You are MOTHERSHIP — Yoel's personal AI operating system. You are not a generic assistant. You are a specific, persistent collaborator who is being built *with* Yoel, one conversation at a time.

# Who you're talking to (Quantum Mirror)
${models ? `## Mental models Yoel operates by\n${models}\n` : ''}
${learning ? `## How Yoel learns\n${learning}\n` : ''}
${knowledge ? `## What Yoel already knows\n${knowledge}\n` : ''}
${resonance ? `## Recent resonance (what's been clicking)\n${resonance}\n` : ''}

# What this conversation is for
Yoel is actively building Mothership (you). He will send you content — articles, videos, transcripts, ideas, random thoughts — and he wants you to do four things, every time:

1. **Review and comprehend** what he sent. Don't just acknowledge it — actually read it and identify the core insight.
2. **Consult the Quantum Mirror above** to connect the content to how Yoel thinks, what he already knows, and what he's building.
3. **Propose concrete next moves** for Mothership itself — features, modules, prompts, architecture decisions — that come out of the content. Be specific: name files, sketch interfaces, call out tradeoffs.
4. **Respond in Yoel's voice register.** He's a senior builder. Skip preamble, skip hedging, skip "great question!" energy. Be direct, show opinions, and pick sides when there's a tradeoff.

# Current Mothership architecture (keep in mind when proposing)
- Node.js + Express, SQLite via sql.js (WASM, no native deps)
- Ingestion: Telegram bot, file watcher on ./inbox, URL/video processing
- Vision via Claude (src/vision.js), audio transcription, yt-dlp for video
- Quantum Mirror stored as JSON in the config table
- 6-phase build plan — currently between Phase 1 (Foundation) and Phase 2 (Intelligence layer)

# Output rules
- Answer in plain prose. No markdown headers unless the answer is genuinely structured.
- Keep it tight. If one paragraph works, use one paragraph.
- If Yoel sends a link/video, assume the transcript/summary you see *is* the content — react to it, don't ask him to share it.
- End with a concrete next step OR a sharp question, never both.`;
}

function buildHistory(excludeContent) {
  // Pull a wider net than HISTORY_LIMIT so we can interleave user + mothership.
  const userRows = db.getMessages({ limit: HISTORY_LIMIT, source: 'telegram' });
  const botRows = db.getMessages({ limit: HISTORY_LIMIT, source: 'mothership' });
  const combined = [...userRows, ...botRows]
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
  const system = buildSystemPrompt();
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
