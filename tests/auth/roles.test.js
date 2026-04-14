const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-auth-roles-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');

const db = require('../../src/database');
const roles = require('../../src/auth/roles');

before(async () => { await db.init(); });
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test('roles — PERMISSIONS constant has expected atoms', () => {
  const names = roles.PERMISSIONS.map(p => p.name);
  for (const required of [
    'user.create', 'user.list', 'user.disable', 'user.reset_password',
    'invitation.create', 'role.assign', 'group.create',
    'mirror.read', 'wiki.read', 'message.read', 'chat.send',
    'mirror.read_any', 'wiki.read_any', 'message.read_any',
    'log.read', 'export.run', 'briefing.run',
    'draft.create', 'draft.read', 'draft.edit_status', 'draft.regenerate_brief',
    'satellite.create', 'satellite.list', 'satellite.read',
    'satellite.edit_config', 'satellite.issue_directive', 'satellite.read_directives',
    'satellite.archive', 'satellite.unarchive', 'satellite.transfer', 'satellite.set_visibility'
  ]) {
    assert.ok(names.includes(required), `missing permission ${required}`);
  }
});

test('roles — ROLES constant has all 9 seed roles', () => {
  const names = roles.ROLES.map(r => r.name);
  for (const required of [
    'mothership_admin', 'user_manager', 'viewer', 'observer', 'draft_author',
    'satellite_owner', 'satellite_editor', 'satellite_directive_issuer', 'satellite_viewer'
  ]) {
    assert.ok(names.includes(required), `missing role ${required}`);
  }
});

test('roles — seedOnce populates all tables', async () => {
  await roles.seedOnce(db);
  const raw = db._raw();
  const permCount = raw.exec('SELECT COUNT(*) FROM permissions')[0].values[0][0];
  const roleCount = raw.exec('SELECT COUNT(*) FROM roles')[0].values[0][0];
  const rpCount = raw.exec('SELECT COUNT(*) FROM role_permissions')[0].values[0][0];
  assert.ok(permCount >= 30);
  assert.ok(roleCount >= 9);
  assert.ok(rpCount > 0);
});

test('roles — seedOnce is idempotent', async () => {
  const raw = db._raw();
  const before = raw.exec('SELECT COUNT(*) FROM permissions')[0].values[0][0];
  await roles.seedOnce(db);
  await roles.seedOnce(db);
  const after = raw.exec('SELECT COUNT(*) FROM permissions')[0].values[0][0];
  assert.strictEqual(before, after);
});

test('roles — viewer role has self-scoped read permissions', async () => {
  const raw = db._raw();
  const viewerIdRow = raw.exec("SELECT id FROM roles WHERE name = 'viewer'");
  const viewerId = viewerIdRow[0].values[0][0];
  const stmt = raw.prepare(`
    SELECT p.name FROM permissions p
    JOIN role_permissions rp ON rp.permission_id = p.id
    WHERE rp.role_id = ?
  `);
  stmt.bind([viewerId]);
  const perms = [];
  while (stmt.step()) perms.push(stmt.getAsObject().name);
  stmt.free();
  for (const required of ['chat.send', 'mirror.read', 'wiki.read', 'message.read', 'satellite.list']) {
    assert.ok(perms.includes(required), `viewer missing ${required}`);
  }
  assert.ok(!perms.includes('mirror.read_any'), 'viewer must not have cross-user read');
});

test('roles — observer has cross-user read permissions', async () => {
  const raw = db._raw();
  const observerIdRow = raw.exec("SELECT id FROM roles WHERE name = 'observer'");
  const observerId = observerIdRow[0].values[0][0];
  const stmt = raw.prepare(`
    SELECT p.name FROM permissions p
    JOIN role_permissions rp ON rp.permission_id = p.id
    WHERE rp.role_id = ?
  `);
  stmt.bind([observerId]);
  const perms = [];
  while (stmt.step()) perms.push(stmt.getAsObject().name);
  stmt.free();
  for (const required of ['mirror.read_any', 'wiki.read_any', 'message.read_any']) {
    assert.ok(perms.includes(required), `observer missing ${required}`);
  }
});
