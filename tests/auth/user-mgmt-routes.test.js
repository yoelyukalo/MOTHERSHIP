const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-user-mgmt-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');

const db = require('../../src/database');
const auth = require('../../src/auth');
const users = require('../../src/auth/users');
const sessions = require('../../src/auth/sessions');
const userMgmtRoutes = require('../../src/routes/users');
const { v4: uuidv4 } = require('uuid');

let server, baseUrl, adminCookie, viewerCookie;

before(async () => {
  await db.init();
  await auth.init();

  const adminId = await users.createUser({ email: 'admin@x', password: 'p' });
  const viewerId = await users.createUser({ email: 'viewer@x', password: 'p' });
  const raw = db._raw();
  function getRole(name) {
    const stmt = raw.prepare('SELECT id FROM roles WHERE name = ?');
    stmt.bind([name]);
    stmt.step();
    const id = stmt.getAsObject().id;
    stmt.free();
    return id;
  }
  raw.run(`INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id) VALUES (?, 'user', ?, ?, NULL)`, [uuidv4(), adminId, getRole('mothership_admin')]);
  raw.run(`INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id) VALUES (?, 'user', ?, ?, NULL)`, [uuidv4(), viewerId, getRole('viewer')]);
  db.save();

  adminCookie = `mothership_sid=${sessions.createSession(adminId, {}).id}`;
  viewerCookie = `mothership_sid=${sessions.createSession(viewerId, {}).id}`;

  const app = express();
  app.use(express.json());
  app.use('/api', userMgmtRoutes);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await auth.shutdown();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function req(method, pathname, body, cookie) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${baseUrl}${pathname}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

test('user-mgmt — POST /users requires user.create (viewer fails)', async () => {
  const r = await req('POST', '/api/users', { email: 'new@x', password: 'p' }, viewerCookie);
  assert.strictEqual(r.status, 403);
});

test('user-mgmt — POST /users as admin succeeds and auto-grants viewer', async () => {
  const r = await req('POST', '/api/users', { email: 'newuser@x', password: 'p', display_name: 'New' }, adminCookie);
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.id);
  const raw = db._raw();
  const stmt = raw.prepare(`
    SELECT r.name FROM role_assignments ra
    JOIN roles r ON r.id = ra.role_id
    WHERE ra.principal_type = 'user' AND ra.principal_id = ?
  `);
  stmt.bind([r.body.id]);
  const grants = [];
  while (stmt.step()) grants.push(stmt.getAsObject().name);
  stmt.free();
  assert.ok(grants.includes('viewer'));
});

test('user-mgmt — GET /users as admin returns list', async () => {
  const r = await req('GET', '/api/users', null, adminCookie);
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body));
  assert.ok(r.body.length >= 3);
});

test('user-mgmt — POST /invitations creates invitation with token', async () => {
  const raw = db._raw();
  const stmt = raw.prepare("SELECT id FROM roles WHERE name = 'draft_author'");
  stmt.step();
  const draftRoleId = stmt.getAsObject().id;
  stmt.free();
  const r = await req('POST', '/api/invitations',
    { role_grants: [{ role_id: draftRoleId, satellite_id: null }], expires_in_days: 7 },
    adminCookie
  );
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.token);
  assert.ok(r.body.token.startsWith('mi_'));
});

test('user-mgmt — POST /role-assignments grants role', async () => {
  const all = users.listUsers();
  const target = all.find(u => u.email === 'newuser@x');
  const raw = db._raw();
  const stmt = raw.prepare("SELECT id FROM roles WHERE name = 'draft_author'");
  stmt.step();
  const draftRoleId = stmt.getAsObject().id;
  stmt.free();
  const r = await req('POST', '/api/role-assignments',
    { principal_type: 'user', principal_id: target.id, role_id: draftRoleId },
    adminCookie
  );
  assert.strictEqual(r.status, 200);
});

test('user-mgmt — POST /groups creates group', async () => {
  const r = await req('POST', '/api/groups', { name: 'tx-staff', description: 'test' }, adminCookie);
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.id);
});

test('user-mgmt — POST /users/:id/api-keys self-flow (create own key)', async () => {
  const viewer = users.getUserByEmail('viewer@x');
  const r = await req('POST', `/api/users/${viewer.id}/api-keys`, { name: 'my-key' }, viewerCookie);
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.token);
  assert.ok(r.body.token.startsWith('mk_live_'));
});

test('user-mgmt — POST /users/:id/api-keys across-user as viewer fails', async () => {
  const admin = users.getUserByEmail('admin@x');
  const r = await req('POST', `/api/users/${admin.id}/api-keys`, { name: 'sneaky' }, viewerCookie);
  assert.strictEqual(r.status, 403);
});
