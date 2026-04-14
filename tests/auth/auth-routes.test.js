const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-auth-routes-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');

const db = require('../../src/database');
const auth = require('../../src/auth');
const users = require('../../src/auth/users');
const authRoutes = require('../../src/routes/auth');
const { v4: uuidv4 } = require('uuid');

let server, baseUrl, yoelCookie;

before(async () => {
  await db.init();
  await auth.init();

  const yoelId = await users.createUser({ email: 'yoel@x', password: 'correct-horse', display_name: 'Yoel' });
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
    [uuidv4(), yoelId, getRole('mothership_admin')]);
  raw.run(`INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id) VALUES (?, 'user', ?, ?, NULL)`,
    [uuidv4(), yoelId, getRole('viewer')]);
  db.save();

  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await auth.shutdown();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function req(method, pathname, body, headers = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const setCookie = res.headers.get('set-cookie');
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed, setCookie };
}

test('auth-routes — POST /login with bad password → 401', async () => {
  const r = await req('POST', '/api/auth/login', { email: 'yoel@x', password: 'wrong' });
  assert.strictEqual(r.status, 401);
});

test('auth-routes — POST /login with correct password → 200 + cookie', async () => {
  const r = await req('POST', '/api/auth/login', { email: 'yoel@x', password: 'correct-horse' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.user.email, 'yoel@x');
  assert.ok(r.setCookie);
  assert.match(r.setCookie, /mothership_sid=/);
  assert.match(r.setCookie, /HttpOnly/);
  assert.match(r.setCookie, /SameSite=Lax/);
  yoelCookie = r.setCookie.split(';')[0];
});

test('auth-routes — GET /me with session returns user + permissions', async () => {
  const r = await req('GET', '/api/auth/me', null, { Cookie: yoelCookie });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.user.email, 'yoel@x');
  assert.ok(Array.isArray(r.body.permissions));
});

test('auth-routes — GET /me without session → 401', async () => {
  const r = await req('GET', '/api/auth/me');
  assert.strictEqual(r.status, 401);
});

test('auth-routes — POST /logout clears session', async () => {
  const loginRes = await req('POST', '/api/auth/login', { email: 'yoel@x', password: 'correct-horse' });
  const sid = loginRes.setCookie.split(';')[0];
  const logoutRes = await req('POST', '/api/auth/logout', {}, { Cookie: sid });
  assert.strictEqual(logoutRes.status, 204);
  const meRes = await req('GET', '/api/auth/me', null, { Cookie: sid });
  assert.strictEqual(meRes.status, 401);
});

test('auth-routes — login rate limit trips after 5 failures', async () => {
  for (let i = 0; i < 5; i++) {
    const r = await req('POST', '/api/auth/login', { email: 'yoel@x', password: 'wrong' });
    assert.strictEqual(r.status, 401);
  }
  const r6 = await req('POST', '/api/auth/login', { email: 'yoel@x', password: 'wrong' });
  assert.strictEqual(r6.status, 429);
});
