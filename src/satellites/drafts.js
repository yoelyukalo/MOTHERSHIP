/**
 * MOTHERSHIP — Satellite draft capture
 *
 * Drafts are in-progress satellite ideas. Each links to a slug and
 * accumulates chat turns (by metadata.draft_slug on the messages table)
 * plus an optional synthesized brief. Claude Code reads the draft endpoint
 * to get the full conversation + brief as build context.
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../database');

function create({ slug, name, kind = null }) {
  const id = uuidv4();
  const raw = db._raw();
  raw.run(
    `INSERT INTO satellite_drafts (id, slug, name, kind) VALUES (?, ?, ?, ?)`,
    [id, slug, name, kind]
  );
  db.save();
  return id;
}

function getBySlug(slug) {
  const raw = db._raw();
  const stmt = raw.prepare('SELECT * FROM satellite_drafts WHERE slug = ?');
  stmt.bind([slug]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function list({ status } = {}) {
  const raw = db._raw();
  let q = 'SELECT * FROM satellite_drafts WHERE 1=1';
  const p = [];
  if (status) { q += ' AND status = ?'; p.push(status); }
  q += ' ORDER BY created_at ASC';
  const stmt = raw.prepare(q);
  stmt.bind(p);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function setBrief(slug, briefMd) {
  const raw = db._raw();
  raw.run(
    `UPDATE satellite_drafts
     SET brief_md = ?, brief_updated_at = datetime('now'), updated_at = datetime('now')
     WHERE slug = ?`,
    [briefMd, slug]
  );
  db.save();
}

function setStatus(slug, status) {
  const raw = db._raw();
  raw.run(
    `UPDATE satellite_drafts SET status = ?, updated_at = datetime('now') WHERE slug = ?`,
    [status, slug]
  );
  db.save();
}

function linkToSatellite(slug, satelliteId) {
  const raw = db._raw();
  raw.run(
    `UPDATE satellite_drafts
     SET status = 'created', created_satellite_id = ?, updated_at = datetime('now')
     WHERE slug = ?`,
    [satelliteId, slug]
  );
  db.save();
}

function getDraftWithMessages(slug) {
  const draft = getBySlug(slug);
  if (!draft) return null;

  const raw = db._raw();
  const stmt = raw.prepare(
    `SELECT * FROM messages
     WHERE json_extract(metadata, '$.draft_slug') = ?
     ORDER BY created_at ASC`
  );
  stmt.bind([slug]);
  const messages = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    row.tags = JSON.parse(row.tags || '[]');
    row.metadata = JSON.parse(row.metadata || '{}');
    messages.push(row);
  }
  stmt.free();
  return { draft, messages };
}

async function regenerateBrief(slug, { conversation } = {}) {
  const result = getDraftWithMessages(slug);
  if (!result) throw new Error(`no such draft: ${slug}`);
  const { draft, messages } = result;

  const conv = conversation || require('../conversation');
  const transcript = messages.map(m =>
    `${m.source === 'mothership' ? 'MOTHERSHIP' : 'YOEL'}: ${m.content}`
  ).join('\n\n');

  const systemHint = [
    `You are generating a structured build brief for a satellite named "${draft.name}" (slug: ${draft.slug}, kind: ${draft.kind || 'unknown'}).`,
    'Read the transcript below and produce a markdown brief with these sections:',
    '## Goal', '## Users', '## Data kinds', '## Operational constraints', '## Open questions',
    'Be concise. If a section has no evidence in the transcript, write "not yet specified".'
  ].join('\n');

  const reply = await conv.respond(`${systemHint}\n\n---\n\n${transcript}`, { contextKind: 'text' });
  setBrief(slug, reply);
  return reply;
}

module.exports = {
  create, getBySlug, list,
  setBrief, setStatus, linkToSatellite,
  getDraftWithMessages, regenerateBrief
};
