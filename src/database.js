/**
 * MOTHERSHIP — Database Layer
 *
 * SQLite via sql.js (pure WASM, no native compilation needed).
 * Stores messages, categories, and system logs.
 */

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const taxonomy = require('./mirror-taxonomy');

const DB_PATH = process.env.MOTHERSHIP_DB_PATH || path.join(__dirname, '..', 'data', 'mothership.db');

// SQL literals for the 21 entry types, 5 layers, 4 statuses — used in CHECK
// constraints when (re)creating mirror_entries. Built once at module load.
const ENTRY_TYPE_SQL_LIST = taxonomy.ENTRY_TYPES.map(t => `'${t}'`).join(',');
const LAYER_SQL_LIST = taxonomy.LAYERS.map(l => `'${l}'`).join(',');
const STATUS_SQL_LIST = taxonomy.STATUSES.map(s => `'${s}'`).join(',');

const MIRROR_ENTRIES_CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS mirror_entries (
    id TEXT PRIMARY KEY,
    entry_type TEXT NOT NULL CHECK (entry_type IN (${ENTRY_TYPE_SQL_LIST})),
    layer TEXT NOT NULL CHECK (layer IN (${LAYER_SQL_LIST})),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN (${STATUS_SQL_LIST})),
    category TEXT NOT NULL,
    content TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.5,
    related_ids TEXT NOT NULL DEFAULT '[]',
    source_type TEXT NOT NULL,
    source_id TEXT,
    embedding BLOB,
    user_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    superseded_by TEXT
  )
`;

let db = null;

async function init() {
  const SQL = await initSqlJs();

  // Load existing database or create new one
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'unknown',
      category TEXT DEFAULT 'uncategorized',
      tags TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      metadata TEXT DEFAULT '{}'
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS logs (
      id TEXT PRIMARY KEY,
      level TEXT NOT NULL DEFAULT 'info',
      source TEXT NOT NULL,
      message TEXT NOT NULL,
      data TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(MIRROR_ENTRIES_CREATE_SQL);

  db.run(`
    CREATE TABLE IF NOT EXISTS wiki_entries (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL UNIQUE,
      summary TEXT NOT NULL,
      source_ids TEXT DEFAULT '[]',
      tags TEXT DEFAULT '[]',
      embedding BLOB,
      contradictions TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_wiki_topic ON wiki_entries(topic)`);

  // --- Auth (Phase 6 #2) ---

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT,
      auth_method TEXT NOT NULL DEFAULT 'password',
      password_hash TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      disabled_at TEXT,
      notes TEXT
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_disabled ON users(disabled_at)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      last_seen_at TEXT DEFAULT (datetime('now')),
      ip TEXT,
      user_agent TEXT
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      scope_json TEXT,
      last_used_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      disabled_at TEXT
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(token_hash)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS group_memberships (
      user_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      added_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, group_id)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_group_memberships_user ON group_memberships(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_group_memberships_group ON group_memberships(group_id)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_roles_kind ON roles(kind)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS permissions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id TEXT NOT NULL,
      permission_id TEXT NOT NULL,
      PRIMARY KEY (role_id, permission_id)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_role_permissions_perm ON role_permissions(permission_id)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS role_assignments (
      id TEXT PRIMARY KEY,
      principal_type TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      satellite_id TEXT,
      granted_by TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_role_assignments_principal ON role_assignments(principal_type, principal_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_role_assignments_role ON role_assignments(role_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_role_assignments_satellite ON role_assignments(satellite_id)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS invitations (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      email TEXT,
      invited_by TEXT NOT NULL,
      role_grants_json TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      claimed_at TEXT,
      claimed_by_user_id TEXT
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_invitations_token ON invitations(token_hash)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_invitations_expires ON invitations(expires_at)`);

  // Per-user scoping (Phase 6 #2) — add user_id to three Mothership-core tables.
  // sql.js ALTER TABLE doesn't support IF NOT EXISTS, so check via PRAGMA.
  for (const t of ['messages', 'mirror_entries', 'wiki_entries']) {
    const info = db.exec(`PRAGMA table_info(${t})`);
    if (!info.length) continue;
    const cols = info[0].values.map(r => r[1]);
    if (!cols.includes('user_id')) {
      db.run(`ALTER TABLE ${t} ADD COLUMN user_id TEXT`);
    }
  }
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_wiki_entries_user ON wiki_entries(user_id)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS satellites (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      db_path TEXT,
      owner TEXT NOT NULL DEFAULT 'mothership',
      visibility TEXT NOT NULL DEFAULT 'full',
      status TEXT NOT NULL DEFAULT 'active',
      config_json TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      transferred_at TEXT,
      notes TEXT
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_satellites_kind ON satellites(kind)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_satellites_status ON satellites(status)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS satellite_drafts (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      kind TEXT,
      status TEXT NOT NULL DEFAULT 'discussing',
      brief_md TEXT,
      brief_updated_at TEXT,
      created_satellite_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_drafts_status ON satellite_drafts(status)`);

  // --- Phase 5: Action logger + reflection agent ---

  db.run(`
    CREATE TABLE IF NOT EXISTS actions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      subject TEXT NOT NULL,
      data TEXT DEFAULT '{}',
      confidence REAL DEFAULT 0.8,
      status TEXT DEFAULT 'active',
      source_type TEXT NOT NULL,
      source_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      resolved_at TEXT,
      parent_action_id TEXT
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_actions_user_created ON actions(user_id, created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_actions_kind_status ON actions(kind, status)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS reflections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      generated_at TEXT DEFAULT (datetime('now')),
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      briefing_md TEXT NOT NULL,
      action_count INTEGER,
      pattern_json TEXT DEFAULT '{}',
      self_critique_json TEXT DEFAULT '{}',
      delivered_telegram INTEGER DEFAULT 0,
      delivered_obsidian TEXT
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_reflections_user_generated ON reflections(user_id, generated_at)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS prompt_versions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version INTEGER NOT NULL,
      body TEXT NOT NULL,
      is_active INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      created_by TEXT,
      parent_version INTEGER,
      UNIQUE (name, version)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_prompt_versions_active ON prompt_versions(name, is_active)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS prompt_proposals (
      id TEXT PRIMARY KEY,
      prompt_name TEXT NOT NULL,
      base_version INTEGER NOT NULL,
      proposed_body TEXT NOT NULL,
      rationale TEXT NOT NULL,
      replay_results_json TEXT,
      replay_error TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      resolved_at TEXT
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_prompt_proposals_status ON prompt_proposals(status)`);

  migrateMirrorTaxonomyV3();

  db.run(`CREATE INDEX IF NOT EXISTS idx_mirror_category ON mirror_entries(category)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_mirror_active ON mirror_entries(superseded_by)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_mirror_entry_type ON mirror_entries(entry_type)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_mirror_layer ON mirror_entries(layer)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_mirror_status ON mirror_entries(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_mirror_entries_user ON mirror_entries(user_id)`);

  save();
  return db;
}

/**
 * One-shot migration from the v2 mirror_entries schema (single `category`
 * column) to the v3 schema (entry_type/layer/status/related_ids with CHECK
 * constraints).
 *
 * Strategy: rebuild the table. SQLite can't add NOT NULL columns with CHECK
 * constraints via ALTER TABLE, so we rename → create new → INSERT SELECT with
 * per-row mapping → drop old.
 *
 * Idempotent: if the table already has `entry_type`, this is a no-op.
 * Guarded further by a config flag so the remap audit log only fires once.
 */
function migrateMirrorTaxonomyV3() {
  const info = db.exec(`PRAGMA table_info(mirror_entries)`);
  if (!info.length) return;
  const cols = info[0].values.map(r => r[1]);
  if (cols.includes('entry_type')) return; // already v3

  const rowsRes = db.exec(`SELECT * FROM mirror_entries`);
  const rows = [];
  if (rowsRes.length) {
    const colNames = rowsRes[0].columns;
    for (const v of rowsRes[0].values) {
      const obj = {};
      colNames.forEach((c, i) => { obj[c] = v[i]; });
      rows.push(obj);
    }
  }

  // Rename out of the way. The new CREATE TABLE IF NOT EXISTS below would
  // otherwise no-op because the name is taken.
  db.run(`ALTER TABLE mirror_entries RENAME TO mirror_entries_legacy_v2`);
  db.run(MIRROR_ENTRIES_CREATE_SQL);

  const remaps = [];
  let migrated = 0;
  // One transaction for the whole rebuild: amortises fsync across rows and
  // keeps the legacy_v2 table and the new table mutually consistent on crash.
  db.run('BEGIN');
  try {
    for (const r of rows) {
      const { entryType, layer, remapped } =
        taxonomy.resolveEntryType(r.category);
      if (remapped) remaps.push({ id: r.id, from: r.category, to: entryType });
      db.run(
        `INSERT INTO mirror_entries
           (id, entry_type, layer, status, category, content, confidence,
            related_ids, source_type, source_id, embedding,
            created_at, updated_at, superseded_by, user_id)
         VALUES (?, ?, ?, 'active', ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?)`,
        [
          r.id,
          entryType,
          layer,
          entryType,
          r.content,
          r.confidence ?? 0.5,
          r.source_type,
          r.source_id,
          r.embedding,
          r.created_at,
          r.updated_at,
          r.superseded_by,
          r.user_id
        ]
      );
      migrated++;
    }
    db.run(`DROP TABLE mirror_entries_legacy_v2`);
    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }

  try {
    log('info', 'mirror-taxonomy',
        `migrated ${migrated} rows to v3 taxonomy; ${remaps.length} remapped`,
        { remaps: remaps.slice(0, 200) });
  } catch { /* logs table may not be ready in edge cases */ }
}

function save() {
  if (!db) return;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// --- Messages ---

function addMessage(content, source = 'unknown', category = 'uncategorized', metadata = {}, userId = null) {
  if (!userId) throw new Error('addMessage: userId is required');
  const id = uuidv4();
  db.run(
    `INSERT INTO messages (id, content, source, category, metadata, user_id) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, content, source, category, JSON.stringify(metadata), userId]
  );
  save();
  log('info', 'database', `Message added: [${source}] ${content.substring(0, 50)}...`);
  return id;
}

function getMessages({ limit = 50, offset = 0, source, category, search, userId = null, allUsers = false } = {}) {
  if (!userId && !allUsers) throw new Error('getMessages: userId required (or allUsers=true for admin)');
  let query = 'SELECT * FROM messages WHERE 1=1';
  const params = [];

  if (!allUsers) { query += ' AND user_id = ?'; params.push(userId); }
  if (source) { query += ' AND source = ?'; params.push(source); }
  if (category) { query += ' AND category = ?'; params.push(category); }
  if (search) { query += ' AND content LIKE ?'; params.push(`%${search}%`); }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const stmt = db.prepare(query);
  stmt.bind(params);

  const results = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    row.tags = JSON.parse(row.tags || '[]');
    row.metadata = JSON.parse(row.metadata || '{}');
    results.push(row);
  }
  stmt.free();
  return results;
}

function getMessageCount({ userId = null, allUsers = false } = {}) {
  if (!userId && !allUsers) throw new Error('getMessageCount: userId or allUsers required');
  let q = 'SELECT COUNT(*) as count FROM messages';
  const p = [];
  if (!allUsers) { q += ' WHERE user_id = ?'; p.push(userId); }
  const stmt = db.prepare(q);
  stmt.bind(p);
  stmt.step();
  const row = stmt.getAsObject();
  stmt.free();
  return row.count;
}

function getSourceCounts({ userId = null, allUsers = false } = {}) {
  if (!userId && !allUsers) throw new Error('getSourceCounts: userId or allUsers required');
  let q = 'SELECT source, COUNT(*) as count FROM messages';
  const p = [];
  if (!allUsers) { q += ' WHERE user_id = ?'; p.push(userId); }
  q += ' GROUP BY source ORDER BY count DESC';
  const stmt = db.prepare(q);
  if (p.length) stmt.bind(p);
  const rows = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    rows.push({ source: r.source, count: r.count });
  }
  stmt.free();
  return rows;
}

function getCategoryCounts({ userId = null, allUsers = false } = {}) {
  if (!userId && !allUsers) throw new Error('getCategoryCounts: userId or allUsers required');
  let q = 'SELECT category, COUNT(*) as count FROM messages';
  const p = [];
  if (!allUsers) { q += ' WHERE user_id = ?'; p.push(userId); }
  q += ' GROUP BY category ORDER BY count DESC';
  const stmt = db.prepare(q);
  if (p.length) stmt.bind(p);
  const rows = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    rows.push({ category: r.category, count: r.count });
  }
  stmt.free();
  return rows;
}

// --- Logs ---

function log(level, source, message, data = {}) {
  const id = uuidv4();
  db.run(
    `INSERT INTO logs (id, level, source, message, data) VALUES (?, ?, ?, ?, ?)`,
    [id, level, source, message, JSON.stringify(data)]
  );
  // Don't save on every log — batch saves happen elsewhere
}

function getLogs({ limit = 100, level } = {}) {
  let query = 'SELECT * FROM logs WHERE 1=1';
  const params = [];
  if (level) { query += ' AND level = ?'; params.push(level); }
  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const stmt = db.prepare(query);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    row.data = JSON.parse(row.data || '{}');
    results.push(row);
  }
  stmt.free();
  return results;
}

// --- Config ---

function getConfig(key, defaultValue = null) {
  const stmt = db.prepare('SELECT value FROM config WHERE key = ?');
  stmt.bind([key]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row.value;
  }
  stmt.free();
  return defaultValue;
}

function setConfig(key, value) {
  db.run(
    `INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
    [key, value]
  );
  save();
}

// --- Mirror Entries (v3 taxonomy — see src/mirror-taxonomy.js) ---
//
// Canonical field is `entry_type`. `category` is a legacy alias, populated
// on every write as a copy of entry_type and resolved through
// mirror-taxonomy.resolveEntryType() on read so pre-v3 filter strings still
// match the new vocabulary.

function _parseMirrorRow(row) {
  if (!row) return row;
  if (typeof row.related_ids === 'string') {
    try { row.related_ids = JSON.parse(row.related_ids || '[]'); }
    catch { row.related_ids = []; }
  }
  return row;
}

function addMirrorEntry({
  entry_type,
  category,
  content,
  confidence = 0.5,
  source_type,
  source_id = null,
  embedding = null,
  status = 'active',
  related_ids = [],
  userId = null
}) {
  if (!userId) throw new Error('addMirrorEntry: userId required');
  if (!content) throw new Error('addMirrorEntry: content required');
  if (!source_type) throw new Error('addMirrorEntry: source_type required');

  const { entryType, layer } = taxonomy.resolveEntryType(entry_type || category);
  if (!taxonomy.isValidStatus(status)) {
    throw new Error(`addMirrorEntry: invalid status '${status}'`);
  }
  const relatedJson = JSON.stringify(Array.isArray(related_ids) ? related_ids : []);

  const id = uuidv4();
  db.run(
    `INSERT INTO mirror_entries
       (id, entry_type, layer, status, category, content, confidence,
        related_ids, source_type, source_id, embedding, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, entryType, layer, status, entryType, content, confidence,
     relatedJson, source_type, source_id, embedding, userId]
  );
  save();
  return id;
}

function getMirrorEntries({
  entry_type = null,
  layer = null,
  status = null,
  category = null, // legacy alias — mapped through taxonomy if provided
  activeOnly = true,
  limit = 500,
  userId = null,
  allUsers = false
} = {}) {
  if (!userId && !allUsers) throw new Error('getMirrorEntries: userId or allUsers required');
  let q = 'SELECT * FROM mirror_entries WHERE 1=1';
  const p = [];
  if (!allUsers) { q += ' AND user_id = ?'; p.push(userId); }

  // entry_type takes precedence; category is a legacy alias that we resolve
  // through the taxonomy so callers filtering by 'mental_models' still match
  // the migrated 'model' rows.
  let typeFilter = entry_type;
  if (!typeFilter && category) {
    typeFilter = taxonomy.resolveEntryType(category).entryType;
  }
  if (typeFilter) { q += ' AND entry_type = ?'; p.push(typeFilter); }
  if (layer)      { q += ' AND layer = ?'; p.push(layer); }
  if (status)     { q += ' AND status = ?'; p.push(status); }
  if (activeOnly) { q += ' AND superseded_by IS NULL'; }

  q += ' ORDER BY updated_at DESC LIMIT ?';
  p.push(limit);

  const stmt = db.prepare(q);
  stmt.bind(p);
  const rows = [];
  while (stmt.step()) rows.push(_parseMirrorRow(stmt.getAsObject()));
  stmt.free();
  return rows;
}

function getMirrorEntryById(id) {
  const stmt = db.prepare(`SELECT * FROM mirror_entries WHERE id = ?`);
  stmt.bind([id]);
  let row = null;
  if (stmt.step()) row = _parseMirrorRow(stmt.getAsObject());
  stmt.free();
  return row;
}

function supersedeMirrorEntry(oldId, newEntry) {
  let ownerId = newEntry.userId;
  if (!ownerId) {
    const stmt = db.prepare(`SELECT user_id FROM mirror_entries WHERE id = ?`);
    stmt.bind([oldId]);
    if (stmt.step()) ownerId = stmt.getAsObject().user_id;
    stmt.free();
  }
  if (!ownerId) throw new Error('supersedeMirrorEntry: could not determine owner user_id');
  const newId = addMirrorEntry({ ...newEntry, userId: ownerId });
  db.run(
    `UPDATE mirror_entries
       SET superseded_by = ?, status = 'evolved', updated_at = datetime('now')
     WHERE id = ?`,
    [newId, oldId]
  );
  save();
  return newId;
}

function updateMirrorEntryStatus(id, newStatus, { skipSave = false } = {}) {
  if (!taxonomy.isValidStatus(newStatus)) {
    throw new Error(`updateMirrorEntryStatus: invalid status '${newStatus}'`);
  }
  db.run(
    `UPDATE mirror_entries SET status = ?, updated_at = datetime('now') WHERE id = ?`,
    [newStatus, id]
  );
  if (!skipSave) save();
}

function updateMirrorEntryRelatedIds(id, relatedIds, { skipSave = false } = {}) {
  const json = JSON.stringify(Array.isArray(relatedIds) ? relatedIds : []);
  db.run(
    `UPDATE mirror_entries SET related_ids = ?, updated_at = datetime('now') WHERE id = ?`,
    [json, id]
  );
  if (!skipSave) save();
}

function updateMirrorEntryConfidence(id, newConfidence, { skipSave = false } = {}) {
  db.run(
    `UPDATE mirror_entries SET confidence = ?, updated_at = datetime('now') WHERE id = ?`,
    [newConfidence, id]
  );
  if (!skipSave) save();
}

// --- Wiki Entries ---

function addWikiEntry({ topic, summary, source_ids = [], tags = [], embedding = null, contradictions = null, userId = null }) {
  if (!userId) throw new Error('addWikiEntry: userId required');
  const id = uuidv4();
  db.run(
    `INSERT INTO wiki_entries (id, topic, summary, source_ids, tags, embedding, contradictions, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, topic, summary, JSON.stringify(source_ids), JSON.stringify(tags), embedding, contradictions, userId]
  );
  save();
  return id;
}

function getWikiEntries({ topic = null, limit = 500, userId = null, allUsers = false } = {}) {
  if (!userId && !allUsers) throw new Error('getWikiEntries: userId or allUsers required');
  let q = 'SELECT * FROM wiki_entries WHERE 1=1';
  const p = [];
  if (!allUsers) { q += ' AND user_id = ?'; p.push(userId); }
  if (topic) { q += ' AND topic = ?'; p.push(topic); }
  q += ' ORDER BY updated_at DESC LIMIT ?';
  p.push(limit);

  const stmt = db.prepare(q);
  stmt.bind(p);
  const rows = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    row.source_ids = JSON.parse(row.source_ids || '[]');
    row.tags = JSON.parse(row.tags || '[]');
    rows.push(row);
  }
  stmt.free();
  return rows;
}

function getAllWikiEntries({ userId = null, allUsers = false } = {}) {
  return getWikiEntries({ userId, allUsers, limit: 10000 });
}

function updateWikiEntry(id, { summary, source_ids, tags, embedding, contradictions }) {
  db.run(
    `UPDATE wiki_entries
     SET summary = COALESCE(?, summary),
         source_ids = COALESCE(?, source_ids),
         tags = COALESCE(?, tags),
         embedding = COALESCE(?, embedding),
         contradictions = COALESCE(?, contradictions),
         updated_at = datetime('now')
     WHERE id = ?`,
    [
      summary ?? null,
      source_ids ? JSON.stringify(source_ids) : null,
      tags ? JSON.stringify(tags) : null,
      embedding ?? null,
      contradictions ?? null,
      id
    ]
  );
  save();
}

// --- Actions (Phase 5) ---

function addAction({ kind, subject, data = {}, confidence = 0.8, status = 'active',
                     sourceType, sourceId = null, parentActionId = null, userId }) {
  if (!userId) throw new Error('addAction: userId required');
  if (!kind) throw new Error('addAction: kind required');
  if (!subject) throw new Error('addAction: subject required');
  if (!sourceType) throw new Error('addAction: sourceType required');
  const id = uuidv4();
  db.run(
    `INSERT INTO actions (id, user_id, kind, subject, data, confidence, status,
                          source_type, source_id, parent_action_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, kind, subject, JSON.stringify(data), confidence, status,
     sourceType, sourceId, parentActionId]
  );
  save();
  return id;
}

function _rowsToActions(stmt) {
  const rows = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    r.data = JSON.parse(r.data || '{}');
    rows.push(r);
  }
  stmt.free();
  return rows;
}

function getActions({ userId = null, kind = null, status = null, limit = 200, offset = 0, allUsers = false } = {}) {
  if (!userId && !allUsers) throw new Error('getActions: userId required (or allUsers=true for admin)');
  let q = 'SELECT * FROM actions WHERE 1=1';
  const p = [];
  if (!allUsers) { q += ' AND user_id = ?'; p.push(userId); }
  if (kind) { q += ' AND kind = ?'; p.push(kind); }
  if (status) { q += ' AND status = ?'; p.push(status); }
  q += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  p.push(limit, offset);
  const stmt = db.prepare(q);
  stmt.bind(p);
  return _rowsToActions(stmt);
}

function getActionsByWindow({ userId = null, windowStart, windowEnd, allUsers = false }) {
  if (!userId && !allUsers) throw new Error('getActionsByWindow: userId required (or allUsers=true for admin)');
  if (!windowStart || !windowEnd) throw new Error('getActionsByWindow: windowStart and windowEnd required');
  let q = 'SELECT * FROM actions WHERE 1=1';
  const p = [];
  if (!allUsers) { q += ' AND user_id = ?'; p.push(userId); }
  q += ' AND created_at >= ? AND created_at <= ? ORDER BY created_at ASC';
  p.push(windowStart, windowEnd);
  const stmt = db.prepare(q);
  stmt.bind(p);
  return _rowsToActions(stmt);
}

function getPendingActions({ userId }) {
  return getActions({ userId, status: 'pending_confirm', limit: 100 });
}

function updateActionStatus(actionId, newStatus) {
  db.run(`UPDATE actions SET status = ? WHERE id = ?`, [newStatus, actionId]);
  save();
}

function resolveAction(commitmentId, resolvingActionId) {
  db.run(
    `UPDATE actions SET status = 'resolved', resolved_at = datetime('now'), parent_action_id = ? WHERE id = ?`,
    [resolvingActionId, commitmentId]
  );
  save();
}

// --- Reflections (Phase 5) ---

function addReflection({ userId, windowStart, windowEnd, briefingMd,
                         actionCount = 0, patternJson = {}, selfCritiqueJson = {} }) {
  if (!userId) throw new Error('addReflection: userId required');
  if (!windowStart) throw new Error('addReflection: windowStart required');
  if (!windowEnd) throw new Error('addReflection: windowEnd required');
  if (!briefingMd) throw new Error('addReflection: briefingMd required');
  const id = uuidv4();
  db.run(
    `INSERT INTO reflections (id, user_id, window_start, window_end, briefing_md,
                              action_count, pattern_json, self_critique_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, windowStart, windowEnd, briefingMd, actionCount,
     JSON.stringify(patternJson), JSON.stringify(selfCritiqueJson)]
  );
  save();
  return id;
}

function _rowToReflection(row) {
  if (!row) return null;
  row.pattern_json = JSON.parse(row.pattern_json || '{}');
  row.self_critique_json = JSON.parse(row.self_critique_json || '{}');
  return row;
}

function getLatestReflection({ userId }) {
  if (!userId) throw new Error('getLatestReflection: userId required');
  const stmt = db.prepare(
    `SELECT * FROM reflections WHERE user_id = ? ORDER BY generated_at DESC LIMIT 1`
  );
  stmt.bind([userId]);
  let row = null;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return _rowToReflection(row);
}

function markReflectionDelivered(id, { telegram = false, obsidianPath = null } = {}) {
  db.run(
    `UPDATE reflections SET delivered_telegram = ?, delivered_obsidian = ? WHERE id = ?`,
    [telegram ? 1 : 0, obsidianPath, id]
  );
  save();
}

// --- Prompt Versions (Phase 5) ---

function addPromptVersion({ name, version, body, isActive = 0, createdBy = 'manual', parentVersion = null }) {
  if (!name) throw new Error('addPromptVersion: name required');
  if (!body) throw new Error('addPromptVersion: body required');
  if (typeof version !== 'number') throw new Error('addPromptVersion: version required (number)');
  const id = uuidv4();
  db.run(
    `INSERT INTO prompt_versions (id, name, version, body, is_active, created_by, parent_version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, name, version, body, isActive ? 1 : 0, createdBy, parentVersion]
  );
  save();
  return id;
}

function getActivePromptVersion(name) {
  const stmt = db.prepare(
    `SELECT * FROM prompt_versions WHERE name = ? AND is_active = 1 LIMIT 1`
  );
  stmt.bind([name]);
  let row = null;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return row;
}

function listPromptVersions(name) {
  const stmt = db.prepare(
    `SELECT * FROM prompt_versions WHERE name = ? ORDER BY version DESC`
  );
  stmt.bind([name]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function getMaxPromptVersion(name) {
  const stmt = db.prepare(
    `SELECT MAX(version) as max_version FROM prompt_versions WHERE name = ?`
  );
  stmt.bind([name]);
  stmt.step();
  const row = stmt.getAsObject();
  stmt.free();
  return row.max_version ?? 0;
}

function setActivePromptVersion(name, version) {
  // Two-statement flip on a single table. sql.js does not expose
  // multi-statement transactions cleanly, but both writes target the
  // same table with specific WHERE clauses so this is safe in practice.
  db.run(`UPDATE prompt_versions SET is_active = 0 WHERE name = ?`, [name]);
  db.run(`UPDATE prompt_versions SET is_active = 1 WHERE name = ? AND version = ?`, [name, version]);
  save();
}

function getActivePromptVersions() {
  const stmt = db.prepare(`SELECT * FROM prompt_versions WHERE is_active = 1 ORDER BY name`);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// --- Prompt Proposals (Phase 5) ---

function addPromptProposal({ promptName, baseVersion, proposedBody, rationale,
                             replayResultsJson = null, replayError = null }) {
  if (!promptName) throw new Error('addPromptProposal: promptName required');
  if (!proposedBody) throw new Error('addPromptProposal: proposedBody required');
  if (!rationale) throw new Error('addPromptProposal: rationale required');
  const id = uuidv4();
  db.run(
    `INSERT INTO prompt_proposals
       (id, prompt_name, base_version, proposed_body, rationale, replay_results_json, replay_error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, promptName, baseVersion, proposedBody, rationale,
     replayResultsJson == null ? null : JSON.stringify(replayResultsJson), replayError]
  );
  save();
  return id;
}

function _parseProposalRow(row) {
  if (!row) return null;
  row.replay_results_json = row.replay_results_json ? JSON.parse(row.replay_results_json) : null;
  return row;
}

function getPromptProposal(id) {
  const stmt = db.prepare(`SELECT * FROM prompt_proposals WHERE id = ?`);
  stmt.bind([id]);
  let row = null;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return _parseProposalRow(row);
}

function getPendingPromptProposals() {
  const stmt = db.prepare(
    `SELECT * FROM prompt_proposals WHERE status = 'pending' ORDER BY created_at DESC`
  );
  const rows = [];
  while (stmt.step()) rows.push(_parseProposalRow(stmt.getAsObject()));
  stmt.free();
  return rows;
}

function updatePromptProposalStatus(id, newStatus) {
  db.run(
    `UPDATE prompt_proposals SET status = ?, resolved_at = datetime('now') WHERE id = ?`,
    [newStatus, id]
  );
  save();
}

function countPromptProposals({ promptName = null, status = null } = {}) {
  let q = 'SELECT COUNT(*) as n FROM prompt_proposals WHERE 1=1';
  const p = [];
  if (promptName) { q += ' AND prompt_name = ?'; p.push(promptName); }
  if (status) { q += ' AND status = ?'; p.push(status); }
  const stmt = db.prepare(q);
  if (p.length) stmt.bind(p);
  stmt.step();
  const n = stmt.getAsObject().n;
  stmt.free();
  return n;
}

// Test-only escape hatch — lets tests run raw SQL (e.g. to backdate updated_at)
function _raw() { return db; }

module.exports = {
  init, save, addMessage, getMessages, getMessageCount,
  getSourceCounts, getCategoryCounts, log, getLogs,
  getConfig, setConfig,
  addMirrorEntry, getMirrorEntries, getMirrorEntryById,
  supersedeMirrorEntry, updateMirrorEntryConfidence,
  updateMirrorEntryStatus, updateMirrorEntryRelatedIds,
  addWikiEntry, getWikiEntries, getAllWikiEntries, updateWikiEntry,
  addAction, getActions, getActionsByWindow, getPendingActions, updateActionStatus, resolveAction,
  addReflection, getLatestReflection, markReflectionDelivered,
  addPromptVersion, getActivePromptVersion, getActivePromptVersions, listPromptVersions,
  getMaxPromptVersion, setActivePromptVersion,
  addPromptProposal, getPromptProposal, getPendingPromptProposals,
  updatePromptProposalStatus, countPromptProposals,
  _raw
};
