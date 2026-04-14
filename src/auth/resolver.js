/**
 * MOTHERSHIP — Permission resolver
 *
 * loadUserWithPermissions(userId) builds a req.user object with cached
 * permission set + can() method. Called from the auth middleware once
 * per request after credential validation.
 */

const db = require('../database');
const users = require('./users');
const registry = require('../satellites/registry');

async function loadUserWithPermissions(userId) {
  const user = users.getUserById(userId);
  if (!user) return null;

  const raw = db._raw();

  // Collect all role assignments for this user directly AND via group memberships
  const stmt = raw.prepare(`
    SELECT ra.role_id, ra.satellite_id, r.name AS role_name
    FROM role_assignments ra
    JOIN roles r ON r.id = ra.role_id
    WHERE (ra.principal_type = 'user' AND ra.principal_id = ?)
       OR (ra.principal_type = 'group' AND ra.principal_id IN (
            SELECT group_id FROM group_memberships WHERE user_id = ?
          ))
  `);
  stmt.bind([userId, userId]);
  const assignments = [];
  while (stmt.step()) assignments.push(stmt.getAsObject());
  stmt.free();

  // System roles: assignments with no satellite_id scope
  const systemRoles = [...new Set(
    assignments
      .filter(a => a.satellite_id === null || a.satellite_id === undefined || a.satellite_id === '')
      .map(a => a.role_name)
  )];

  const isAdmin = systemRoles.includes('mothership_admin');

  // Build permissionSet: "{permission_name}|{satellite_id}" or "{permission_name}|GLOBAL"
  // Skip entirely for admins — can() bypasses it anyway, and we avoid unnecessary DB work.
  const permissionSet = new Set();
  if (!isAdmin) {
    for (const a of assignments) {
      const permStmt = raw.prepare(`
        SELECT p.name FROM permissions p
        JOIN role_permissions rp ON rp.permission_id = p.id
        WHERE rp.role_id = ?
      `);
      permStmt.bind([a.role_id]);
      while (permStmt.step()) {
        const permName = permStmt.getAsObject().name;
        // Satellite-scoped assignment uses the satellite UUID as the key suffix;
        // system assignment (satellite_id NULL) uses the GLOBAL sentinel.
        const suffix = (a.satellite_id && a.satellite_id !== '') ? a.satellite_id : 'GLOBAL';
        permissionSet.add(`${permName}|${suffix}`);
      }
      permStmt.free();
    }
  }

  const row = {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    auth_method: user.auth_method,
    password_hash: user.password_hash,
    disabled_at: user.disabled_at,
    systemRoles,
    permissionSet
  };

  /**
   * can(permission, satelliteSlugOrId?)
   *
   * Resolution order:
   * 1. mothership_admin → always true.
   * 2. Direct satellite-scoped key  → "{permission}|{satId}"
   * 3. GLOBAL-fallback              → "{permission}|GLOBAL"
   *    (covers system roles whose permissions apply across all satellites)
   *
   * If satelliteSlugOrId is provided and looks like a slug (not a UUID),
   * resolve it to an id via the registry. If the slug is unknown, fall
   * through to checking the raw input as-if it were already an id
   * (handles the caller passing a UUID directly).
   */
  row.can = function can(permission, satelliteSlugOrId = null) {
    if (isAdmin) return true;

    let satId = null;
    if (satelliteSlugOrId) {
      const satRow = registry.getBySlug(satelliteSlugOrId);
      satId = satRow ? satRow.id : satelliteSlugOrId;
    }

    if (satId) {
      // Satellite-scoped check first
      if (permissionSet.has(`${permission}|${satId}`)) return true;
      // GLOBAL fallback — system-role permissions apply everywhere
      if (permissionSet.has(`${permission}|GLOBAL`)) return true;
      return false;
    }

    // No satellite context — check GLOBAL only
    return permissionSet.has(`${permission}|GLOBAL`);
  };

  return row;
}

module.exports = { loadUserWithPermissions };
