const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-auth-so-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');

const db = require('../../src/database');
const users = require('../../src/auth/users');
const authRoles = require('../../src/auth/roles');
const systemOwner = require('../../src/auth/system-owner');
const { v4: uuidv4 } = require('uuid');

before(async () => {
  await db.init();
  await authRoles.seedOnce(db);
  systemOwner.clearCache();
});
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test('system-owner — returns null when no admin exists', () => {
  assert.strictEqual(systemOwner.getSystemOwnerId(), null);
});

test('system-owner — returns admin id when one exists', async () => {
  const id = await users.createUser({ email: 'admin@x', password: 'p' });
  const raw = db._raw();
  const stmt = raw.prepare("SELECT id FROM roles WHERE name = 'mothership_admin'");
  stmt.step();
  const adminRoleId = stmt.getAsObject().id;
  stmt.free();
  raw.run(
    `INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id)
     VALUES (?, 'user', ?, ?, NULL)`,
    [uuidv4(), id, adminRoleId]
  );
  db.save();
  systemOwner.clearCache();
  assert.strictEqual(systemOwner.getSystemOwnerId(), id);
});

test('system-owner — returns oldest admin when multiple exist', async () => {
  const raw = db._raw();
  const first = systemOwner.getSystemOwnerId();
  const newerId = await users.createUser({ email: 'admin2@x', password: 'p' });
  const stmt = raw.prepare("SELECT id FROM roles WHERE name = 'mothership_admin'");
  stmt.step();
  const adminRoleId = stmt.getAsObject().id;
  stmt.free();
  raw.run(
    `INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id)
     VALUES (?, 'user', ?, ?, NULL)`,
    [uuidv4(), newerId, adminRoleId]
  );
  db.save();
  systemOwner.clearCache();
  assert.strictEqual(systemOwner.getSystemOwnerId(), first);
});
