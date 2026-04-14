/**
 * MOTHERSHIP — Unified URL ingestion
 *
 * One entry point for ingesting a URL end-to-end. Consults the content
 * router, dispatches to the right handler, stores extracted content in
 * the DB, and returns a structured result the caller can use to build a
 * reply and trigger post-ingestion synthesis.
 *
 * Routing rules:
 *   kind=pdf      → src/pdf.js processPdfUrl
 *   kind=video    → yt-dlp + processor.processVideo
 *   kind=image    → falls through to webpage (vision-on-URL is future work)
 *   kind=webpage  → yt-dlp first (for YouTube/TikTok/etc whose HEAD is HTML),
 *                   fall through to url.processUrl on NoVideoError
 */

'use strict';

const path = require('path');

const defaultRouter = require('./content-router');
const defaultPdf = require('./pdf');
const defaultYtdlp = require('./ytdlp');
const defaultProcessor = require('./processor');
const defaultUrlSummary = require('./url');
const defaultDb = require('./database');
const auth = require('./auth');

const DOWNLOADS_DEFAULT = path.resolve(process.env.DOWNLOADS_FOLDER || './downloads');

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '\u2026' : str;
}

/**
 * Shared helper: given a successfully downloaded video, run processVideo and
 * build the structured result. Used by both the direct `video` branch and the
 * `webpage → yt-dlp succeeded` branch so there is no duplication.
 */
async function dispatchVideo({ url, downloaded, source, baseMeta, processor }) {
  const result = await processor.processVideo(downloaded.filePath, {
    mode: 'both',
    source,
    baseMeta: { ...baseMeta, ...downloaded.meta }
  });

  const transcript = result?.transcript || '';
  const visionDesc = result?.vision?.description || '';

  const parts = [];
  if (transcript) parts.push(`\uD83C\uDFA7 ${truncate(transcript, 1500)}`);
  if (visionDesc) parts.push(`\uD83D\uDC41 ${visionDesc}`);

  const title = downloaded.meta?.title || url;
  const uploaderLine = downloaded.meta?.uploader ? `by ${downloaded.meta.uploader}\n` : '';
  const display = `\uD83C\uDFAC ${title}\n${uploaderLine}${parts.join('\n')}`;
  const content = [transcript, visionDesc].filter(Boolean).join('\n\n');

  return {
    kind: 'video',
    messageId: result?.messageId,
    display,
    content,
    url
  };
}

/**
 * Ingest one URL end-to-end. Consults the content router, dispatches to
 * the right handler, stores content in the DB, returns a structured
 * result for the Telegram reply + post-ingestion hook.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.source]             // 'telegram' | 'file-drop' | etc
 * @param {object} [opts.baseMeta]           // merged into DB metadata
 * @param {string} [opts.userId]             // owner of ingested rows; falls back to system owner
 * @param {string} [opts.downloadsPath]      // where yt-dlp puts files
 * @param {object} [opts._router]            // { classify } — injected for tests
 * @param {object} [opts._pdf]               // { processPdfUrl } — injected
 * @param {object} [opts._ytdlp]             // { downloadVideo, NoVideoError } — injected
 * @param {object} [opts._processor]         // { processVideo } — injected
 * @param {object} [opts._urlSummary]        // { processUrl } — injected
 * @param {object} [opts._db]                // { addMessage } — injected
 * @returns {Promise<{
 *   kind: 'pdf'|'video'|'webpage'|'image',
 *   messageId: string,
 *   display: string,
 *   content: string,
 *   url: string
 * }>}
 */
async function ingestUrl(url, opts = {}) {
  const {
    source = 'telegram',
    baseMeta = {},
    userId: explicitUserId,
    downloadsPath = DOWNLOADS_DEFAULT,
    _router = defaultRouter,
    _pdf = defaultPdf,
    _ytdlp = defaultYtdlp,
    _processor = defaultProcessor,
    _urlSummary = defaultUrlSummary,
    _db = defaultDb
  } = opts;

  const userId = explicitUserId || auth.getSystemOwnerId();
  if (!userId) throw new Error('ingestUrl: no userId and no system owner — run bootstrap first');

  const classification = await _router.classify(url);

  // --- PDF ---
  if (classification.kind === 'pdf') {
    const r = await _pdf.processPdfUrl(url, { source, baseMeta });
    return {
      kind: 'pdf',
      messageId: r.messageId,
      display: `\uD83D\uDCC4 ${r.title} (${r.pageCount} pages)\n${truncate(r.text, 1500)}`,
      content: r.text,
      url
    };
  }

  // --- Direct video (extension or Content-Type: video/*) ---
  if (classification.kind === 'video') {
    const downloaded = await _ytdlp.downloadVideo(url, downloadsPath);
    return dispatchVideo({ url, downloaded, source, baseMeta, processor: _processor });
  }

  // --- Webpage or image ---
  // Try yt-dlp first: YouTube/TikTok/etc return text/html from HEAD but yt-dlp
  // knows how to extract the video. Image URLs are also passed through here
  // because vision-on-URL is deferred to a future task — for now we treat them
  // the same as webpages.
  try {
    const downloaded = await _ytdlp.downloadVideo(url, downloadsPath);
    return await dispatchVideo({ url, downloaded, source, baseMeta, processor: _processor });
  } catch (err) {
    // NoVideoError is expected for real web pages / plain image URLs.
    // Any other error (network, disk, yt-dlp crash) propagates so the caller
    // (telegram.js) can surface it to the user.
    if (!(err instanceof _ytdlp.NoVideoError)) throw err;
  }

  // yt-dlp found no video — summarise as a web page.
  const r = await _urlSummary.processUrl(url);
  const content = `[Link] ${r.title || r.url}\n\n${r.summary}`;
  const messageId = _db.addMessage(content, source, 'link-summary', {
    ...baseMeta,
    source_url: r.url,
    title: r.title,
    description: r.description
  }, userId);
  return {
    kind: 'webpage',
    messageId,
    display: `\uD83D\uDD17 ${r.title || r.url}\n${r.summary}`,
    content: r.summary,
    url: r.url
  };
}

module.exports = { ingestUrl };
