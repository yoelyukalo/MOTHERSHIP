/**
 * MOTHERSHIP — Auth roles & permissions seed
 *
 * Source of truth for the RBAC model. seedOnce(db) inserts rows idempotently.
 */

const { v4: uuidv4 } = require('uuid');

const PERMISSIONS = [
  { name: 'user.create',          description: 'Create new users directly' },
  { name: 'user.list',            description: 'List all users' },
  { name: 'user.disable',         description: 'Disable a user account' },
  { name: 'user.reset_password',  description: 'Admin-reset another user password' },
  { name: 'invitation.create',    description: 'Generate invitation links' },
  { name: 'invitation.list',      description: 'List outstanding invitations' },
  { name: 'invitation.revoke',    description: 'Revoke an unclaimed invitation' },
  { name: 'role.assign',          description: 'Grant roles to users or groups' },
  { name: 'role.revoke',          description: 'Revoke role assignments' },
  { name: 'group.create',         description: 'Create groups' },
  { name: 'group.edit',           description: 'Edit group membership and metadata' },
  { name: 'group.delete',         description: 'Delete groups' },

  { name: 'mirror.read',          description: 'Read your own Quantum Mirror entries' },
  { name: 'wiki.read',            description: 'Read your own Wiki entries' },
  { name: 'message.read',         description: 'Read your own ingested messages' },
  { name: 'chat.send',            description: 'Send chat turns to Mothership' },

  { name: 'mirror.read_any',      description: "Read any user's Mirror" },
  { name: 'wiki.read_any',        description: "Read any user's Wiki" },
  { name: 'message.read_any',     description: "Read any user's messages" },

  { name: 'log.read',             description: 'Read system logs' },
  { name: 'export.run',           description: 'Run export jobs' },
  { name: 'briefing.run',         description: 'Run synthesis briefings' },

  { name: 'draft.create',         description: 'Create satellite drafts' },
  { name: 'draft.read',           description: 'Read satellite drafts' },
  { name: 'draft.edit_status',    description: 'Change a drafts status' },
  { name: 'draft.regenerate_brief', description: 'Regenerate a drafts brief via LLM' },

  { name: 'satellite.create',     description: 'Create new satellites' },
  { name: 'satellite.list',       description: 'List satellites the caller can see' },
  { name: 'satellite.read',       description: 'Read a satellites registry row + loaded db' },
  { name: 'satellite.edit_config',     description: 'Edit a satellites config' },
  { name: 'satellite.issue_directive', description: 'Issue directives to a satellite' },
  { name: 'satellite.read_directives', description: 'Read a satellites directive history' },
  { name: 'satellite.archive',    description: 'Archive a satellite' },
  { name: 'satellite.unarchive',  description: 'Unarchive a satellite' },
  { name: 'satellite.transfer',   description: 'Transfer a satellite to a client' },
  { name: 'satellite.set_visibility', description: 'Change a satellites visibility tier' }
];

const ROLES = [
  { name: 'mothership_admin', kind: 'system',
    description: 'Superuser — bypasses all checks',
    permissions: '*' },

  { name: 'user_manager', kind: 'system',
    description: 'Manages users, invitations, role assignments',
    permissions: [
      'user.create', 'user.list', 'user.disable', 'user.reset_password',
      'invitation.create', 'invitation.list', 'invitation.revoke',
      'role.assign', 'role.revoke',
      'group.create', 'group.edit', 'group.delete'
    ] },

  { name: 'viewer', kind: 'system',
    description: 'Baseline role for authenticated users — access to own scope',
    permissions: [
      'chat.send', 'mirror.read', 'wiki.read', 'message.read',
      'draft.read', 'satellite.list'
    ] },

  { name: 'observer', kind: 'system',
    description: 'Admin read-only across all users',
    permissions: [
      'mirror.read_any', 'wiki.read_any', 'message.read_any',
      'log.read', 'draft.read', 'satellite.list'
    ] },

  { name: 'draft_author', kind: 'system',
    description: 'Creates and edits satellite drafts',
    permissions: [
      'draft.create', 'draft.read', 'draft.edit_status', 'draft.regenerate_brief'
    ] },

  { name: 'satellite_owner', kind: 'satellite',
    description: 'Full control over a specific satellite',
    permissions: [
      'satellite.read', 'satellite.edit_config',
      'satellite.issue_directive', 'satellite.read_directives',
      'satellite.archive', 'satellite.unarchive',
      'satellite.transfer', 'satellite.set_visibility'
    ] },

  { name: 'satellite_editor', kind: 'satellite',
    description: 'Edit config and issue directives',
    permissions: [
      'satellite.read', 'satellite.edit_config',
      'satellite.issue_directive', 'satellite.read_directives'
    ] },

  { name: 'satellite_directive_issuer', kind: 'satellite',
    description: 'Issue directives only (shaped for Claude Code and automation bots)',
    permissions: [
      'satellite.read', 'satellite.issue_directive', 'satellite.read_directives'
    ] },

  { name: 'satellite_viewer', kind: 'satellite',
    description: 'Read-only at the current visibility tier',
    permissions: [
      'satellite.read', 'satellite.read_directives'
    ] }
];

async function seedOnce(db) {
  const raw = db._raw();

  // Permissions
  for (const p of PERMISSIONS) {
    const stmt = raw.prepare('SELECT id FROM permissions WHERE name = ?');
    stmt.bind([p.name]);
    const exists = stmt.step();
    stmt.free();
    if (exists) continue;
    raw.run(
      'INSERT INTO permissions (id, name, description) VALUES (?, ?, ?)',
      [uuidv4(), p.name, p.description]
    );
  }

  // Roles
  for (const r of ROLES) {
    const stmt = raw.prepare('SELECT id FROM roles WHERE name = ?');
    stmt.bind([r.name]);
    const exists = stmt.step();
    stmt.free();
    if (exists) continue;
    raw.run(
      'INSERT INTO roles (id, name, kind, description) VALUES (?, ?, ?, ?)',
      [uuidv4(), r.name, r.kind, r.description]
    );
  }

  // Role-permission links
  for (const r of ROLES) {
    if (r.permissions === '*') continue; // mothership_admin — bypass in resolver
    const roleStmt = raw.prepare('SELECT id FROM roles WHERE name = ?');
    roleStmt.bind([r.name]);
    if (!roleStmt.step()) { roleStmt.free(); continue; }
    const roleId = roleStmt.getAsObject().id;
    roleStmt.free();

    for (const permName of r.permissions) {
      const permStmt = raw.prepare('SELECT id FROM permissions WHERE name = ?');
      permStmt.bind([permName]);
      if (!permStmt.step()) { permStmt.free(); continue; }
      const permId = permStmt.getAsObject().id;
      permStmt.free();

      const existsStmt = raw.prepare(
        'SELECT 1 FROM role_permissions WHERE role_id = ? AND permission_id = ?'
      );
      existsStmt.bind([roleId, permId]);
      const linkExists = existsStmt.step();
      existsStmt.free();
      if (linkExists) continue;

      raw.run(
        'INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
        [roleId, permId]
      );
    }
  }

  db.save();
}

module.exports = { PERMISSIONS, ROLES, seedOnce };
