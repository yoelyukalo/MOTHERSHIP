/**
 * MOTHERSHIP — Satellite Registry
 *
 * Owns the `satellites` table. Slug validation, row CRUD, lifecycle
 * (archive/unarchive/transfer/visibility) in later tasks. Per-instance
 * folder and DB bootstrap land in Task 6. Sovereignty enforcement lives
 * in sovereignty.js (Task 5); this module only writes to the Mothership
 * core DB, never to satellite-owned DBs.
 */

const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');

// 3–64 chars, must start with [a-z0-9], rest [a-z0-9-]
const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;

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
  deleteRow
};
