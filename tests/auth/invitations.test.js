const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-auth-inv-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');

const db = require('../../src/database');
const users = require('../../src/auth/users');
const authRoles = require('../../src/auth/roles');
const invitations = require('../../src/auth/invitations');

let inviterId, viewerRoleId, editorRoleId;

before(async () => {
  await db.init();
  await authRoles.seedOnce(db);
  inviterId = await users.createUser({ email: 'admin@x', password: 'p' });
  const raw = db._raw();
  const viewerStmt = raw.prepare("SELECT id FROM roles WHERE name = 'viewer'");
  viewerStmt.step();
  viewerRoleId = viewerStmt.getAsObject().id;
  viewerStmt.free();
  const editorStmt = raw.prepare("SELECT id FROM roles WHERE name = 'draft_author'");
  editorStmt.step();
  editorRoleId = editorStmt.getAsObject().id;
  editorStmt.free();
});
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test('invitations — generate returns plaintext token with mi_ prefix', async () => {
  const inv = await invitations.generateInvitation({
    invitedBy: inviterId,
    roleGrants: [{ role_id: editorRoleId, satellite_id: null }],
    expiresInDays: 7
  });
  assert.ok(inv.id);
  assert.ok(inv.token.startsWith('mi_'));
  assert.ok(inv.expires_at);
});

test('invitations — claim creates user, auto-grants viewer, applies role grants', async () => {
  const inv = await invitations.generateInvitation({
    invitedBy: inviterId,
    roleGrants: [{ role_id: editorRoleId, satellite_id: null }],
    expiresInDays: 7
  });
  const result = await invitations.claimInvitation({
    token: inv.token,
    password: 'new-password',
    displayName: 'New User'
  });
  assert.ok(result.userId);
  const newUser = users.getUserById(result.userId);
  assert.strictEqual(newUser.display_name, 'New User');

  const raw = db._raw();
  const stmt = raw.prepare(`
    SELECT r.name FROM role_assignments ra
    JOIN roles r ON r.id = ra.role_id
    WHERE ra.principal_type = 'user' AND ra.principal_id = ?
  `);
  stmt.bind([result.userId]);
  const roleNames = [];
  while (stmt.step()) roleNames.push(stmt.getAsObject().name);
  stmt.free();
  assert.ok(roleNames.includes('viewer'));
  assert.ok(roleNames.includes('draft_author'));
});

test('invitations — double-claim fails', async () => {
  const inv = await invitations.generateInvitation({
    invitedBy: inviterId, roleGrants: [], expiresInDays: 7
  });
  await invitations.claimInvitation({ token: inv.token, password: 'x', displayName: 'A' });
  await assert.rejects(
    invitations.claimInvitation({ token: inv.token, password: 'y', displayName: 'B' }),
    /already claimed|not found/
  );
});

test('invitations — expired claim fails', async () => {
  const inv = await invitations.generateInvitation({
    invitedBy: inviterId, roleGrants: [], expiresInDays: 7
  });
  const raw = db._raw();
  raw.run(`UPDATE invitations SET expires_at = datetime('now', '-1 day') WHERE id = ?`, [inv.id]);
  db.save();
  await assert.rejects(
    invitations.claimInvitation({ token: inv.token, password: 'x', displayName: 'A' }),
    /expired/
  );
});

test('invitations — revoke prevents future claims', async () => {
  const inv = await invitations.generateInvitation({
    invitedBy: inviterId, roleGrants: [], expiresInDays: 7
  });
  invitations.revokeInvitation(inv.id);
  await assert.rejects(
    invitations.claimInvitation({ token: inv.token, password: 'x', displayName: 'A' }),
    /not found|already claimed|expired/
  );
});
