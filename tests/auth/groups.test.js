const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-auth-groups-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');

const db = require('../../src/database');
const users = require('../../src/auth/users');
const groups = require('../../src/auth/groups');

let u1, u2;
before(async () => {
  await db.init();
  u1 = await users.createUser({ email: 'a@x', password: 'p' });
  u2 = await users.createUser({ email: 'b@x', password: 'p' });
});
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test('groups — createGroup + getGroup', () => {
  const id = groups.createGroup({ name: 'tx-auto-staff', description: 'Texas Auto Center staff' });
  assert.ok(id);
  const g = groups.getGroup(id);
  assert.strictEqual(g.name, 'tx-auto-staff');
});

test('groups — createGroup rejects duplicate name', () => {
  assert.throws(
    () => groups.createGroup({ name: 'tx-auto-staff' }),
    /already exists/
  );
});

test('groups — addMember + getGroupsForUser', () => {
  const g = groups.listGroups()[0];
  groups.addMember(g.id, u1);
  groups.addMember(g.id, u2);
  const forU1 = groups.getGroupsForUser(u1);
  assert.strictEqual(forU1.length, 1);
  assert.strictEqual(forU1[0].name, 'tx-auto-staff');
});

test('groups — removeMember', () => {
  const g = groups.listGroups()[0];
  groups.removeMember(g.id, u2);
  assert.strictEqual(groups.getGroupsForUser(u2).length, 0);
});

test('groups — deleteGroup removes the group and its memberships', () => {
  const g = groups.listGroups()[0];
  groups.deleteGroup(g.id);
  assert.strictEqual(groups.getGroup(g.id), null);
  assert.strictEqual(groups.getGroupsForUser(u1).length, 0);
});
