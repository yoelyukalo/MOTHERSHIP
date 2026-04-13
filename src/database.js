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

const DB_PATH = path.join(__dirname, '..', 'data', 'mothership.db');

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

module.exports = {
  init, save, addMessage, getMessages, getMessageCount,
  getSourceCounts, getCategoryCounts, log, getLogs,
  getConfig, setConfig
};
