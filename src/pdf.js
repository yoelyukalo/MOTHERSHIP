/**
 * MOTHERSHIP — PDF adapter
 *
 * Extracts text from PDFs via pdf-parse v2 (pdfjs-dist under the hood).
 * Provides three entry points: raw buffer parse, URL fetch+parse, and
 * local file parse. All three store the extracted content in the DB and
 * return { kind, title, pageCount, text, messageId, byteSize }.
 *
 * pdf-parse v2 has no native deps — it ships pdfjs-dist which is pure JS.
 */

const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const db = require('./database');

const MAX_PDF_BYTES = parseInt(process.env.MAX_PDF_BYTES || String(50 * 1024 * 1024), 10); // 50 MB
const FETCH_TIMEOUT_MS = parseInt(process.env.PDF_FETCH_TIMEOUT_MS || '60000', 10);
const MAX_STORED_CHARS = parseInt(process.env.PDF_MAX_STORED_CHARS || '40000', 10);

/**
 * Parse a Buffer into { text, pageCount, pages }.
 * Always destroys the parser via try/finally, even on error.
 *
 * @param {Buffer} buf - Raw PDF bytes
 * @param {{ _Parser?: typeof PDFParse }} opts - Injectable parser for testing
 * @returns {Promise<{ text: string, pageCount: number, pages: Array<{num: number, text: string}> }>}
 */
async function parsePdfBuffer(buf, { _Parser = PDFParse } = {}) {
  const parser = new _Parser({ data: buf });
  try {
    const result = await parser.getText();
    return {
      text: (result.text || '').trim(),
      pageCount: result.total ?? 0,
      pages: result.pages || []
    };
  } finally {
    await parser.destroy().catch(() => {});
  }
}

/**
 * Derive a human-readable title from a URL.
 * Uses the last non-empty path segment (without query string), or falls back
 * to the raw URL string if parsing fails.
 *
 * @param {string} url
 * @returns {string}
 */
function urlTitleFrom(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    return seg || u.hostname;
  } catch {
    return url;
  }
}

/**
 * Download a PDF buffer from a URL, enforcing the 50 MB size cap
 * both against the Content-Length header (fast rejection) and after
 * the full download (guard against lying servers).
 *
 * @param {string} url
 * @param {Function} fetcher - fetch-compatible function (injectable for tests)
 * @returns {Promise<Buffer>}
 */
async function fetchPdfBuffer(url, fetcher) {
  const res = await fetcher(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching PDF`);
  }

  const declaredLen = parseInt(res.headers.get('content-length') || '0', 10);
  if (declaredLen && declaredLen > MAX_PDF_BYTES) {
    throw new Error(
      `PDF too large: ${Math.round(declaredLen / 1024 / 1024)}MB (max ${Math.round(MAX_PDF_BYTES / 1024 / 1024)}MB)`
    );
  }

  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);

  if (buf.length > MAX_PDF_BYTES) {
    throw new Error(
      `PDF too large after download: ${Math.round(buf.length / 1024 / 1024)}MB (max ${Math.round(MAX_PDF_BYTES / 1024 / 1024)}MB)`
    );
  }

  return buf;
}

/**
 * Build and store a pdf-summary message in the DB.
 * Content is truncated to MAX_STORED_CHARS; the returned text is not.
 *
 * @param {{ title: string, pageCount: number, text: string, byteSize: number,
 *           source: string, baseMeta: object, urlOrPath: string, isFile: boolean }}
 * @returns {string} messageId (UUID)
 */
function storePdfMessage({ title, pageCount, text, byteSize, source, baseMeta, urlOrPath, isFile }) {
  const truncated = text.length > MAX_STORED_CHARS;
  const storedText = truncated ? text.slice(0, MAX_STORED_CHARS) : text;
  const content = `[PDF] ${title} (${pageCount} pages)\n\n${storedText}`;

  const meta = {
    ...baseMeta,
    title,
    page_count: pageCount,
    byte_size: byteSize,
    text_truncated: truncated
  };

  if (isFile) {
    meta.filepath = urlOrPath;
  } else {
    meta.source_url = urlOrPath;
  }

  return db.addMessage(content, source, 'pdf-summary', meta);
}

/**
 * Fetch a PDF from a URL, parse it, and store the result in the DB.
 *
 * @param {string} url
 * @param {{ source?: string, baseMeta?: object, _fetcher?: Function, _Parser?: typeof PDFParse }} opts
 * @returns {Promise<{ kind: 'pdf', title: string, pageCount: number, text: string, messageId: string, byteSize: number }>}
 */
async function processPdfUrl(url, { source = 'telegram', baseMeta = {}, _fetcher = fetch, _Parser = PDFParse } = {}) {
  const buf = await fetchPdfBuffer(url, _fetcher);
  const { text, pageCount } = await parsePdfBuffer(buf, { _Parser });
  const title = urlTitleFrom(url);

  const messageId = storePdfMessage({
    title,
    pageCount,
    text,
    byteSize: buf.length,
    source,
    baseMeta,
    urlOrPath: url,
    isFile: false
  });

  return { kind: 'pdf', title, pageCount, text, messageId, byteSize: buf.length };
}

/**
 * Read a local PDF file from disk, parse it, and store the result in the DB.
 *
 * @param {string} filePath - Absolute path to the PDF file
 * @param {{ source?: string, baseMeta?: object, _Parser?: typeof PDFParse }} opts
 * @returns {Promise<{ kind: 'pdf', title: string, pageCount: number, text: string, messageId: string, byteSize: number }>}
 */
async function processPdfFile(filePath, { source = 'file-drop', baseMeta = {}, _Parser = PDFParse } = {}) {
  const buf = fs.readFileSync(filePath);

  if (buf.length > MAX_PDF_BYTES) {
    throw new Error(
      `PDF too large: ${Math.round(buf.length / 1024 / 1024)}MB (max ${Math.round(MAX_PDF_BYTES / 1024 / 1024)}MB)`
    );
  }

  const { text, pageCount } = await parsePdfBuffer(buf, { _Parser });
  const title = path.basename(filePath);

  const messageId = storePdfMessage({
    title,
    pageCount,
    text,
    byteSize: buf.length,
    source,
    baseMeta,
    urlOrPath: filePath,
    isFile: true
  });

  return { kind: 'pdf', title, pageCount, text, messageId, byteSize: buf.length };
}

module.exports = { parsePdfBuffer, processPdfUrl, processPdfFile };
