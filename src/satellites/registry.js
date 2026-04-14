/**
 * MOTHERSHIP — Satellite Registry
 *
 * Owns the `satellites` table. Slug validation, row CRUD, lifecycle
 * (archive/unarchive/transfer/visibility) in later tasks. Per-instance
 * folder and DB bootstrap land in Task 6. Sovereignty enforcement lives
 * in sovereignty.js (Task 5); this module only writes to the Mothership
 * core DB, never to satellite-owned DBs.
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const initSqlJs = require('sql.js');
const kinds = require('./kinds');

// 3–64 chars, must start with [a-z0-9], rest [a-z0-9-]
const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;

// 2–64 chars, must start with [a-z0-9], rest [a-z0-9-]
const KIND_NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

const BASELINE_SCHEMA = `
CREATE TABLE IF NOT EXISTS satellite_meta (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS satellite_messages (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  direction TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS satellite_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS satellite_directives_history (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  applied_at TEXT DEFAULT (datetime('now'))
);
`;

function validateSlug(slug) {
  if (typeof slug !== 'string') return false;
  return SLUG_RE.test(slug);
}

function satellitesDir() {
  return process.env.MOTHERSHIP_SATELLITES_DIR ||
         path.join(__dirname, '..', '..', 'data', 'satellites');
}

function insertRow({
  slug,
  name,
  kind,
  db_path = null,
  owner = 'mothership',
  visibility = 'full',
  status = 'active',
  config_json = null,
  notes = null
}) {
  if (!validateSlug(slug)) throw new Error(`invalid slug: ${slug}`);

  const existing = getBySlug(slug);
  if (existing) throw new Error(`slug already exists: ${slug}`);

  const id = uuidv4();
  const raw = db._raw();
  raw.run(
    `INSERT INTO satellites (id, slug, name, kind, db_path, owner, visibility, status, config_json, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, slug, name, kind, db_path, owner, visibility, status, config_json, notes]
  );
  db.save();
  return id;
}

function getBySlug(slug) {
  const raw = db._raw();
  const stmt = raw.prepare('SELECT * FROM satellites WHERE slug = ?');
  stmt.bind([slug]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function getById(id) {
  const raw = db._raw();
  const stmt = raw.prepare('SELECT * FROM satellites WHERE id = ?');
  stmt.bind([id]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function listRows({ status, kind, visibility } = {}) {
  let q = 'SELECT * FROM satellites WHERE 1=1';
  const p = [];
  if (status)     { q += ' AND status = ?';     p.push(status); }
  if (kind)       { q += ' AND kind = ?';        p.push(kind); }
  if (visibility) { q += ' AND visibility = ?';  p.push(visibility); }
  q += ' ORDER BY created_at ASC';

  const raw = db._raw();
  const stmt = raw.prepare(q);
  stmt.bind(p);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function updateStatus(slug, status) {
  const raw = db._raw();
  raw.run('UPDATE satellites SET status = ? WHERE slug = ?', [status, slug]);
  db.save();
}

function updateVisibility(slug, visibility) {
  const raw = db._raw();
  raw.run('UPDATE satellites SET visibility = ? WHERE slug = ?', [visibility, slug]);
  db.save();
}

function updateConfigJson(slug, configJsonString) {
  const raw = db._raw();
  raw.run('UPDATE satellites SET config_json = ? WHERE slug = ?', [configJsonString, slug]);
  db.save();
}

function deleteRow(slug) {
  const raw = db._raw();
  raw.run('DELETE FROM satellites WHERE slug = ?', [slug]);
  db.save();
}

// --- Per-instance bootstrap helpers ---

function ensureFolderTree(slug) {
  const base = path.join(satellitesDir(), slug);
  const subdirs = ['directives/pending', 'directives/applied', 'directives/rejected', 'agents'];
  fs.mkdirSync(base, { recursive: true });
  for (const sd of subdirs) fs.mkdirSync(path.join(base, sd), { recursive: true });
  return base;
}

function instancePaths(slug) {
  const base = path.join(satellitesDir(), slug);
  return {
    base,
    dbFile: path.join(base, 'db.sqlite'),
    configFile: path.join(base, 'config.json'),
    pending: path.join(base, 'directives', 'pending'),
    applied: path.join(base, 'directives', 'applied'),
    rejected: path.join(base, 'directives', 'rejected')
  };
}

function consoleLogger(slug) {
  return {
    info: (msg, data) => db.log('info', `satellite:${slug}`, msg, data || {}),
    warn: (msg, data) => db.log('warn', `satellite:${slug}`, msg, data || {}),
    error: (msg, data) => db.log('error', `satellite:${slug}`, msg, data || {})
  };
}

function applyBaselineAndKindSchema(sdb, kindModule) {
  sdb.exec(BASELINE_SCHEMA);
  if (kindModule.schema && kindModule.schema.trim()) {
    sdb.exec(kindModule.schema);
  }
}

function writeDbFile(sdb, filePath) {
  const bytes = sdb.export();
  fs.writeFileSync(filePath, Buffer.from(bytes));
}

async function createInstance({
  slug,
  name,
  kind,
  visibility = 'full',
  owner = 'mothership',
  config = {},
  fromDraftSlug = null,
  notes = null
}) {
  if (!validateSlug(slug)) throw new Error(`invalid slug: ${slug}`);
  if (!KIND_NAME_RE.test(kind || '')) throw new Error(`invalid kind name: ${kind}`);
  if (getBySlug(slug)) throw new Error(`slug already exists: ${slug}`);

  // Load the kind BEFORE any side effects. If this throws we are clean.
  const kindModule = kinds.loadKind(kind);

  const paths = instancePaths(slug);
  let rowInserted = false;
  let sdb = null;
  try {
    ensureFolderTree(slug);

    // Merge kind default config with caller-supplied config (shallow, top-level).
    const mergedConfig = { ...kindModule.defaultConfig, ...config };
    fs.writeFileSync(paths.configFile, JSON.stringify(mergedConfig, null, 2));

    const SQL = await initSqlJs();
    sdb = new SQL.Database();
    applyBaselineAndKindSchema(sdb, kindModule);

    // onCreate lifecycle hook — receives raw writable handle
    if (kindModule.onCreate) {
      await kindModule.onCreate({ db: sdb, config: mergedConfig, logger: consoleLogger(slug) });
    }

    writeDbFile(sdb, paths.dbFile);

    // db_path is stored relative to satellitesDir() so it stays valid
    // regardless of where MOTHERSHIP_SATELLITES_DIR points.
    const id = insertRow({
      slug, name, kind,
      db_path: path.join(slug, 'db.sqlite').replace(/\\/g, '/'),
      owner, visibility,
      status: 'active',
      config_json: JSON.stringify(mergedConfig),
      notes
    });
    rowInserted = true;

    // NOTE: Task 10 (drafts) will add: if (fromDraftSlug) drafts.linkToSatellite(fromDraftSlug, id)

    return { id, slug, status: 'active' };
  } catch (err) {
    // Rollback: remove folder tree and registry row (best-effort — one failure must not block the other)
    try { fs.rmSync(paths.base, { recursive: true, force: true }); } catch (_) {}
    if (rowInserted) { try { deleteRow(slug); } catch (_) {} }
    throw err;
  } finally {
    // sql.js Database holds a WASM heap allocation; close in every path.
    if (sdb) { try { sdb.close(); } catch (_) {} }
  }
}

// --- Lifecycle ---
//
// These functions sit between the registry row and the loader's in-memory
// map. They use a LAZY `require('./loader')` to avoid the circular import
// that would occur if loader.js (which requires this module at the top)
// tried to require this one at the top too.

async function archive(slug) {
  const loader = require('./loader');
  updateStatus(slug, 'archived');
  await loader.unregister(slug);
}

async function unarchive(slug) {
  const loader = require('./loader');
  updateStatus(slug, 'active');
  await loader.register(slug);
}

async function transfer(slug, { visibility, owner } = {}) {
  const loader = require('./loader');
  const raw = db._raw();
  const patches = ["status = 'transferred'", "transferred_at = datetime('now')"];
  const params = [];
  if (visibility) { patches.push('visibility = ?'); params.push(visibility); }
  if (owner) { patches.push('owner = ?'); params.push(owner); }
  params.push(slug);
  raw.run(`UPDATE satellites SET ${patches.join(', ')} WHERE slug = ?`, params);
  db.save();
  await loader.unregister(slug);
}

async function setVisibility(slug, visibility) {
  if (!['full', 'limited', 'none'].includes(visibility)) {
    throw new Error(`invalid visibility: ${visibility}`);
  }
  const loader = require('./loader');
  updateVisibility(slug, visibility);

  // Re-wrap the in-memory handle if loaded. Simplest correct path: unregister
  // then register, which rebuilds the wrapper against the new visibility value.
  if (loader.get(slug)) {
    await loader.unregister(slug);
    await loader.register(slug);
  }
}

module.exports = {
  validateSlug,
  satellitesDir,
  insertRow,
  getBySlug,
  getById,
  listRows,
  updateStatus,
  updateVisibility,
  updateConfigJson,
  deleteRow,
  createInstance,
  instancePaths,
  ensureFolderTree,
  consoleLogger,
  BASELINE_SCHEMA,
  archive,
  unarchive,
  transfer,
  setVisibility
};
