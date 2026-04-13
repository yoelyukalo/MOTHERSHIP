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

const DB_PATH = process.env.MOTHERSHIP_DB_PATH || path.join(__dirname, '..', 'data', 'mothership.db');

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

  db.run(`
    CREATE TABLE IF NOT EXISTS mirror_entries (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      source_type TEXT NOT NULL,
      source_id TEXT,
      embedding BLOB,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      superseded_by TEXT
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_mirror_category ON mirror_entries(category)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_mirror_active ON mirror_entries(superseded_by)`);

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

  save();
  return db;
}

function save() {
  if (!db) return;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// --- Messages ---

function addMessage(content, source = 'unknown', category = 'uncategorized', metadata = {}) {
  const id = uuidv4();
  db.run(
    `INSERT INTO messages (id, content, source, category, metadata) VALUES (?, ?, ?, ?, ?)`,
    [id, content, source, category, JSON.stringify(metadata)]
  );
  save();
  log('info', 'database', `Message added: [${source}] ${content.substring(0, 50)}...`);
  return id;
}

function getMessages({ limit = 50, offset = 0, source, category, search } = {}) {
  let query = 'SELECT * FROM messages WHERE 1=1';
  const params = [];

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

function getMessageCount() {
  const result = db.exec('SELECT COUNT(*) as count FROM messages');
  return result.length > 0 ? result[0].values[0][0] : 0;
}

function getSourceCounts() {
  const result = db.exec('SELECT source, COUNT(*) as count FROM messages GROUP BY source ORDER BY count DESC');
  if (!result.length) return [];
  return result[0].values.map(([source, count]) => ({ source, count }));
}

function getCategoryCounts() {
  const result = db.exec('SELECT category, COUNT(*) as count FROM messages GROUP BY category ORDER BY count DESC');
  if (!result.length) return [];
  return result[0].values.map(([category, count]) => ({ category, count }));
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

// --- Mirror Entries ---

function addMirrorEntry({ category, content, confidence = 0.5, source_type, source_id = null, embedding = null }) {
  const id = uuidv4();
  db.run(
    `INSERT INTO mirror_entries (id, category, content, confidence, source_type, source_id, embedding)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, category, content, confidence, source_type, source_id, embedding]
  );
  save();
  return id;
}

function getMirrorEntries({ category = null, activeOnly = true, limit = 500 } = {}) {
  let q = 'SELECT * FROM mirror_entries WHERE 1=1';
  const p = [];
  if (category) { q += ' AND category = ?'; p.push(category); }
  if (activeOnly) { q += ' AND superseded_by IS NULL'; }
  q += ' ORDER BY updated_at DESC LIMIT ?';
  p.push(limit);

  const stmt = db.prepare(q);
  stmt.bind(p);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function supersedeMirrorEntry(oldId, newEntry) {
  const newId = addMirrorEntry(newEntry);
  db.run(
    `UPDATE mirror_entries SET superseded_by = ?, updated_at = datetime('now') WHERE id = ?`,
    [newId, oldId]
  );
  save();
  return newId;
}

function updateMirrorEntryConfidence(id, newConfidence, { skipSave = false } = {}) {
  db.run(
    `UPDATE mirror_entries SET confidence = ?, updated_at = datetime('now') WHERE id = ?`,
    [newConfidence, id]
  );
  if (!skipSave) save();
}

// --- Wiki Entries ---

function addWikiEntry({ topic, summary, source_ids = [], tags = [], embedding = null, contradictions = null }) {
  const id = uuidv4();
  db.run(
    `INSERT INTO wiki_entries (id, topic, summary, source_ids, tags, embedding, contradictions)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, topic, summary, JSON.stringify(source_ids), JSON.stringify(tags), embedding, contradictions]
  );
  save();
  return id;
}

function getWikiEntries({ topic = null, limit = 500 } = {}) {
  let q = 'SELECT * FROM wiki_entries WHERE 1=1';
  const p = [];
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

function getAllWikiEntries() { return getWikiEntries({ limit: 10000 }); }

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

// Test-only escape hatch — lets tests run raw SQL (e.g. to backdate updated_at)
function _raw() { return db; }

module.exports = {
  init, save, addMessage, getMessages, getMessageCount,
  getSourceCounts, getCategoryCounts, log, getLogs,
  getConfig, setConfig,
  addMirrorEntry, getMirrorEntries, supersedeMirrorEntry, updateMirrorEntryConfidence,
  addWikiEntry, getWikiEntries, getAllWikiEntries, updateWikiEntry,
  _raw
};
