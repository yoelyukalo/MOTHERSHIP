const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-retrofit-'));
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

let server, baseUrl, adminCookie;

before(async () => {
  await db.init();
  await auth.init();
  await satellites.init();

  const adminId = await users.createUser({ email: 'admin@x', password: 'p' });
  const raw = db._raw();
  const stmt = raw.prepare("SELECT id FROM roles WHERE name = 'mothership_admin'");
  stmt.step();
  const adminRole = stmt.getAsObject().id;
  stmt.free();
  raw.run(`INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id) VALUES (?, 'user', ?, ?, NULL)`, [uuidv4(), adminId, adminRole]);
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

const GATED_ROUTES = [
  ['GET', '/api/messages'],
  ['GET', '/api/mirror'],
  ['GET', '/api/mirror/entries'],
  ['GET', '/api/wiki/entries'],
  ['GET', '/api/logs'],
  ['GET', '/api/satellites'],
  ['GET', '/api/satellites/drafts'],
  ['GET', '/api/users'],
  ['POST', '/api/satellites'],
  ['POST', '/api/export'],
  ['POST', '/api/briefing']
];

for (const [method, pathname] of GATED_ROUTES) {
  test(`retrofit — anonymous ${method} ${pathname} returns 401`, async () => {
    const r = await fetch(`${baseUrl}${pathname}`, {
      method, headers: { 'Content-Type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined
    });
    assert.strictEqual(r.status, 401, `expected 401 for ${method} ${pathname}, got ${r.status}`);
  });
}

for (const [method, pathname] of GATED_ROUTES) {
  test(`retrofit — admin ${method} ${pathname} is NOT 401`, async () => {
    const r = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: method === 'POST' ? '{}' : undefined
    });
    assert.notStrictEqual(r.status, 401, `admin got 401 on ${method} ${pathname}`);
  });
}

test('retrofit — GET /api/status is public', async () => {
  const r = await fetch(`${baseUrl}/api/status`);
  assert.strictEqual(r.status, 200);
});
