const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-auth-resolver-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');
process.env.MOTHERSHIP_SATELLITES_DIR = path.join(tmpRoot, 'satellites');
process.env.MOTHERSHIP_KINDS_DIR = path.join(__dirname, '..', 'fixtures', 'satellite-kinds');
fs.mkdirSync(process.env.MOTHERSHIP_SATELLITES_DIR, { recursive: true });

const db = require('../../src/database');
const users = require('../../src/auth/users');
const groups = require('../../src/auth/groups');
const authRoles = require('../../src/auth/roles');
const resolver = require('../../src/auth/resolver');
const registry = require('../../src/satellites/registry');
const { v4: uuidv4 } = require('uuid');

let admin, staff, botUser, satId;

before(async () => {
  await db.init();
  await authRoles.seedOnce(db);

  admin = await users.createUser({ email: 'admin@x', password: 'p' });
  staff = await users.createUser({ email: 'staff@x', password: 'p' });
  botUser = await users.createUser({ email: 'bot@x', auth_method: 'api_key_only' });

  const sat = await registry.createInstance({ slug: 'fix-sat', name: 'Fixture', kind: 'test-kind' });
  satId = sat.id;

  const raw = db._raw();
  function getRoleId(name) {
    const stmt = raw.prepare('SELECT id FROM roles WHERE name = ?');
    stmt.bind([name]);
    stmt.step();
    const id = stmt.getAsObject().id;
    stmt.free();
    return id;
  }

  raw.run(`INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id) VALUES (?, 'user', ?, ?, NULL)`,
    [uuidv4(), admin, getRoleId('mothership_admin')]);
  raw.run(`INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id) VALUES (?, 'user', ?, ?, NULL)`,
    [uuidv4(), admin, getRoleId('viewer')]);
  raw.run(`INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id) VALUES (?, 'user', ?, ?, NULL)`,
    [uuidv4(), staff, getRoleId('viewer')]);
  raw.run(`INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id) VALUES (?, 'user', ?, ?, ?)`,
    [uuidv4(), staff, getRoleId('satellite_editor'), satId]);

  const gId = groups.createGroup({ name: 'bots' });
  groups.addMember(gId, botUser);
  raw.run(`INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id) VALUES (?, 'group', ?, ?, ?)`,
    [uuidv4(), gId, getRoleId('satellite_directive_issuer'), satId]);
  db.save();
});

after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test('resolver — mothership_admin bypass grants everything', async () => {
  const u = await resolver.loadUserWithPermissions(admin);
  assert.strictEqual(u.can('user.create'), true);
  assert.strictEqual(u.can('satellite.issue_directive', 'fix-sat'), true);
  assert.strictEqual(u.can('totally.nonexistent'), true);
});

test('resolver — viewer has self-scoped reads', async () => {
  const u = await resolver.loadUserWithPermissions(staff);
  assert.strictEqual(u.can('mirror.read'), true);
  assert.strictEqual(u.can('wiki.read'), true);
  assert.strictEqual(u.can('chat.send'), true);
  assert.strictEqual(u.can('mirror.read_any'), false);
});

test('resolver — satellite_editor grants per-satellite permissions', async () => {
  const u = await resolver.loadUserWithPermissions(staff);
  assert.strictEqual(u.can('satellite.issue_directive', 'fix-sat'), true);
  assert.strictEqual(u.can('satellite.edit_config', 'fix-sat'), true);
  assert.strictEqual(u.can('satellite.archive', 'fix-sat'), false);
  assert.strictEqual(u.can('satellite.issue_directive', 'other-sat'), false);
});

test('resolver — group-inherited role works', async () => {
  const u = await resolver.loadUserWithPermissions(botUser);
  assert.strictEqual(u.can('satellite.issue_directive', 'fix-sat'), true);
  assert.strictEqual(u.can('satellite.edit_config', 'fix-sat'), false);
});

test('resolver — unknown permission returns false (not admin)', async () => {
  const u = await resolver.loadUserWithPermissions(staff);
  assert.strictEqual(u.can('totally.nonexistent'), false);
});
