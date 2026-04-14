/**
 * MOTHERSHIP — Directive consumer
 *
 * Watches `data/satellites/<slug>/directives/pending/` for JSON directive
 * files, looks up the matching handler in the kind/custom module, and calls
 * it with the raw writable DB handle (supplied by the loader via closure).
 *
 * Files move to applied/ or rejected/ after handling. A history row is
 * written to the satellite's own satellite_directives_history table.
 *
 * Trust boundary: this module is one of only two that sees the raw handle
 * (the other is loader.js). It does NOT write to the DB itself — it only
 * passes the handle into the handler that was authored inside the kind
 * module or the instance's custom.js.
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const chokidar = require('chokidar');

const registry = require('./registry');
const db = require('../database');

function pendingDir(slug)  { return path.join(registry.satellitesDir(), slug, 'directives', 'pending');  }
function appliedDir(slug)  { return path.join(registry.satellitesDir(), slug, 'directives', 'applied');  }
function rejectedDir(slug) { return path.join(registry.satellitesDir(), slug, 'directives', 'rejected'); }

function fsSafeTs() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// Directive kind names are interpolated into filenames and looked up as
// object keys on kindModule.directiveHandlers. Restrict the charset so a
// malicious `kind` like 'config.set/../../applied' cannot escape the
// pending/ directory via path.join.
const KIND_RE = /^[a-z][a-z0-9._-]{0,63}$/;

function issue(slug, { kind, payload, issuedBy = 'mothership' }) {
  if (!kind || typeof kind !== 'string' || !KIND_RE.test(kind)) {
    throw new Error(`invalid directive kind: ${kind}`);
  }
  const id = uuidv4();
  const body = {
    id,
    kind,
    issued_at: new Date().toISOString(),
    issued_by: issuedBy,
    payload
  };
  const fname = `${fsSafeTs()}-${kind}-${id.slice(0, 8)}.json`;
  const target = path.join(pendingDir(slug), fname);
  fs.mkdirSync(pendingDir(slug), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(body, null, 2));
  return id;
}

async function processFile(filePath, ctx) {
  const { slug, rawDb, kindModule, config, logger, flush } = ctx;
  let body;
  try {
    body = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return moveToRejected(filePath, slug, `parse error: ${err.message}`, { kind: 'unknown', payload: {} }, rawDb, flush);
  }

  const handler = (kindModule.directiveHandlers || {})[body.kind];
  if (!handler) {
    return moveToRejected(filePath, slug, `unknown directive kind: ${body.kind}`, body, rawDb, flush);
  }

  try {
    await handler({ payload: body.payload, db: rawDb, config, logger });
    writeHistory(rawDb, body, 'applied', null);
    flush();
    const target = path.join(appliedDir(slug), path.basename(filePath));
    fs.mkdirSync(appliedDir(slug), { recursive: true });
    fs.renameSync(filePath, target);
    db.log('info', `satellites.directives:${slug}`, `applied ${body.kind} ${body.id}`);
  } catch (err) {
    return moveToRejected(filePath, slug, err.message, body, rawDb, flush);
  }
}

function moveToRejected(filePath, slug, errorMsg, body, rawDb, flush) {
  try { writeHistory(rawDb, body, 'rejected', errorMsg); flush(); } catch (_) {}
  fs.mkdirSync(rejectedDir(slug), { recursive: true });
  const target = path.join(rejectedDir(slug), path.basename(filePath));
  try {
    fs.renameSync(filePath, target);
  } catch (renameErr) {
    // Log the rename failure explicitly — a silent swallow leaves the file
    // stuck in pending/ where the next startup sweep will retry it, but the
    // operator has no signal that it happened.
    db.log(
      'warn',
      `satellites.directives:${slug}`,
      `failed to move ${path.basename(filePath)} to rejected/: ${renameErr.message} — file remains in pending/`
    );
  }
  try { fs.writeFileSync(target + '_error.txt', errorMsg); } catch (_) {}
  db.log('warn', `satellites.directives:${slug}`, `rejected ${body.kind || 'unknown'}: ${errorMsg}`);
}

function writeHistory(rawDb, body, status, errorMsg) {
  rawDb.run(
    `INSERT OR REPLACE INTO satellite_directives_history
     (id, kind, payload_json, status, error, applied_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    [body.id || uuidv4(), body.kind || 'unknown', JSON.stringify(body.payload || {}), status, errorMsg || null]
  );
}

async function start(slug, { rawDb, kindModule, config, logger, flush }) {
  const ctx = { slug, rawDb, kindModule, config, logger, flush };

  // Startup sweep — process any leftover files
  const pending = pendingDir(slug);
  fs.mkdirSync(pending, { recursive: true });
  for (const f of fs.readdirSync(pending)) {
    if (f.endsWith('.json')) {
      await processFile(path.join(pending, f), ctx);
    }
  }

  // chokidar watcher for live additions.
  // We wait for the 'ready' event before resolving so the caller can be sure
  // any file written after start() returns will trigger a genuine 'add' event
  // rather than being silently absorbed into the initial scan.
  const watcher = chokidar.watch(pending, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 30 }
  });
  watcher.on('add', async (file) => {
    if (!file.endsWith('.json')) return;
    try { await processFile(file, ctx); }
    catch (err) { db.log('error', `satellites.directives:${slug}`, err.message); }
  });

  // Bounded wait for chokidar 'ready'. A watcher that never emits ready
  // (certain NTFS permission issues) would otherwise hang loader.register()
  // and, transitively, the entire Mothership boot sequence.
  const READY_TIMEOUT_MS = 10_000;
  await new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`chokidar ready timed out after ${READY_TIMEOUT_MS}ms for ${slug}`)),
      READY_TIMEOUT_MS
    );
    watcher.once('ready', () => { clearTimeout(t); resolve(); });
    watcher.once('error', (e) => { clearTimeout(t); reject(e); });
  });

  return async () => { await watcher.close(); };
}

module.exports = { issue, start };
