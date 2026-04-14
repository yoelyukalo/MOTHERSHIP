/**
 * MOTHERSHIP — Satellite loader
 *
 * Boot-time and hot-register loader. Holds raw writable DB handles in a
 * private closure and exposes only sovereignty-wrapped handles through
 * the public map. The raw handle is passed EXCLUSIVELY into:
 *   - directive handlers (via directives.js, by reference)
 *   - lifecycle hooks (onBoot/onArchive)
 *
 * Nothing else in Mothership can obtain a raw handle.
 */

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const db = require('../database');
const registry = require('./registry');
const kinds = require('./kinds');
const sovereignty = require('./sovereignty');
const directives = require('./directives');

// Public map: slug → { kind, db: wrapped, config, handlers, dispose }
const publicMap = new Map();

// Private map: slug → { rawDb, kindModule, config, directivesStop }
const privateMap = new Map();

// In-flight register promises, keyed by slug. Prevents concurrent
// register(slug) calls from racing — both would open their own DB handle
// and the loser would be silently orphaned (WASM heap leak + dangling
// chokidar watcher). Idempotency holds under concurrency via this map.
const registering = new Map();

let SQL = null;
async function getSQL() {
  if (!SQL) SQL = await initSqlJs();
  return SQL;
}

async function init() {
  const rows = registry.listRows({ status: 'active' })
    .filter(r => r.kind !== 'embedded');
  for (const row of rows) {
    try {
      await register(row.slug);
    } catch (err) {
      db.log('error', 'satellites.loader', `failed to register ${row.slug}: ${err.message}`);
      registry.updateStatus(row.slug, 'broken');
    }
  }
}

function register(slug) {
  if (publicMap.has(slug)) return Promise.resolve(publicMap.get(slug));
  if (registering.has(slug)) return registering.get(slug);
  const p = _doRegister(slug).finally(() => registering.delete(slug));
  registering.set(slug, p);
  return p;
}

async function _doRegister(slug) {
  const row = registry.getBySlug(slug);
  if (!row) throw new Error(`no such satellite: ${slug}`);

  let kindModule;
  try {
    kindModule = kinds.loadKind(row.kind);
  } catch (err) {
    registry.updateStatus(slug, 'broken');
    db.log('error', 'satellites.loader', `kind load failed for ${slug}: ${err.message}`);
    throw err;
  }

  // Optional per-instance custom.js override
  const customPath = path.join(registry.satellitesDir(), slug, 'custom.js');
  if (fs.existsSync(customPath)) {
    delete require.cache[require.resolve(customPath)];
    const custom = require(customPath);
    kindModule = kinds.mergeCustom(kindModule, custom);
  }

  // Open or create the satellite DB
  const paths = registry.instancePaths(slug);
  const sqlLib = await getSQL();
  let rawDb;
  if (fs.existsSync(paths.dbFile)) {
    rawDb = new sqlLib.Database(fs.readFileSync(paths.dbFile));
  } else {
    // Fresh DB: apply baseline + kind schema
    rawDb = new sqlLib.Database();
    rawDb.exec(registry.BASELINE_SCHEMA);
    if (kindModule.schema) rawDb.exec(kindModule.schema);
    flushDb(rawDb, paths.dbFile);
  }

  const config = row.config_json ? JSON.parse(row.config_json) : (kindModule.defaultConfig || {});
  const logger = registry.consoleLogger(slug);

  // onBoot lifecycle hook. A failure here marks the satellite broken and
  // aborts registration — callers get a thrown error and the spec's §14
  // "boot failure → broken" invariant holds.
  if (kindModule.onBoot) {
    try {
      await kindModule.onBoot({ db: rawDb, config, logger });
      flushDb(rawDb, paths.dbFile);
    } catch (err) {
      try { rawDb.close(); } catch (_) {}
      registry.updateStatus(slug, 'broken');
      db.log('error', 'satellites.loader', `onBoot failed for ${slug}: ${err.message}`);
      throw err;
    }
  }

  const wrapped = sovereignty.wrap(rawDb, { visibility: row.visibility });

  // Start directive consumer. It closes over rawDb; we flush after each directive.
  const directivesStop = await directives.start(slug, {
    rawDb,
    kindModule,
    config,
    logger,
    dbFile: paths.dbFile,
    flush: () => flushDb(rawDb, paths.dbFile)
  });

  const entry = {
    kind: row.kind,
    db: wrapped,
    config,
    handlers: kindModule.handlers || {},
    dispose: async () => { await unregister(slug); }
  };
  publicMap.set(slug, entry);
  privateMap.set(slug, { rawDb, kindModule, config, directivesStop });

  return entry;
}

async function unregister(slug) {
  const priv = privateMap.get(slug);
  if (priv) {
    try { if (priv.directivesStop) await priv.directivesStop(); } catch (_) {}
    try { priv.rawDb.close(); } catch (_) {}
  }
  privateMap.delete(slug);
  publicMap.delete(slug);
}

async function shutdown() {
  for (const slug of Array.from(publicMap.keys())) {
    await unregister(slug);
  }
}

function get(slug) {
  return publicMap.get(slug);
}

function list() {
  return Array.from(publicMap.keys());
}

function flushDb(rawDb, filePath) {
  const bytes = rawDb.export();
  fs.writeFileSync(filePath, Buffer.from(bytes));
}

module.exports = { init, register, unregister, shutdown, get, list };
