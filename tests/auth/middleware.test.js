const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-auth-mw-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');

const db = require('../../src/database');
const users = require('../../src/auth/users');
const sessions = require('../../src/auth/sessions');
const apiKeys = require('../../src/auth/api-keys');
const authRoles = require('../../src/auth/roles');
const middleware = require('../../src/auth/middleware');
const { v4: uuidv4 } = require('uuid');

let adminId, adminSession, staffId, staffSession, botId, botToken;
let server, baseUrl;

before(async () => {
  await db.init();
  await authRoles.seedOnce(db);

  adminId = await users.createUser({ email: 'admin@x', password: 'p' });
  staffId = await users.createUser({ email: 'staff@x', password: 'p' });
  botId = await users.createUser({ email: 'bot@x', auth_method: 'api_key_only' });

  const raw = db._raw();
  function getRole(name) {
    const stmt = raw.prepare('SELECT id FROM roles WHERE name = ?');
    stmt.bind([name]);
    stmt.step();
    const id = stmt.getAsObject().id;
    stmt.free();
    return id;
  }
  raw.run(`INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id) VALUES (?, 'user', ?, ?, NULL)`,
    [uuidv4(), adminId, getRole('mothership_admin')]);
  raw.run(`INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id) VALUES (?, 'user', ?, ?, NULL)`,
    [uuidv4(), staffId, getRole('viewer')]);
  raw.run(`INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id) VALUES (?, 'user', ?, ?, NULL)`,
    [uuidv4(), botId, getRole('viewer')]);
  db.save();

  adminSession = sessions.createSession(adminId, {});
  staffSession = sessions.createSession(staffId, {});
  const k = await apiKeys.generateApiKey(botId, 'test-bot');
  botToken = k.plaintext;

  const app = express();
  app.use(express.json());
  app.get('/need-admin', middleware.requireAuth({ permission: 'user.create' }), (req, res) => {
    res.json({ ok: true, user: req.user.email });
  });
  app.get('/need-chat', middleware.requireAuth({ permission: 'chat.send' }), (req, res) => {
    res.json({ ok: true });
  });
  app.get('/need-any', middleware.requireAnyAuth(), (req, res) => {
    res.json({ ok: true, user: req.user.email });
  });
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function req(pathname, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const res = await fetch(`${baseUrl}${pathname}`, { ...opts, headers });
  return { status: res.status, body: await res.text().then(t => { try { return JSON.parse(t); } catch { return t; } }) };
}

test('middleware — no credentials → 401', async () => {
  const r = await req('/need-any');
  assert.strictEqual(r.status, 401);
});

test('middleware — invalid cookie → 401', async () => {
  const r = await req('/need-any', { headers: { Cookie: 'mothership_sid=bogus' } });
  assert.strictEqual(r.status, 401);
});

test('middleware — valid admin cookie + right permission → 200', async () => {
  const r = await req('/need-admin', { headers: { Cookie: `mothership_sid=${adminSession.id}` } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.user, 'admin@x');
});

test('middleware — staff cookie + admin permission → 403', async () => {
  const r = await req('/need-admin', { headers: { Cookie: `mothership_sid=${staffSession.id}` } });
  assert.strictEqual(r.status, 403);
});

test('middleware — staff cookie + chat permission → 200 (viewer has chat.send)', async () => {
  const r = await req('/need-chat', { headers: { Cookie: `mothership_sid=${staffSession.id}` } });
  assert.strictEqual(r.status, 200);
});

test('middleware — bearer token works', async () => {
  const r = await req('/need-any', { headers: { Authorization: `Bearer ${botToken}` } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.user, 'bot@x');
});

test('middleware — wrong bearer token → 401', async () => {
  const r = await req('/need-any', { headers: { Authorization: 'Bearer mk_live_wrong' } });
  assert.strictEqual(r.status, 401);
});

test('middleware — disabled user → 401', async () => {
  users.disableUser(staffId);
  const r = await req('/need-any', { headers: { Cookie: `mothership_sid=${staffSession.id}` } });
  assert.strictEqual(r.status, 401);
});
