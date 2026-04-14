/**
 * MOTHERSHIP — System owner lookup
 *
 * Resolves to the oldest mothership_admin user id. Used by untethered
 * pipelines (Telegram bot, file watcher, health check) that have no
 * authenticated request context but still need to stamp ownership on
 * ingested rows.
 *
 * Returns null if no admin exists yet (pre-bootstrap state).
 */

const db = require('../database');

let cachedId = null;

function getSystemOwnerId() {
  if (cachedId) return cachedId;
  const raw = db._raw();
  const result = raw.exec(`
    SELECT u.id FROM users u
    JOIN role_assignments ra ON ra.principal_id = u.id AND ra.principal_type = 'user'
    JOIN roles r ON r.id = ra.role_id
    WHERE r.name = 'mothership_admin' AND u.disabled_at IS NULL
    ORDER BY u.created_at ASC
    LIMIT 1
  `);
  if (!result.length || !result[0].values.length) return null;
  cachedId = result[0].values[0][0];
  return cachedId;
}

function clearCache() {
  cachedId = null;
}

module.exports = { getSystemOwnerId, clearCache };
