/**
 * MOTHERSHIP — API keys (bearer tokens)
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const hashing = require('./hashing');

const TOKEN_PREFIX = 'mk_live_';

function newPlaintextToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

async function generateApiKey(userId, name) {
  if (!userId) throw new Error('userId required');
  if (!name || typeof name !== 'string') throw new Error('name required');
  const plaintext = newPlaintextToken();
  const token_hash = await hashing.hash(plaintext);
  const id = uuidv4();
  const raw = db._raw();
  raw.run(
    `INSERT INTO api_keys (id, user_id, name, token_hash) VALUES (?, ?, ?, ?)`,
    [id, userId, name, token_hash]
  );
  db.save();
  return { id, plaintext };
}

async function lookupByToken(plaintext) {
  if (!plaintext || !plaintext.startsWith(TOKEN_PREFIX)) return null;
  const raw = db._raw();
  const stmt = raw.prepare('SELECT * FROM api_keys WHERE disabled_at IS NULL');
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();

  for (const row of rows) {
    if (await hashing.verify(row.token_hash, plaintext)) {
      raw.run(`UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?`, [row.id]);
      db.save();
      return row;
    }
  }
  return null;
}

function disableApiKey(id) {
  const raw = db._raw();
  raw.run(`UPDATE api_keys SET disabled_at = datetime('now') WHERE id = ?`, [id]);
  db.save();
}

function listForUser(userId, { includeDisabled = false } = {}) {
  const raw = db._raw();
  const q = includeDisabled
    ? 'SELECT id, user_id, name, last_used_at, created_at, disabled_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC'
    : 'SELECT id, user_id, name, last_used_at, created_at, disabled_at FROM api_keys WHERE user_id = ? AND disabled_at IS NULL ORDER BY created_at DESC';
  const stmt = raw.prepare(q);
  stmt.bind([userId]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

module.exports = { generateApiKey, lookupByToken, disableApiKey, listForUser };
