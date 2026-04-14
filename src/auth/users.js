/**
 * MOTHERSHIP — Users CRUD
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const hashing = require('./hashing');

async function createUser({ email, display_name = null, password = null, auth_method = 'password', notes = null }) {
  if (!email || typeof email !== 'string') throw new Error('email required');
  if (getUserByEmail(email)) throw new Error(`user already exists: ${email}`);

  let password_hash = null;
  if (auth_method === 'password') {
    if (!password) throw new Error('password required for auth_method=password');
    password_hash = await hashing.hash(password);
  } else if (auth_method !== 'api_key_only') {
    throw new Error(`invalid auth_method: ${auth_method}`);
  }

  const id = uuidv4();
  const raw = db._raw();
  raw.run(
    `INSERT INTO users (id, email, display_name, auth_method, password_hash, notes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, email, display_name, auth_method, password_hash, notes]
  );
  db.save();
  return id;
}

function getUserByEmail(email) {
  const raw = db._raw();
  const stmt = raw.prepare('SELECT * FROM users WHERE email = ?');
  stmt.bind([email]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function getUserById(id) {
  const raw = db._raw();
  const stmt = raw.prepare('SELECT * FROM users WHERE id = ?');
  stmt.bind([id]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function listUsers({ includeDisabled = true } = {}) {
  const raw = db._raw();
  const q = includeDisabled
    ? 'SELECT * FROM users ORDER BY created_at ASC'
    : 'SELECT * FROM users WHERE disabled_at IS NULL ORDER BY created_at ASC';
  const stmt = raw.prepare(q);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function disableUser(id) {
  const raw = db._raw();
  raw.run(`UPDATE users SET disabled_at = datetime('now') WHERE id = ?`, [id]);
  db.save();
}

async function updatePassword(id, newPassword) {
  const hash = await hashing.hash(newPassword);
  const raw = db._raw();
  raw.run(`UPDATE users SET password_hash = ? WHERE id = ?`, [hash, id]);
  db.save();
}

module.exports = {
  createUser, getUserByEmail, getUserById, listUsers, disableUser, updatePassword
};
