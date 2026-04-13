/**
 * MOTHERSHIP — Satellite sovereignty wrapper
 *
 * Wraps a raw sql.js Database so Mothership code can read from a satellite
 * (subject to visibility) but can never write to it. Writes can only happen
 * through the raw handle, which is held in a closure inside loader.js and
 * passed exclusively to directive handlers and lifecycle hooks.
 *
 * See docs/superpowers/specs/2026-04-13-satellite-model-and-registry-design.md
 * §4.3 for why this is module-boundary enforcement, not runtime reflection.
 */

const WRITE_KEYWORDS = /^(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|TRUNCATE|MERGE|GRANT|REVOKE|VACUUM|ATTACH|DETACH)\b/;
const READ_KEYWORDS = /^(SELECT|WITH|EXPLAIN|PRAGMA)\b/;

const LIMITED_TABLES = new Set([
  'satellite_meta',
  'satellite_logs',
  'satellite_directives_history'
]);

class SovereigntyViolation extends Error {
  constructor(sql) {
    super(`SovereigntyViolation: write attempted on a satellite DB via the wrapped handle: ${truncate(sql)}`);
    this.name = 'SovereigntyViolation';
  }
}

class VisibilityViolation extends Error {
  constructor(sql, visibility) {
    super(`VisibilityViolation: visibility=${visibility} does not permit: ${truncate(sql)}`);
    this.name = 'VisibilityViolation';
  }
}

function truncate(s) { return (s || '').slice(0, 120); }

function classify(sql) {
  const s = (sql || '').trim().toUpperCase();
  if (WRITE_KEYWORDS.test(s)) return 'write';
  if (READ_KEYWORDS.test(s)) return 'read';
  return 'unknown';
}

/**
 * Very small table-name extractor. Good enough for trusted internal
 * callers — we are not defending against adversarial SQL. Pulls every
 * identifier after FROM/JOIN.
 */
function referencedTables(sql) {
  const re = /\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
  const tables = new Set();
  let m;
  while ((m = re.exec(sql)) !== null) tables.add(m[1].toLowerCase());
  return tables;
}

function checkRead(sql, visibility) {
  if (visibility === 'full') return;
  if (visibility === 'none') throw new VisibilityViolation(sql, visibility);
  if (visibility === 'limited') {
    const tables = referencedTables(sql);
    // PRAGMA statements have no FROM — allow them under limited as metadata.
    if (tables.size === 0 && /^PRAGMA\b/i.test(sql.trim())) return;
    for (const t of tables) {
      if (!LIMITED_TABLES.has(t)) throw new VisibilityViolation(sql, visibility);
    }
  }
}

function wrap(rawDb, { visibility = 'full' } = {}) {
  return {
    exec(sql) {
      const kind = classify(sql);
      if (kind === 'write') throw new SovereigntyViolation(sql);
      checkRead(sql, visibility);
      return rawDb.exec(sql);
    },
    run(sql, params) {
      const kind = classify(sql);
      if (kind === 'write') throw new SovereigntyViolation(sql);
      checkRead(sql, visibility);
      return rawDb.run(sql, params);
    },
    prepare(sql) {
      const kind = classify(sql);
      if (kind === 'write') throw new SovereigntyViolation(sql);
      checkRead(sql, visibility);
      return rawDb.prepare(sql);
    }
  };
}

module.exports = { wrap, SovereigntyViolation, VisibilityViolation };
