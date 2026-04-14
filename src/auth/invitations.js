/**
 * MOTHERSHIP — Invitations
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const users = require('./users');
const hashing = require('./hashing');

const TOKEN_PREFIX = 'mi_';

function newPlaintextToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

function daysFromNow(n) {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000)
    .toISOString().replace('T', ' ').replace('Z', '');
}

async function generateInvitation({ invitedBy, roleGrants = [], expiresInDays = 7, email = null }) {
  if (!invitedBy) throw new Error('invitedBy required');
  const plaintext = newPlaintextToken();
  const token_hash = await hashing.hash(plaintext);
  const id = uuidv4();
  const expires_at = daysFromNow(expiresInDays);
  const raw = db._raw();
  raw.run(
    `INSERT INTO invitations (id, token_hash, email, invited_by, role_grants_json, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, token_hash, email, invitedBy, JSON.stringify(roleGrants), expires_at]
  );
  db.save();
  return { id, token: plaintext, expires_at };
}

async function findByToken(plaintext) {
  if (!plaintext || !plaintext.startsWith(TOKEN_PREFIX)) return null;
  const raw = db._raw();
  const stmt = raw.prepare('SELECT * FROM invitations WHERE claimed_at IS NULL');
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  for (const row of rows) {
    if (await hashing.verify(row.token_hash, plaintext)) return row;
  }
  return null;
}

async function claimInvitation({ token, password, displayName }) {
  const inv = await findByToken(token);
  if (!inv) throw new Error('invitation not found or already claimed');
  if (new Date(inv.expires_at.replace(' ', 'T') + 'Z') < new Date()) {
    throw new Error('invitation expired');
  }

  const raw = db._raw();
  const viewerStmt = raw.prepare("SELECT id FROM roles WHERE name = 'viewer'");
  viewerStmt.step();
  const viewerRoleId = viewerStmt.getAsObject().id;
  viewerStmt.free();

  let newUserId;
  try {
    newUserId = await users.createUser({
      email: inv.email || `user-${inv.id.slice(0, 8)}@mothership`,
      display_name: displayName,
      password,
      auth_method: 'password'
    });

    raw.run(
      `INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id, granted_by)
       VALUES (?, 'user', ?, ?, NULL, ?)`,
      [uuidv4(), newUserId, viewerRoleId, inv.invited_by]
    );

    const grants = JSON.parse(inv.role_grants_json || '[]');
    for (const g of grants) {
      raw.run(
        `INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id, granted_by)
         VALUES (?, 'user', ?, ?, ?, ?)`,
        [uuidv4(), newUserId, g.role_id, g.satellite_id || null, inv.invited_by]
      );
    }

    raw.run(
      `UPDATE invitations SET claimed_at = datetime('now'), claimed_by_user_id = ? WHERE id = ?`,
      [newUserId, inv.id]
    );
    db.save();

    return { userId: newUserId, invitationId: inv.id };
  } catch (err) {
    if (newUserId) {
      try { raw.run('DELETE FROM users WHERE id = ?', [newUserId]); } catch (_) {}
      try { raw.run(`DELETE FROM role_assignments WHERE principal_type = 'user' AND principal_id = ?`, [newUserId]); } catch (_) {}
      db.save();
    }
    throw err;
  }
}

function listInvitations({ onlyActive = false } = {}) {
  const raw = db._raw();
  const q = onlyActive
    ? `SELECT * FROM invitations WHERE claimed_at IS NULL AND expires_at > datetime('now') ORDER BY created_at DESC`
    : `SELECT * FROM invitations ORDER BY created_at DESC`;
  const stmt = raw.prepare(q);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function revokeInvitation(id) {
  const raw = db._raw();
  raw.run('DELETE FROM invitations WHERE id = ?', [id]);
  db.save();
}

module.exports = { generateInvitation, claimInvitation, listInvitations, revokeInvitation };
