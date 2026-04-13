/**
 * MOTHERSHIP — Kind module resolver
 *
 * Loads `<kindsDir>/<name>/index.js`, attaches schema.sql if present,
 * and provides shallow-merge with per-instance custom.js.
 *
 * Kinds directory override:
 *   - MOTHERSHIP_KINDS_DIR env var
 *   - `kindsDir` option on loadKind
 *   - default: src/satellite-kinds/
 */

const fs = require('fs');
const path = require('path');

function defaultKindsDir() {
  return process.env.MOTHERSHIP_KINDS_DIR ||
         path.join(__dirname, '..', 'satellite-kinds');
}

function loadKind(name, { kindsDir = defaultKindsDir() } = {}) {
  const dir = path.join(kindsDir, name);
  const indexPath = path.join(dir, 'index.js');
  if (!fs.existsSync(indexPath)) {
    throw new Error(`kind not found: ${name} (looked at ${indexPath})`);
  }

  // Bust require cache so tests picking up a fresh fixture get the latest.
  delete require.cache[require.resolve(indexPath)];
  const mod = require(indexPath);

  const schemaPath = path.join(dir, 'schema.sql');
  const schema = fs.existsSync(schemaPath) ? fs.readFileSync(schemaPath, 'utf8') : '';

  return { ...mod, schema };
}

/**
 * Shallow-merge `custom` over `base`. Top-level keys from custom replace
 * top-level keys in base. directiveHandlers and handlers are REPLACED
 * wholesale (not merged), so custom modules must re-export any handlers
 * they want to keep from the base kind.
 */
function mergeCustom(base, custom) {
  if (!custom) return base;
  return { ...base, ...custom };
}

module.exports = { loadKind, mergeCustom, defaultKindsDir };
