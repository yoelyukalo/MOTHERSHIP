/**
 * MOTHERSHIP — Vision Adapter
 *
 * Sends images (or batches of video frames) to Claude and returns a
 * structured read of what's on-screen: description, extracted text,
 * URLs, and named entities.
 *
 * Swappable by design — future adapters can hot-swap Claude for
 * GPT-4o vision / local Llava / etc. behind the same interface.
 */

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.VISION_MODEL || 'claude-opus-4-6';
const URL_REGEX = /\b(?:https?:\/\/|www\.)[^\s<>"'`)]+/gi;

let client = null;
function getClient() {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  client = new Anthropic({ apiKey, maxRetries: 5, timeout: 120_000 });
  return client;
}

function fileToImageBlock(filePath) {
  const data = fs.readFileSync(filePath).toString('base64');
  const ext = path.extname(filePath).toLowerCase().slice(1);
  const mediaMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
  return {
    type: 'image',
    source: { type: 'base64', media_type: mediaMap[ext] || 'image/jpeg', data }
  };
}

function parseResult(text) {
  let parsed = null;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try { parsed = JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
  }

  if (!parsed) {
    parsed = { description: text, onScreenText: '', entities: [] };
  }

  const haystack = `${parsed.description || ''} ${parsed.onScreenText || ''}`;
  const foundUrls = Array.from(new Set((haystack.match(URL_REGEX) || []).map(u => u.replace(/[.,;:)]+$/, ''))));
  parsed.links = Array.from(new Set([...(parsed.links || []), ...foundUrls]));

  return parsed;
}

const PROMPT = `Analyze the image(s). Return ONLY a JSON object with this shape:
{
  "description": "what is happening visually, 1-3 sentences",
  "onScreenText": "every piece of readable text on screen, verbatim, joined with newlines",
  "links": ["any URLs visible on screen"],
  "entities": ["people, products, brands, apps, or tools shown"]
}
No prose outside the JSON.`;

async function analyzeImage(filePath) {
  const c = getClient();
  const response = await c.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [fileToImageBlock(filePath), { type: 'text', text: PROMPT }]
    }]
  });
  const text = response.content.find(b => b.type === 'text')?.text || '';
  logUsage('image', response.usage, 1);
  return parseResult(text);
}

async function analyzeFrames(framePaths, context = '') {
  if (!framePaths.length) return { description: '', onScreenText: '', links: [], entities: [] };
  const c = getClient();
  const content = framePaths.map(fileToImageBlock);
  content.push({
    type: 'text',
    text: `These are sequential frames sampled from a single video.${context ? ` Context: ${context}` : ''}\n\n${PROMPT}`
  });

  const response = await c.messages.create({
    model: MODEL,
    max_tokens: 2048,
    messages: [{ role: 'user', content }]
  });
  const text = response.content.find(b => b.type === 'text')?.text || '';
  logUsage('frames', response.usage, framePaths.length);
  return parseResult(text);
}

function logUsage(kind, usage, frames) {
  try {
    const dir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), kind, frames, ...usage }) + '\n';
    fs.appendFileSync(path.join(dir, 'vision-usage.jsonl'), line);
  } catch { /* never break on logging */ }
}

module.exports = { analyzeImage, analyzeFrames };
