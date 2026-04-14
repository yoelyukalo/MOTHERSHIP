/**
 * MOTHERSHIP — User / invitation / role-assignment / group management routes
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const users = require('../auth/users');
const sessions = require('../auth/sessions');
const apiKeys = require('../auth/api-keys');
const groups = require('../auth/groups');
const invitations = require('../auth/invitations');
const { requireAuth, requireAnyAuth } = require('../auth/middleware');

// Strip password_hash before serializing a user row to HTTP. The hash is
// needed inside the process (for verify) but must never cross the network
// boundary, even to authenticated admin callers.
function safeUser(row) {
  if (!row) return row;
  const { password_hash, ...rest } = row;
  return rest;
}

// Helper: grant viewer role to a newly-created user (idempotent)
function grantViewerRole(userId, grantedBy) {
  const raw = db._raw();
  const stmt = raw.prepare("SELECT id FROM roles WHERE name = 'viewer'");
  stmt.step();
  const viewerRoleId = stmt.getAsObject().id;
  stmt.free();
  raw.run(
    `INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id, granted_by)
     VALUES (?, 'user', ?, ?, NULL, ?)`,
    [uuidv4(), userId, viewerRoleId, grantedBy]
  );
  db.save();
}

// --- /api/users ---

router.post('/users', requireAuth({ permission: 'user.create' }), async (req, res) => {
  try {
    const { email, password, display_name, auth_method, notes, skip_default_roles } = req.body || {};
    const id = await users.createUser({ email, password, display_name, auth_method, notes });
    if (!skip_default_roles) grantViewerRole(id, req.user.id);
    res.json({ id, email });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/users', requireAuth({ permission: 'user.list' }), (req, res) => {
  res.json(users.listUsers().map(safeUser));
});

router.get('/users/:id', requireAuth({ permission: 'user.list' }), (req, res) => {
  const u = users.getUserById(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  res.json(safeUser(u));
});

router.patch('/users/:id/disable', requireAuth({ permission: 'user.disable' }), (req, res) => {
  users.disableUser(req.params.id);
  // Invalidate all existing sessions for the disabled user so any in-flight
  // cookies stop working immediately (the middleware also rejects disabled
  // users, but we don't want dead sessions sitting in the table).
  sessions.invalidateAllSessionsForUser(req.params.id);
  res.json({ ok: true });
});

router.patch('/users/:id/password', requireAuth({ permission: 'user.reset_password' }), async (req, res) => {
  const { new_password } = req.body || {};
  if (!new_password) return res.status(400).json({ error: 'new_password required' });
  await users.updatePassword(req.params.id, new_password);
  // Admin-forced reset: invalidate every session for the target user. The
  // admin is not the target user, so there is no "current session" to
  // preserve — we drop them all. Target user must log in again.
  sessions.invalidateAllSessionsForUser(req.params.id);
  db.log('info', 'auth.admin_password_reset', `user_id=${req.params.id} reset_by=${req.user.id}`);
  res.json({ ok: true });
});

// --- API keys (self-or-admin check in handler) ---

function canManageApiKeysFor(req, targetUserId) {
  if (req.user.id === targetUserId) return true;
  return req.user.can('user.reset_password');
}

router.post('/users/:id/api-keys', requireAnyAuth(), async (req, res) => {
  if (!canManageApiKeysFor(req, req.params.id)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const result = await apiKeys.generateApiKey(req.params.id, name);
  res.json({ id: result.id, name, token: result.plaintext });
});

router.get('/users/:id/api-keys', requireAnyAuth(), (req, res) => {
  if (!canManageApiKeysFor(req, req.params.id)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json(apiKeys.listForUser(req.params.id));
});

router.delete('/users/:id/api-keys/:keyId', requireAnyAuth(), (req, res) => {
  if (!canManageApiKeysFor(req, req.params.id)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  apiKeys.disableApiKey(req.params.keyId);
  res.json({ ok: true });
});

// --- /api/invitations ---

router.post('/invitations', requireAuth({ permission: 'invitation.create' }), async (req, res) => {
  const { email, role_grants = [], expires_in_days = 7 } = req.body || {};
  const inv = await invitations.generateInvitation({
    invitedBy: req.user.id, roleGrants: role_grants, expiresInDays: expires_in_days, email
  });
  res.json({ id: inv.id, token: inv.token, expires_at: inv.expires_at });
});

router.get('/invitations', requireAuth({ permission: 'invitation.list' }), (req, res) => {
  res.json(invitations.listInvitations());
});

router.delete('/invitations/:id', requireAuth({ permission: 'invitation.revoke' }), (req, res) => {
  invitations.revokeInvitation(req.params.id);
  res.json({ ok: true });
});

// --- /api/role-assignments ---

router.post('/role-assignments', requireAuth({ permission: 'role.assign' }), (req, res) => {
  const { principal_type, principal_id, role_id, satellite_id = null } = req.body || {};
  if (!['user', 'group'].includes(principal_type)) {
    return res.status(400).json({ error: 'principal_type must be user or group' });
  }
  const raw = db._raw();
  const roleStmt = raw.prepare('SELECT kind FROM roles WHERE id = ?');
  roleStmt.bind([role_id]);
  if (!roleStmt.step()) { roleStmt.free(); return res.status(400).json({ error: 'unknown role' }); }
  const kind = roleStmt.getAsObject().kind;
  roleStmt.free();
  if (kind === 'system' && satellite_id !== null) {
    return res.status(400).json({ error: 'system role cannot be satellite-scoped' });
  }
  if (kind === 'satellite' && !satellite_id) {
    return res.status(400).json({ error: 'satellite role requires satellite_id' });
  }
  const id = uuidv4();
  raw.run(
    `INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id, granted_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, principal_type, principal_id, role_id, satellite_id, req.user.id]
  );
  db.save();
  res.json({ id });
});

router.get('/role-assignments', requireAuth({ permission: 'role.assign' }), (req, res) => {
  const raw = db._raw();
  const stmt = raw.prepare('SELECT * FROM role_assignments ORDER BY created_at DESC');
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  res.json(rows);
});

router.delete('/role-assignments/:id', requireAuth({ permission: 'role.revoke' }), (req, res) => {
  const raw = db._raw();
  raw.run('DELETE FROM role_assignments WHERE id = ?', [req.params.id]);
  db.save();
  res.json({ ok: true });
});

// --- /api/groups ---

router.post('/groups', requireAuth({ permission: 'group.create' }), (req, res) => {
  try {
    const id = groups.createGroup({ name: req.body.name, description: req.body.description });
    res.json({ id });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/groups', requireAuth({ permission: 'group.create' }), (req, res) => {
  res.json(groups.listGroups());
});

router.delete('/groups/:id', requireAuth({ permission: 'group.delete' }), (req, res) => {
  groups.deleteGroup(req.params.id);
  res.json({ ok: true });
});

router.post('/groups/:id/members', requireAuth({ permission: 'group.edit' }), (req, res) => {
  const { user_id } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  groups.addMember(req.params.id, user_id);
  res.json({ ok: true });
});

router.delete('/groups/:id/members/:userId', requireAuth({ permission: 'group.edit' }), (req, res) => {
  groups.removeMember(req.params.id, req.params.userId);
  res.json({ ok: true });
});

module.exports = router;
