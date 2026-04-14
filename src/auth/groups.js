/**
 * MOTHERSHIP — Groups CRUD + membership
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../database');

function createGroup({ name, description = null }) {
  if (!name || typeof name !== 'string') throw new Error('name required');
  const raw = db._raw();
  const stmt = raw.prepare('SELECT id FROM groups WHERE name = ?');
  stmt.bind([name]);
  if (stmt.step()) { stmt.free(); throw new Error(`group already exists: ${name}`); }
  stmt.free();

  const id = uuidv4();
  raw.run('INSERT INTO groups (id, name, description) VALUES (?, ?, ?)', [id, name, description]);
  db.save();
  return id;
}

function getGroup(id) {
  const raw = db._raw();
  const stmt = raw.prepare('SELECT * FROM groups WHERE id = ?');
  stmt.bind([id]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function listGroups() {
  const raw = db._raw();
  const stmt = raw.prepare('SELECT * FROM groups ORDER BY created_at ASC');
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function addMember(groupId, userId) {
  const raw = db._raw();
  raw.run(
    'INSERT OR IGNORE INTO group_memberships (user_id, group_id) VALUES (?, ?)',
    [userId, groupId]
  );
  db.save();
}

function removeMember(groupId, userId) {
  const raw = db._raw();
  raw.run(
    'DELETE FROM group_memberships WHERE user_id = ? AND group_id = ?',
    [userId, groupId]
  );
  db.save();
}

function getGroupsForUser(userId) {
  const raw = db._raw();
  const stmt = raw.prepare(`
    SELECT g.* FROM groups g
    JOIN group_memberships gm ON gm.group_id = g.id
    WHERE gm.user_id = ?
    ORDER BY g.created_at ASC
  `);
  stmt.bind([userId]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function deleteGroup(id) {
  const raw = db._raw();
  raw.run('DELETE FROM group_memberships WHERE group_id = ?', [id]);
  raw.run('DELETE FROM groups WHERE id = ?', [id]);
  raw.run("DELETE FROM role_assignments WHERE principal_type = 'group' AND principal_id = ?", [id]);
  db.save();
}

module.exports = {
  createGroup, getGroup, listGroups,
  addMember, removeMember, getGroupsForUser, deleteGroup
};
