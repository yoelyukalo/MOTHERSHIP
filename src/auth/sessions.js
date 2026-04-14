/**
 * MOTHERSHIP — Sessions CRUD + expiry sweep
 */

const crypto = require('crypto');
const db = require('../database');

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

function newSessionId() {
  return crypto.randomBytes(32).toString('base64url');
}

function createSession(userId, { ip = null, userAgent = null } = {}) {
  const id = newSessionId();
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS).toISOString().replace('T', ' ').replace('Z', '');
  const raw = db._raw();
  raw.run(
    `INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)`,
    [id, userId, expiresAt, ip, userAgent]
  );
  db.save();
  return { id, user_id: userId, expires_at: expiresAt };
}

function getSession(id) {
  const raw = db._raw();
  const stmt = raw.prepare('SELECT * FROM sessions WHERE id = ?');
  stmt.bind([id]);
  if (!stmt.step()) { stmt.free(); return null; }
  const row = stmt.getAsObject();
  stmt.free();

  if (new Date(row.expires_at.replace(' ', 'T') + 'Z') < new Date()) {
    raw.run('DELETE FROM sessions WHERE id = ?', [id]);
    db.save();
    return null;
  }

  raw.run(`UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ?`, [id]);
  db.save();
  return row;
}

function invalidateSession(id) {
  const raw = db._raw();
  raw.run('DELETE FROM sessions WHERE id = ?', [id]);
  db.save();
}

function invalidateAllSessionsForUser(userId, { exceptId = null } = {}) {
  const raw = db._raw();
  if (exceptId) {
    raw.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', [userId, exceptId]);
  } else {
    raw.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
  }
  db.save();
}

function sweepExpired() {
  const raw = db._raw();
  const beforeStmt = raw.prepare('SELECT COUNT(*) AS c FROM sessions');
  beforeStmt.step();
  const before = beforeStmt.getAsObject().c;
  beforeStmt.free();

  raw.run(`DELETE FROM sessions WHERE expires_at < datetime('now')`);

  const afterStmt = raw.prepare('SELECT COUNT(*) AS c FROM sessions');
  afterStmt.step();
  const after = afterStmt.getAsObject().c;
  afterStmt.free();

  db.save();
  return before - after;
}

let sweepTimer = null;
function startDailySweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepExpired, 24 * 60 * 60 * 1000);
  if (sweepTimer.unref) sweepTimer.unref();
}

function stopDailySweep() {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}

module.exports = {
  createSession, getSession, invalidateSession, invalidateAllSessionsForUser,
  sweepExpired, startDailySweep, stopDailySweep
};
