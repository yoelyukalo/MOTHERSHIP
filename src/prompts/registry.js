/**
 * MOTHERSHIP — Prompt Registry
 *
 * Versioned prompt store. Every synthesis/system prompt used anywhere in the
 * codebase is loaded through registry.getPrompt(name). Versions are immutable;
 * activating a new version flips the is_active flag and invalidates the cache.
 *
 * If a prompt is requested but has no active row, a per-prompt FALLBACK string
 * is returned (registered via setFallback). Callers that need guaranteed
 * availability should always register their fallback at module load.
 */

const db = require('../database');

const cache = new Map();        // name -> body
const fallbacks = new Map();    // name -> body

function _invalidate(name) { cache.delete(name); }
function _invalidateAll() { cache.clear(); }

function setFallback(name, body) {
  fallbacks.set(name, body);
}

function getPrompt(name) {
  if (cache.has(name)) return cache.get(name);
  let row = null;
  try {
    row = db.getActivePromptVersion(name);
  } catch {
    // DB unavailable (e.g. not initialized, table missing). Fall through
    // to the registered fallback below — the whole point of fallbacks
    // is to keep load-bearing prompts reachable when the DB is degraded.
  }
  if (row && row.body) {
    cache.set(name, row.body);
    return row.body;
  }
  if (fallbacks.has(name)) {
    return fallbacks.get(name);
  }
  throw new Error(`getPrompt: '${name}' has no active version and no fallback`);
}

function listVersions(name) {
  return db.listPromptVersions(name);
}

function listActive() {
  return db.getActivePromptVersions();
}

function createVersion(name, body, { createdBy = 'manual', parentVersion = null, activate = false } = {}) {
  if (!name) throw new Error('createVersion: name required');
  if (!body) throw new Error('createVersion: body required');
  const maxV = db.getMaxPromptVersion(name);
  const version = maxV + 1;
  db.addPromptVersion({ name, version, body, isActive: 0, createdBy, parentVersion });
  if (activate) {
    activateVersion(name, version);
  }
  return version;
}

function activateVersion(name, version) {
  db.setActivePromptVersion(name, version);
  _invalidate(name);
}

module.exports = {
  getPrompt, listVersions, listActive,
  createVersion, activateVersion,
  setFallback,
  _invalidate, _invalidateAll
};
