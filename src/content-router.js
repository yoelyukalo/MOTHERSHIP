/**
 * MOTHERSHIP — Content-type router for URLs
 *
 * Classifies a URL as pdf | video | image | webpage. Uses the path
 * extension first for speed, then falls back to a HEAD request to read
 * the Content-Type header. If HEAD fails, returns 'webpage' so the
 * caller can try yt-dlp + scraper like before.
 */

'use strict';

const path = require('path');

const PDF_EXTS = ['.pdf'];
const VIDEO_EXTS = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'];
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];

const DEFAULT_TIMEOUT_MS = parseInt(process.env.ROUTER_HEAD_TIMEOUT_MS || '10000', 10);

/**
 * @param {string} url
 * @param {object} [opts]
 * @param {typeof fetch} [opts._fetcher]   // injectable for tests
 * @param {number} [opts._timeoutMs]       // HEAD request timeout (default 10000)
 * @returns {Promise<{ kind: 'pdf'|'video'|'image'|'webpage', source: 'extension'|'head'|'fallback', contentType?: string, error?: string }>}
 */
async function classify(url, { _fetcher = fetch, _timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  // Step 1: Parse URL — invalid URL short-circuits to fallback
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    return { kind: 'webpage', source: 'fallback', error: 'invalid url' };
  }

  // Step 2: Extension-first check — lowercase for case-insensitive matching
  const ext = path.extname(parsed.pathname).toLowerCase();
  if (PDF_EXTS.includes(ext))   return { kind: 'pdf',   source: 'extension' };
  if (VIDEO_EXTS.includes(ext)) return { kind: 'video', source: 'extension' };
  if (IMAGE_EXTS.includes(ext)) return { kind: 'image', source: 'extension' };

  // Step 3: HEAD request to inspect Content-Type
  try {
    const res = await _fetcher(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(_timeoutMs)
    });

    if (!res.ok) {
      return { kind: 'webpage', source: 'head' };
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase();

    // application/pdf may come with params like "; charset=binary"
    if (contentType.includes('application/pdf')) {
      return { kind: 'pdf', source: 'head', contentType };
    }
    if (contentType.startsWith('video/')) {
      return { kind: 'video', source: 'head', contentType };
    }
    if (contentType.startsWith('image/')) {
      return { kind: 'image', source: 'head', contentType };
    }
    // text/html, application/json, missing, anything else
    return { kind: 'webpage', source: 'head', contentType };

  } catch (err) {
    // Timeout, network error, server rejects HEAD — caller will fall through to yt-dlp/scraper
    return { kind: 'webpage', source: 'fallback', error: err.message || String(err) };
  }
}

module.exports = { classify };
