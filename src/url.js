/**
 * MOTHERSHIP — URL Adapter
 *
 * Fetches a web page, extracts metadata and visible text, and asks
 * Claude for a short summary. Used when a Telegram message contains a
 * link so the bot can reply with something useful instead of silently
 * storing the URL.
 */

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.TEXT_MODEL || 'claude-opus-4-6';
const URL_REGEX = /\b(?:https?:\/\/|www\.)[^\s<>"'`)]+/gi;
const MAX_HTML_CHARS = 20000;

let client = null;
function getClient() {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  client = new Anthropic({ apiKey });
  return client;
}

function extractUrls(text) {
  if (!text) return [];
  const found = text.match(URL_REGEX) || [];
  return Array.from(new Set(found.map(u => {
    const cleaned = u.replace(/[.,;:)]+$/, '');
    return cleaned.startsWith('http') ? cleaned : `https://${cleaned}`;
  })));
}

function getMeta(html, name) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${name}["']`, 'i')
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1].trim();
  }
  return '';
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; MothershipBot/1.0)',
      'Accept': 'text/html,application/xhtml+xml'
    },
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  return { html, finalUrl: res.url };
}

async function summarize({ url, title, description, body }) {
  const c = getClient();
  const prompt = `A user sent this link in a chat. Read the extracted page content and write a concise 2-4 sentence summary capturing what the page/content is about and any key takeaways. Do not editorialize. No preamble.

URL: ${url}
Title: ${title || '(none)'}
Description: ${description || '(none)'}

Page text:
${body || '(no body text extracted)'}`;

  const response = await c.messages.create({
    model: MODEL,
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }]
  });
  return response.content.find(b => b.type === 'text')?.text?.trim() || '';
}

async function processUrl(url) {
  const { html, finalUrl } = await fetchPage(url);
  const title = getMeta(html, 'og:title') || (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '').trim();
  const description = getMeta(html, 'og:description') || getMeta(html, 'description');
  const body = stripHtml(html).slice(0, MAX_HTML_CHARS);
  const summary = await summarize({ url: finalUrl, title, description, body });
  return { url: finalUrl, title, description, summary };
}

module.exports = { processUrl, extractUrls };
