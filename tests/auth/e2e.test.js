const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-e2e-auth-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');
process.env.MOTHERSHIP_SATELLITES_DIR = path.join(tmpRoot, 'satellites');
process.env.MOTHERSHIP_KINDS_DIR = path.join(__dirname, '..', 'fixtures', 'satellite-kinds');
fs.mkdirSync(process.env.MOTHERSHIP_SATELLITES_DIR, { recursive: true });

const db = require('../../src/database');
const auth = require('../../src/auth');
const users = require('../../src/auth/users');
const sessions = require('../../src/auth/sessions');
const satellites = require('../../src/satellites');
const apiRoutes = require('../../src/routes/api');
const authRoutes = require('../../src/routes/auth');
const userMgmtRoutes = require('../../src/routes/users');
const { v4: uuidv4 } = require('uuid');

let server, baseUrl;
let adminId, adminCookie;

before(async () => {
  await db.init();
  await auth.init();
  await satellites.init();

  adminId = await users.createUser({ email: 'yoel@x', password: 'correct-horse', display_name: 'Yoel' });
  const raw = db._raw();
  function getRole(n) {
    const stmt = raw.prepare('SELECT id FROM roles WHERE name = ?');
    stmt.bind([n]);
    stmt.step();
    const id = stmt.getAsObject().id;
    stmt.free();
    return id;
  }
  raw.run(`INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id) VALUES (?, 'user', ?, ?, NULL)`, [uuidv4(), adminId, getRole('mothership_admin')]);
  raw.run(`INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id) VALUES (?, 'user', ?, ?, NULL)`, [uuidv4(), adminId, getRole('viewer')]);
  db.save();

  adminCookie = `mothership_sid=${sessions.createSession(adminId, {}).id}`;

  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use('/api', userMgmtRoutes);
  app.use('/api', apiRoutes);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await satellites.shutdown();
  await auth.shutdown();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function req(method, pathname, body, headers = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed, setCookie: res.headers.get('set-cookie') };
}

test('e2e — full multi-user flow with per-user Mirror isolation', async () => {
  // 1. Admin creates a fixture satellite
  let r = await req('POST', '/api/satellites', {
    slug: 'tx-auto', name: 'TX Auto', kind: 'test-kind'
  }, { Cookie: adminCookie });
  assert.strictEqual(r.status, 200, `create satellite failed: ${JSON.stringify(r.body)}`);
  const satId = r.body.id;

  // 2. Admin creates an invitation for a staff member with satellite_editor on tx-auto
  const raw = db._raw();
  const stmt = raw.prepare("SELECT id FROM roles WHERE name = 'satellite_editor'");
  stmt.step();
  const editorRoleId = stmt.getAsObject().id;
  stmt.free();
  r = await req('POST', '/api/invitations', {
    role_grants: [{ role_id: editorRoleId, satellite_id: satId }],
    expires_in_days: 7
  }, { Cookie: adminCookie });
  assert.strictEqual(r.status, 200);
  const invitationToken = r.body.token;

  // 3. Invitee claims the invitation
  r = await req('POST', '/api/auth/claim-invite', {
    token: invitationToken, password: 'staff-pass', display_name: 'Staff'
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.user.display_name, 'Staff');
  const staffCookie = r.setCookie.split(';')[0];

  // 4. Staff can issue a directive to tx-auto
  r = await req('POST', '/api/satellites/tx-auto/directives', {
    kind: 'config.set', payload: { key: 'greeting', value: 'hi' }
  }, { Cookie: staffCookie });
  assert.strictEqual(r.status, 200);

  // 5. Staff CANNOT archive tx-auto (satellite_editor lacks archive permission)
  r = await req('POST', '/api/satellites/tx-auto/archive', {}, { Cookie: staffCookie });
  assert.strictEqual(r.status, 403);

  // 6. Staff CANNOT see satellites they're not a member of
  await req('POST', '/api/satellites', { slug: 'dental', name: 'Dental', kind: 'test-kind' }, { Cookie: adminCookie });
  r = await req('GET', '/api/satellites', null, { Cookie: staffCookie });
  assert.strictEqual(r.status, 200);
  const visibleToStaff = r.body;
  assert.ok(visibleToStaff.some(s => s.slug === 'tx-auto'));
  assert.ok(!visibleToStaff.some(s => s.slug === 'dental'));

  // 7. Find staff id
  const staffStmt = raw.prepare("SELECT id FROM users WHERE display_name = 'Staff'");
  staffStmt.step();
  const staffId = staffStmt.getAsObject().id;
  staffStmt.free();

  // 8. Staff GETs their own messages — empty array (they haven't chatted yet)
  r = await req('GET', '/api/messages', null, { Cookie: staffCookie });
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body));

  // 9. Staff cannot fetch another user's messages via ?user_id=
  r = await req('GET', `/api/messages?user_id=${adminId}`, null, { Cookie: staffCookie });
  assert.strictEqual(r.status, 403);

  // 10. Admin disables the staff user
  r = await req('PATCH', `/api/users/${staffId}/disable`, {}, { Cookie: adminCookie });
  assert.strictEqual(r.status, 200);

  // 11. Staff's next request → 401
  r = await req('GET', '/api/auth/me', null, { Cookie: staffCookie });
  assert.strictEqual(r.status, 401);
});
