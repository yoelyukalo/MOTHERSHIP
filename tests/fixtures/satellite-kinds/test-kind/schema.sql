CREATE TABLE IF NOT EXISTS test_widgets (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
