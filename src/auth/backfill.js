/**
 * MOTHERSHIP — Per-user data backfill migration
 */

const db = require('../database');
const systemOwner = require('./system-owner');

const SENTINEL_KEY = 'meta.per_user_backfill_done';

async function runBackfillIfNeeded() {
  const existing = db.getConfig(SENTINEL_KEY);
  if (existing === 'true') {
    return { ran: false, reason: 'already_done' };
  }

  const adminId = systemOwner.getSystemOwnerId();
  if (!adminId) {
    return { ran: false, reason: 'no_admin_yet' };
  }

  const raw = db._raw();
  const counts = { messages: 0, mirror_entries: 0, wiki_entries: 0 };
  for (const t of ['messages', 'mirror_entries', 'wiki_entries']) {
    const beforeStmt = raw.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE user_id IS NULL`);
    beforeStmt.step();
    const before = beforeStmt.getAsObject().c;
    beforeStmt.free();
    if (before > 0) {
      raw.run(`UPDATE ${t} SET user_id = ? WHERE user_id IS NULL`, [adminId]);
      counts[t] = before;
    }
  }
  db.save();

  db.setConfig(SENTINEL_KEY, 'true');
  db.log('info', 'auth.backfill', 'per-user backfill complete', counts);

  return { ran: true, ...counts };
}

module.exports = { runBackfillIfNeeded };
