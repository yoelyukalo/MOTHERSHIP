# Action Logger + Reflection Agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build MOTHERSHIP's Phase 5 self-improvement loop: a unified action log for user and Mothership events, a daily reflection agent that produces briefings and proposes prompt changes (evaluated by replay against historical actions), and a versioned prompt registry that replaces hardcoded prompts across the codebase.

**Architecture:** Minimalist inline variant — new modules live alongside existing ones and reuse proven patterns from `health-check.js`, `quantum-mirror.js`, and `conversation-hooks.js`. Four new SQLite tables, two new subdirectories (`src/prompts/`, `src/extractors/`), and targeted edits to existing modules. No event bus. No satellite contortions. Every new LLM-using module follows the `_setClient()` injection pattern for testability.

**Tech Stack:** Node.js, Express, sql.js (WASM SQLite), node-telegram-bot-api, `@anthropic-ai/sdk`, `node:test` + `node:assert`.

**Spec:** `docs/superpowers/specs/2026-04-14-action-logger-reflection-agent-design.md`

---

## Conventions used throughout this plan

- **Test DB isolation:** every test sets `process.env.MOTHERSHIP_DB_PATH` to a unique tmp path before requiring `./src/database`, and cleans up with `fs.unlinkSync` in an `after` hook. Matches `tests/conversation-hooks.test.js`.
- **User seeding:** tests that need a user call `authRoles.seedOnce(db)` then `users.createUser({ email, password })`. Same as existing tests.
- **Claude mocks:** use `module._setClient({ messages: { create: async () => ({ content: [{ type: 'text', text: '...' }] }) } })` to inject a fake. No real API calls in tests.
- **Commit style:** matches `git log` on `main` — `type(scope): message`. Types used here: `feat`, `test`, `refactor`, `chore`. Every commit message ends with `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`.
- **File line budget:** no new file should exceed ~300 lines. If it does during implementation, that's a split signal.
- **npm test:** the project test command is `node --test` via `npm test`. Run the full suite at the end of each task to catch regressions.

---

## Task 1: Add four new table schemas to `database.js`

**Files:**
- Modify: `src/database.js` — add four `CREATE TABLE IF NOT EXISTS` + indexes inside `init()`
- Test: `tests/database-phase5-schema.test.js` (new)

- [ ] **Step 1: Write the failing schema test**

Create `tests/database-phase5-schema.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-schema-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');

test('phase 5 schema — all four tables exist after init', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });

  const raw = db._raw();
  const tables = raw.exec(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)[0].values.map(r => r[0]);

  assert.ok(tables.includes('actions'), 'actions table missing');
  assert.ok(tables.includes('reflections'), 'reflections table missing');
  assert.ok(tables.includes('prompt_versions'), 'prompt_versions table missing');
  assert.ok(tables.includes('prompt_proposals'), 'prompt_proposals table missing');
});

test('phase 5 schema — actions table has required columns', () => {
  const raw = db._raw();
  const cols = raw.exec(`PRAGMA table_info(actions)`)[0].values.map(r => r[1]);
  for (const c of ['id', 'user_id', 'kind', 'subject', 'data', 'confidence', 'status', 'source_type', 'source_id', 'created_at', 'resolved_at', 'parent_action_id']) {
    assert.ok(cols.includes(c), `actions.${c} missing`);
  }
});

test('phase 5 schema — reflections table has required columns', () => {
  const raw = db._raw();
  const cols = raw.exec(`PRAGMA table_info(reflections)`)[0].values.map(r => r[1]);
  for (const c of ['id', 'user_id', 'generated_at', 'window_start', 'window_end', 'briefing_md', 'action_count', 'pattern_json', 'self_critique_json', 'delivered_telegram', 'delivered_obsidian']) {
    assert.ok(cols.includes(c), `reflections.${c} missing`);
  }
});

test('phase 5 schema — prompt_versions has unique (name, version)', () => {
  const raw = db._raw();
  raw.run(`INSERT INTO prompt_versions (id, name, version, body, is_active, created_by) VALUES ('a','x',1,'b',1,'test')`);
  assert.throws(() => {
    raw.run(`INSERT INTO prompt_versions (id, name, version, body, is_active, created_by) VALUES ('c','x',1,'b',0,'test')`);
  }, /UNIQUE/);
});

test('phase 5 schema — prompt_proposals has required columns', () => {
  const raw = db._raw();
  const cols = raw.exec(`PRAGMA table_info(prompt_proposals)`)[0].values.map(r => r[1]);
  for (const c of ['id', 'prompt_name', 'base_version', 'proposed_body', 'rationale', 'replay_results_json', 'replay_error', 'status', 'created_at', 'resolved_at']) {
    assert.ok(cols.includes(c), `prompt_proposals.${c} missing`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/database-phase5-schema.test.js`
Expected: all tests fail with "actions table missing" etc.

- [ ] **Step 3: Add schemas inside `init()` in `src/database.js`**

Insert these four `db.run(...)` blocks inside `init()`, directly before the `save();` call at the bottom of the function (around line 267):

```javascript
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
  db.run(`CREATE INDEX IF NOT EXISTS idx_actions_user_created ON actions(user_id, created_at DESC)`);
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
  db.run(`CREATE INDEX IF NOT EXISTS idx_reflections_user_generated ON reflections(user_id, generated_at DESC)`);

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
```

Note: `data`, `pattern_json`, `self_critique_json`, `replay_results_json` are declared `TEXT` (not the spec's `JSON`) because sql.js does not have a native JSON column type. Helpers will `JSON.stringify` on write and `JSON.parse` on read, matching how `messages.metadata` is already handled.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/database-phase5-schema.test.js`
Expected: 5 tests pass.

- [ ] **Step 5: Run the full test suite to catch regressions**

Run: `npm test`
Expected: all existing tests still pass. If any existing test touches `init()`, it should be unaffected because the new schemas are additive.

- [ ] **Step 6: Commit**

```bash
git add src/database.js tests/database-phase5-schema.test.js
git commit -m "$(cat <<'EOF'
feat(db): add phase 5 schema — actions, reflections, prompt_versions, prompt_proposals

Four new tables for the action logger + reflection agent:
- actions: unified user + Mothership event log
- reflections: daily reflection pass output
- prompt_versions: versioned prompt registry with monotonic versioning
- prompt_proposals: pending prompt diffs awaiting approval

All tables multi-tenant via user_id where applicable.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add `actions` table helpers to `database.js`

**Files:**
- Modify: `src/database.js` — add CRUD helpers, export them
- Test: `tests/database-actions.test.js` (new)

- [ ] **Step 1: Write the failing helper test**

Create `tests/database-actions.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-actions-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const users = require('../src/auth/users');
const authRoles = require('../src/auth/roles');

let uid;

test('database actions — setup', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });
  await authRoles.seedOnce(db);
  uid = await users.createUser({ email: 'a@x', password: 'p' });
});

test('addAction writes a row and returns its id', () => {
  const id = db.addAction({
    kind: 'commitment',
    subject: 'ship mirror v2',
    data: { what: 'ship mirror v2', due_at: '2026-04-17' },
    confidence: 0.92,
    sourceType: 'conversation',
    sourceId: 'msg-1',
    userId: uid
  });
  assert.ok(id);
  const rows = db.getActions({ userId: uid });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].kind, 'commitment');
  assert.strictEqual(rows[0].data.due_at, '2026-04-17');
  assert.strictEqual(rows[0].status, 'active');
});

test('addAction requires userId', () => {
  assert.throws(() => db.addAction({ kind: 'win', subject: 'x', sourceType: 'conversation' }),
    /userId required/);
});

test('getActions filters by kind and status', () => {
  db.addAction({ kind: 'win', subject: 'closed deal', sourceType: 'conversation', userId: uid });
  db.addAction({ kind: 'win', subject: 'x', sourceType: 'conversation', userId: uid, status: 'pending_confirm' });
  const active = db.getActions({ userId: uid, kind: 'win', status: 'active' });
  assert.strictEqual(active.length, 1);
  const pending = db.getActions({ userId: uid, kind: 'win', status: 'pending_confirm' });
  assert.strictEqual(pending.length, 1);
});

test('getActionsByWindow returns actions inside window', () => {
  const now = new Date();
  const start = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const end = new Date(now.getTime() + 60 * 1000).toISOString();
  const rows = db.getActionsByWindow({ userId: uid, windowStart: start, windowEnd: end });
  assert.ok(rows.length >= 3);
});

test('getPendingActions returns only pending_confirm rows', () => {
  const rows = db.getPendingActions({ userId: uid });
  assert.ok(rows.every(r => r.status === 'pending_confirm'));
  assert.ok(rows.length >= 1);
});

test('updateActionStatus transitions pending_confirm to active', () => {
  const pending = db.getPendingActions({ userId: uid });
  const target = pending[0];
  db.updateActionStatus(target.id, 'active');
  const refreshed = db.getActions({ userId: uid, kind: target.kind, status: 'active' });
  assert.ok(refreshed.find(r => r.id === target.id));
});

test('resolveAction sets resolved_at and parent_action_id', () => {
  const commitment = db.addAction({
    kind: 'commitment', subject: 'do X', sourceType: 'conversation', userId: uid
  });
  const win = db.addAction({
    kind: 'win', subject: 'did X', sourceType: 'conversation', userId: uid
  });
  db.resolveAction(commitment, win);
  const rows = db.getActions({ userId: uid, kind: 'commitment' });
  const resolved = rows.find(r => r.id === commitment);
  assert.strictEqual(resolved.status, 'resolved');
  assert.ok(resolved.resolved_at);
  assert.strictEqual(resolved.parent_action_id, win);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/database-actions.test.js`
Expected: fails with "db.addAction is not a function".

- [ ] **Step 3: Add helper functions to `src/database.js`**

Insert this block before the `// Test-only escape hatch` line near the bottom of `src/database.js`:

```javascript
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

function getActions({ userId, kind = null, status = null, limit = 200, offset = 0 } = {}) {
  if (!userId) throw new Error('getActions: userId required');
  let q = 'SELECT * FROM actions WHERE user_id = ?';
  const p = [userId];
  if (kind) { q += ' AND kind = ?'; p.push(kind); }
  if (status) { q += ' AND status = ?'; p.push(status); }
  q += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  p.push(limit, offset);
  const stmt = db.prepare(q);
  stmt.bind(p);
  return _rowsToActions(stmt);
}

function getActionsByWindow({ userId, windowStart, windowEnd }) {
  if (!userId) throw new Error('getActionsByWindow: userId required');
  const stmt = db.prepare(
    `SELECT * FROM actions
     WHERE user_id = ? AND created_at >= ? AND created_at <= ?
     ORDER BY created_at ASC`
  );
  stmt.bind([userId, windowStart, windowEnd]);
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
```

Then add the new helpers to the `module.exports` block at the bottom:

```javascript
module.exports = {
  init, save, addMessage, getMessages, getMessageCount,
  getSourceCounts, getCategoryCounts, log, getLogs,
  getConfig, setConfig,
  addMirrorEntry, getMirrorEntries, supersedeMirrorEntry, updateMirrorEntryConfidence,
  addWikiEntry, getWikiEntries, getAllWikiEntries, updateWikiEntry,
  addAction, getActions, getActionsByWindow, getPendingActions, updateActionStatus, resolveAction,
  _raw
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/database-actions.test.js`
Expected: 7 tests pass.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/database.js tests/database-actions.test.js
git commit -m "$(cat <<'EOF'
feat(db): add actions table helpers — CRUD and window/status queries

Adds addAction, getActions, getActionsByWindow, getPendingActions,
updateActionStatus, and resolveAction. JSON serialization matches
existing messages.metadata pattern.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Add `reflections` table helpers to `database.js`

**Files:**
- Modify: `src/database.js`
- Test: `tests/database-reflections.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/database-reflections.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-reflections-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const users = require('../src/auth/users');
const authRoles = require('../src/auth/roles');

let uid;

test('database reflections — setup', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });
  await authRoles.seedOnce(db);
  uid = await users.createUser({ email: 'r@x', password: 'p' });
});

test('addReflection writes a row with JSON fields', () => {
  const id = db.addReflection({
    userId: uid,
    windowStart: '2026-04-13T07:00:00Z',
    windowEnd: '2026-04-14T07:00:00Z',
    briefingMd: '# Daily briefing\n\n...',
    actionCount: 42,
    patternJson: { patterns: [{ description: 'energy dips midweek' }] },
    selfCritiqueJson: { issues: [] }
  });
  assert.ok(id);

  const latest = db.getLatestReflection({ userId: uid });
  assert.ok(latest);
  assert.strictEqual(latest.action_count, 42);
  assert.strictEqual(latest.pattern_json.patterns[0].description, 'energy dips midweek');
  assert.strictEqual(latest.briefing_md, '# Daily briefing\n\n...');
});

test('addReflection requires userId', () => {
  assert.throws(() => db.addReflection({
    windowStart: 'x', windowEnd: 'y', briefingMd: 'z'
  }), /userId required/);
});

test('getLatestReflection returns the most recent row', () => {
  db.addReflection({
    userId: uid, windowStart: 'a', windowEnd: 'b',
    briefingMd: 'second', actionCount: 10
  });
  const latest = db.getLatestReflection({ userId: uid });
  assert.strictEqual(latest.briefing_md, 'second');
});

test('markReflectionDelivered updates delivery flags', () => {
  const latest = db.getLatestReflection({ userId: uid });
  db.markReflectionDelivered(latest.id, { telegram: true, obsidianPath: '/tmp/daily.md' });
  const refreshed = db.getLatestReflection({ userId: uid });
  assert.strictEqual(refreshed.delivered_telegram, 1);
  assert.strictEqual(refreshed.delivered_obsidian, '/tmp/daily.md');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/database-reflections.test.js`
Expected: fails with "db.addReflection is not a function".

- [ ] **Step 3: Add helpers to `src/database.js`**

Insert this block after the actions helpers:

```javascript
// --- Reflections (Phase 5) ---

function addReflection({ userId, windowStart, windowEnd, briefingMd,
                         actionCount = 0, patternJson = {}, selfCritiqueJson = {} }) {
  if (!userId) throw new Error('addReflection: userId required');
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
```

Add to `module.exports`:

```javascript
  addReflection, getLatestReflection, markReflectionDelivered,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/database-reflections.test.js`
Expected: 4 tests pass.

- [ ] **Step 5: Run full suite**

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add src/database.js tests/database-reflections.test.js
git commit -m "$(cat <<'EOF'
feat(db): add reflections table helpers

addReflection, getLatestReflection, markReflectionDelivered.
JSON fields serialized/parsed consistent with actions and messages.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Add `prompt_versions` table helpers to `database.js`

**Files:**
- Modify: `src/database.js`
- Test: `tests/database-prompt-versions.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/database-prompt-versions.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-pv-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');

test('prompt_versions — init', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });
});

test('addPromptVersion writes a row', () => {
  const id = db.addPromptVersion({
    name: 'system.conversation',
    version: 1,
    body: 'You are MOTHERSHIP...',
    isActive: 1,
    createdBy: 'bootstrap',
    parentVersion: null
  });
  assert.ok(id);
});

test('getActivePromptVersion returns the is_active row', () => {
  const row = db.getActivePromptVersion('system.conversation');
  assert.strictEqual(row.version, 1);
  assert.strictEqual(row.body, 'You are MOTHERSHIP...');
});

test('getActivePromptVersion returns null for unknown prompt', () => {
  const row = db.getActivePromptVersion('does.not.exist');
  assert.strictEqual(row, null);
});

test('listPromptVersions returns version history', () => {
  db.addPromptVersion({
    name: 'system.conversation', version: 2,
    body: 'v2 body', isActive: 0, createdBy: 'reflection', parentVersion: 1
  });
  const all = db.listPromptVersions('system.conversation');
  assert.strictEqual(all.length, 2);
  assert.strictEqual(all[0].version, 2); // DESC
});

test('setActivePromptVersion flips is_active atomically', () => {
  db.setActivePromptVersion('system.conversation', 2);
  const active = db.getActivePromptVersion('system.conversation');
  assert.strictEqual(active.version, 2);
  const all = db.listPromptVersions('system.conversation');
  const v1 = all.find(r => r.version === 1);
  assert.strictEqual(v1.is_active, 0);
});

test('getMaxPromptVersion returns highest version number', () => {
  const n = db.getMaxPromptVersion('system.conversation');
  assert.strictEqual(n, 2);
});

test('getMaxPromptVersion returns 0 for unknown prompt', () => {
  const n = db.getMaxPromptVersion('nothing');
  assert.strictEqual(n, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/database-prompt-versions.test.js`
Expected: fails on `db.addPromptVersion is not a function`.

- [ ] **Step 3: Add helpers to `src/database.js`**

Insert after the reflections helpers:

```javascript
// --- Prompt Versions (Phase 5) ---

function addPromptVersion({ name, version, body, isActive = 0, createdBy = 'manual', parentVersion = null }) {
  if (!name) throw new Error('addPromptVersion: name required');
  if (!body) throw new Error('addPromptVersion: body required');
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
  return row.max_version || 0;
}

function setActivePromptVersion(name, version) {
  // Two-step flip. sql.js does not support multi-statement transactions via
  // the standard driver in a way that rolls back cleanly, but both statements
  // hit a single table with a where filter, so atomicity here is best-effort.
  db.run(`UPDATE prompt_versions SET is_active = 0 WHERE name = ?`, [name]);
  db.run(`UPDATE prompt_versions SET is_active = 1 WHERE name = ? AND version = ?`, [name, version]);
  save();
}
```

Add to `module.exports`:

```javascript
  addPromptVersion, getActivePromptVersion, listPromptVersions,
  getMaxPromptVersion, setActivePromptVersion,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/database-prompt-versions.test.js`
Expected: 7 tests pass.

- [ ] **Step 5: Run full suite**

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add src/database.js tests/database-prompt-versions.test.js
git commit -m "$(cat <<'EOF'
feat(db): add prompt_versions table helpers

addPromptVersion, getActivePromptVersion, listPromptVersions,
getMaxPromptVersion, setActivePromptVersion. Active-flag flip
is a two-statement update on a single table.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Add `prompt_proposals` table helpers to `database.js`

**Files:**
- Modify: `src/database.js`
- Test: `tests/database-prompt-proposals.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/database-prompt-proposals.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-pp-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');

test('prompt_proposals — init', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });
});

test('addPromptProposal writes a row', () => {
  const id = db.addPromptProposal({
    promptName: 'synthesis.mirror',
    baseVersion: 1,
    proposedBody: 'improved prompt body',
    rationale: 'the current version misses thin categories',
    replayResultsJson: { sample_size: 20, agreement_rate: 0.75, regressions: [], improvements: [] }
  });
  assert.ok(id);
});

test('getPendingPromptProposals returns pending rows', () => {
  const rows = db.getPendingPromptProposals();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].prompt_name, 'synthesis.mirror');
  assert.strictEqual(rows[0].replay_results_json.agreement_rate, 0.75);
});

test('getPromptProposal returns a single row by id', () => {
  const all = db.getPendingPromptProposals();
  const row = db.getPromptProposal(all[0].id);
  assert.strictEqual(row.id, all[0].id);
  assert.strictEqual(row.rationale, 'the current version misses thin categories');
});

test('updatePromptProposalStatus transitions to approved', () => {
  const all = db.getPendingPromptProposals();
  db.updatePromptProposalStatus(all[0].id, 'approved');
  const refreshed = db.getPromptProposal(all[0].id);
  assert.strictEqual(refreshed.status, 'approved');
  assert.ok(refreshed.resolved_at);
});

test('addPromptProposal with replay_error stores the error', () => {
  const id = db.addPromptProposal({
    promptName: 'system.conversation',
    baseVersion: 1,
    proposedBody: 'x',
    rationale: 'y',
    replayResultsJson: null,
    replayError: 'simulated failure'
  });
  const row = db.getPromptProposal(id);
  assert.strictEqual(row.replay_error, 'simulated failure');
  assert.strictEqual(row.replay_results_json, null);
});

test('countPromptProposals filters by prompt_name and status', () => {
  const n = db.countPromptProposals({ promptName: 'system.conversation', status: 'pending' });
  assert.strictEqual(n, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/database-prompt-proposals.test.js`

- [ ] **Step 3: Add helpers to `src/database.js`**

Insert after the prompt_versions helpers:

```javascript
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
     replayResultsJson === null ? null : JSON.stringify(replayResultsJson), replayError]
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
```

Add to `module.exports`:

```javascript
  addPromptProposal, getPromptProposal, getPendingPromptProposals,
  updatePromptProposalStatus, countPromptProposals,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/database-prompt-proposals.test.js`
Expected: 6 tests pass.

- [ ] **Step 5: Run full suite**

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add src/database.js tests/database-prompt-proposals.test.js
git commit -m "$(cat <<'EOF'
feat(db): add prompt_proposals table helpers

addPromptProposal, getPromptProposal, getPendingPromptProposals,
updatePromptProposalStatus, countPromptProposals. JSON replay
results parsed on read, null-safe.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Create `src/prompts/registry.js` — core registry with cache

**Files:**
- Create: `src/prompts/registry.js`
- Test: `tests/prompts-registry.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/prompts-registry.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-registry-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const registry = require('../src/prompts/registry');

test('registry — init db', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });
});

test('createVersion + getPrompt returns active body', () => {
  registry.createVersion('system.conversation', 'v1 body', { createdBy: 'bootstrap', activate: true });
  assert.strictEqual(registry.getPrompt('system.conversation'), 'v1 body');
});

test('createVersion auto-increments version numbers', () => {
  registry.createVersion('system.conversation', 'v2 body', { createdBy: 'reflection' });
  const versions = registry.listVersions('system.conversation');
  assert.strictEqual(versions.length, 2);
  assert.strictEqual(versions[0].version, 2);
  assert.strictEqual(versions[1].version, 1);
});

test('createVersion without activate leaves the old version active', () => {
  assert.strictEqual(registry.getPrompt('system.conversation'), 'v1 body');
});

test('activateVersion flips the active row and invalidates cache', () => {
  registry.activateVersion('system.conversation', 2);
  assert.strictEqual(registry.getPrompt('system.conversation'), 'v2 body');
});

test('getPrompt falls back to FALLBACK when no active version exists', () => {
  registry.setFallback('experimental.prompt', 'fallback string');
  assert.strictEqual(registry.getPrompt('experimental.prompt'), 'fallback string');
});

test('getPrompt throws when no active version and no fallback', () => {
  assert.throws(() => registry.getPrompt('completely.unknown'),
    /no active version and no fallback/);
});

test('listActive returns all active prompts', () => {
  registry.createVersion('synthesis.mirror', 'mirror v1', { createdBy: 'bootstrap', activate: true });
  const active = registry.listActive();
  const names = active.map(p => p.name);
  assert.ok(names.includes('system.conversation'));
  assert.ok(names.includes('synthesis.mirror'));
});

test('cache is invalidated after activateVersion', () => {
  registry.createVersion('synthesis.mirror', 'mirror v2', { createdBy: 'reflection' });
  registry.activateVersion('synthesis.mirror', 2);
  assert.strictEqual(registry.getPrompt('synthesis.mirror'), 'mirror v2');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/prompts-registry.test.js`
Expected: fails with "Cannot find module '../src/prompts/registry'".

- [ ] **Step 3: Create `src/prompts/registry.js`**

```javascript
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
  const row = db.getActivePromptVersion(name);
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
  const raw = db._raw();
  const stmt = raw.prepare(`SELECT * FROM prompt_versions WHERE is_active = 1 ORDER BY name`);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function createVersion(name, body, { createdBy = 'manual', parentVersion = null, activate = false } = {}) {
  if (!name || !body) throw new Error('createVersion: name and body required');
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/prompts-registry.test.js`
Expected: 8 tests pass.

- [ ] **Step 5: Run full suite**

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add src/prompts/registry.js tests/prompts-registry.test.js
git commit -m "$(cat <<'EOF'
feat(prompts): add registry with versioning, cache, and fallbacks

createVersion auto-increments version numbers, activateVersion
invalidates the in-memory cache, getPrompt falls back to a per-name
FALLBACK string if no active row exists (safety net for load-bearing
prompts).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Add `seedFromHardcoded()` migration to the registry

**Files:**
- Modify: `src/prompts/registry.js` — add `seedFromHardcoded()`
- Test: extend `tests/prompts-registry.test.js`

- [ ] **Step 1: Add failing test for seed**

Append to `tests/prompts-registry.test.js`:

```javascript
test('seedFromHardcoded creates v1 for every known prompt', () => {
  // Reset DB state: use a fresh tmp DB for this test so we start clean.
  // (The earlier tests in this file may have created rows; we want to verify
  // that seed is idempotent and covers all known names.)
  const beforeNames = registry.listActive().map(p => p.name);
  registry.seedFromHardcoded();
  const afterNames = registry.listActive().map(p => p.name);
  for (const name of [
    'system.conversation',
    'synthesis.mirror',
    'synthesis.wiki',
    'health.contradictions',
    'health.gap_analysis',
    'extractor.actions',
    'reflection.daily'
  ]) {
    assert.ok(afterNames.includes(name), `seed missed ${name}`);
  }
});

test('seedFromHardcoded is idempotent', () => {
  const firstCount = registry.listActive().length;
  registry.seedFromHardcoded();
  const secondCount = registry.listActive().length;
  assert.strictEqual(firstCount, secondCount);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/prompts-registry.test.js`
Expected: fails on `registry.seedFromHardcoded is not a function`.

- [ ] **Step 3: Add `seedFromHardcoded()` to `src/prompts/registry.js`**

Append to `src/prompts/registry.js` (before the `module.exports`):

```javascript
// --- Seed migration: scrape existing hardcoded prompts into v1 rows ---
//
// Called once on boot. Idempotent: no-op if a v1 already exists for each name.
// For prompts that are functions-of-args (like MIRROR_SYNTHESIS), we store the
// source code of the function as text. getPrompt returns that same text; the
// calling module is responsible for reinstantiating it via Function() or
// keeping a local copy of the template as its FALLBACK.
//
// In practice we take a simpler path: each calling module continues to hold
// the template function locally (the FALLBACK constant), and the registry
// stores a stable string identifier that the module uses to tell whether the
// active version matches its local template or has been overridden. When a
// reflection-proposed rewrite is approved, the new body replaces the local
// template via a hot swap managed by the calling module.
//
// For this v1 implementation we keep things concrete: only text-valued prompts
// (not function-valued templates) are stored in the registry. Function-valued
// templates keep their existing form and are NOT put through the registry in
// this phase. Their prompt names are still seeded so reflection can propose
// changes as pure text rewrites, but the calling module holds the FALLBACK.

const {
  MIRROR_SYNTHESIS, WIKI_SYNTHESIS, HEALTH_CONTRADICTIONS, GAP_ANALYSIS
} = require('../memory/synthesis-prompts');

// Pure text prompts — stored as plain strings in the registry.
const TEXT_PROMPTS = {
  'system.conversation': SYSTEM_CONVERSATION_FALLBACK,
  'extractor.actions': EXTRACTOR_ACTIONS_FALLBACK,
  'reflection.daily': REFLECTION_DAILY_FALLBACK
};

// Function-valued prompts — stored as their "template preview" string in the
// registry, which is the result of the template applied to placeholder args.
// The calling modules hold the function as their FALLBACK; the registry body
// is the *current* version of the template text, which reflection can edit.
const TEMPLATE_PROMPTS = {
  'synthesis.mirror': MIRROR_SYNTHESIS.toString(),
  'synthesis.wiki': WIKI_SYNTHESIS.toString(),
  'health.contradictions': HEALTH_CONTRADICTIONS.toString(),
  'health.gap_analysis': GAP_ANALYSIS.toString()
};

const SYSTEM_CONVERSATION_FALLBACK = `You are MOTHERSHIP — Yoel's personal AI operating system. You are not a generic assistant. You are a specific, persistent collaborator who is being built *with* Yoel, one conversation at a time.

# What this conversation is for
Yoel is actively building Mothership (you). He sends content — articles, videos, transcripts, ideas, random thoughts — and he wants you to do four things, every time:

1. **Review and comprehend** what he sent. Don't just acknowledge it — actually read it and identify the core insight.
2. **Consult the Mirror + Wiki** injected below to connect the content to how Yoel thinks and what he's building.
3. **Propose concrete next moves** for Mothership itself — features, modules, prompts, architecture decisions. Name files, sketch interfaces, call out tradeoffs.
4. **Respond in Yoel's voice register.** He's a senior builder. Skip preamble, skip hedging, skip "great question!" energy. Be direct and pick sides.

# Current Mothership architecture
- Node.js + Express, SQLite via sql.js (WASM, no native deps)
- Ingestion: Telegram bot, file watcher on ./inbox, URL/video processing
- Vision via Claude (src/vision.js), audio transcription, yt-dlp for video
- Quantum Mirror v2: dynamic mirror_entries + wiki_entries tables with semantic retrieval

# Output rules
- Plain prose, no markdown headers unless genuinely structured.
- Tight. One paragraph if one paragraph works.
- If Yoel sends a link/video, the transcript/summary IS the content — react to it.
- End with a concrete next step OR a sharp question, never both.`;

const EXTRACTOR_ACTIONS_FALLBACK = `You are an action extractor for MOTHERSHIP. Given a Yoel → Mothership conversation turn, identify structured events worth logging.

TURN:
USER: {{userText}}
MOTHERSHIP: {{assistantText}}

Extract up to 5 action candidates. Each candidate MUST match one of these kinds:
- commitment: Yoel stated an intention to do something (explicit, future-tense, first-person). Include data.what and data.due_at if stated (ISO date, null otherwise).
- win: Yoel reported completing or achieving something.
- stumble: Yoel reported failing, skipping, or falling short of something.
- state: Yoel reported a current physical, emotional, or mental state (energy, mood, focus, exhaustion). Include data.dimension ('energy'|'mood'|'focus'|'physical') and data.value (1-10 integer if parseable, null otherwise).
- preference: Yoel stated a durable preference ("I hate tools like X", "I always do Y first").

Output STRICT JSON:
{
  "candidates": [
    {"kind": "commitment", "subject": "short one-line description", "data": {...}, "confidence": 0.0-1.0}
  ]
}

Rules:
- confidence ≥ 0.8 for explicit first-person statements
- confidence 0.5-0.8 for strong implication
- confidence < 0.5 for weak hints (these will be dropped downstream)
- If the turn reveals no meaningful action, return {"candidates": []}.
- Subject is a single declarative phrase ≤100 chars.
- Output ONLY the JSON object.`;

const REFLECTION_DAILY_FALLBACK = `You are MOTHERSHIP's daily reflection agent. Your job is to review the last 24 hours of Yoel's actions and Mothership's own behavior, detect patterns, and propose improvements.

INPUTS (provided below):
- ACTIONS: structured events from the past 24h (user commitments/wins/stumbles/states/preferences, plus Mothership replies/synthesis/categorizations)
- ACTIVE MIRROR: currently-held cognitive profile entries
- ACTIVE PROMPTS: current bodies of Mothership's prompts that are eligible for self-critique

Produce a reflection with:
1. A markdown briefing for Yoel (warm but terse, like a senior peer running a morning check-in)
2. Patterns detected across the 24h window (commitment slippage, energy patterns, topic obsessions)
3. Self-critique items: any Mothership behavior that looked suboptimal, with concrete proposed prompt changes
4. Mirror proposals: any new or refined cognitive profile entries the patterns justify

Output STRICT JSON:
{
  "briefing_md": "string (markdown, 300-1500 chars)",
  "patterns": [{"description": "...", "evidence_action_ids": [...], "confidence": 0.0-1.0}],
  "self_critique": [{"prompt_name": "...", "issue": "...", "proposed_body": "...", "rationale": "..."}],
  "mirror_proposals": [{"category": "...", "content": "...", "confidence": 0.0-1.0, "supporting_action_ids": [...]}]
}

Rules:
- briefing_md leads with what matters today (open commitments, wins, state)
- self_critique items only when you have clear evidence from the action log
- mirror_proposals should be durable patterns, not ephemeral facts — those stay in the action log
- Output ONLY the JSON object.`;

function seedFromHardcoded() {
  // Register fallbacks for every known prompt first, so getPrompt is safe even
  // before the seed has written rows.
  setFallback('system.conversation', SYSTEM_CONVERSATION_FALLBACK);
  setFallback('extractor.actions', EXTRACTOR_ACTIONS_FALLBACK);
  setFallback('reflection.daily', REFLECTION_DAILY_FALLBACK);
  setFallback('synthesis.mirror', MIRROR_SYNTHESIS.toString());
  setFallback('synthesis.wiki', WIKI_SYNTHESIS.toString());
  setFallback('health.contradictions', HEALTH_CONTRADICTIONS.toString());
  setFallback('health.gap_analysis', GAP_ANALYSIS.toString());

  const seedEntries = [
    ['system.conversation', SYSTEM_CONVERSATION_FALLBACK],
    ['extractor.actions', EXTRACTOR_ACTIONS_FALLBACK],
    ['reflection.daily', REFLECTION_DAILY_FALLBACK],
    ['synthesis.mirror', MIRROR_SYNTHESIS.toString()],
    ['synthesis.wiki', WIKI_SYNTHESIS.toString()],
    ['health.contradictions', HEALTH_CONTRADICTIONS.toString()],
    ['health.gap_analysis', GAP_ANALYSIS.toString()]
  ];

  let created = 0;
  for (const [name, body] of seedEntries) {
    const existing = db.getActivePromptVersion(name);
    if (existing) continue;
    createVersion(name, body, { createdBy: 'bootstrap', activate: true });
    created++;
  }
  return created;
}
```

**Important ordering note:** JavaScript hoists `function` declarations but NOT `const` declarations. The `SYSTEM_CONVERSATION_FALLBACK` / `EXTRACTOR_ACTIONS_FALLBACK` / `REFLECTION_DAILY_FALLBACK` constants must appear textually BEFORE `seedFromHardcoded()` in the file. Reorder the file so that the constants are declared near the top (after the `require` and cache/map declarations), then the `getPrompt`/`createVersion`/etc. functions, and finally `seedFromHardcoded`. Delete the `TEXT_PROMPTS` / `TEMPLATE_PROMPTS` maps — they were explanatory scaffolding; the actual implementation lives in `seedFromHardcoded` directly.

Also update `module.exports` to add `seedFromHardcoded`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/prompts-registry.test.js`
Expected: all prior tests plus the two new ones pass.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/prompts/registry.js tests/prompts-registry.test.js
git commit -m "$(cat <<'EOF'
feat(prompts): seedFromHardcoded migration scrapes existing prompts into v1

Idempotent: skips prompts that already have an active version. Seeds
the three pure-text prompts (system.conversation, extractor.actions,
reflection.daily) and four template-function prompts (synthesis.mirror,
synthesis.wiki, health.contradictions, health.gap_analysis).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Wire `seedFromHardcoded()` into server boot

**Files:**
- Modify: `server.js` — add `prompts.seedFromHardcoded()` call after `db.init()`

- [ ] **Step 1: Add failing smoke test**

Create `tests/prompts-boot-seed.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-boot-seed-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const registry = require('../src/prompts/registry');

test('boot seed — registry populated after init + seedFromHardcoded', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });

  const n = registry.seedFromHardcoded();
  assert.ok(n >= 1, 'seed should create at least one row on fresh DB');

  // Every seeded prompt should be retrievable via getPrompt without throwing.
  for (const name of [
    'system.conversation', 'synthesis.mirror', 'synthesis.wiki',
    'health.contradictions', 'health.gap_analysis',
    'extractor.actions', 'reflection.daily'
  ]) {
    const body = registry.getPrompt(name);
    assert.ok(body && body.length > 0, `getPrompt('${name}') returned empty`);
  }
});
```

- [ ] **Step 2: Run to verify it passes without boot wiring**

Run: `npm test -- tests/prompts-boot-seed.test.js`
Expected: passes. (This test just verifies the registry can be used on a fresh DB. The boot wiring step is observational.)

- [ ] **Step 3: Wire into `server.js`**

In `server.js`, find the boot sequence (around line 50). After `await db.init()` and before `auth.init()`, add:

```javascript
  // 1a. Seed prompt registry (Phase 5). Idempotent: no-op after first boot.
  try {
    const prompts = require('./src/prompts/registry');
    const seeded = prompts.seedFromHardcoded();
    if (seeded > 0) console.log(`  ✔ Prompt registry seeded (${seeded} new entries)`);
    else console.log('  ✔ Prompt registry up to date');
  } catch (err) {
    console.log(`  ⚠ Prompt registry seed error: ${err.message}`);
  }
```

- [ ] **Step 4: Verify boot still starts**

Run: `node server.js` and watch for the "Prompt registry seeded" log line, then Ctrl-C. Expected: clean boot with the new line.

- [ ] **Step 5: Run full suite**

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add server.js tests/prompts-boot-seed.test.js
git commit -m "$(cat <<'EOF'
feat(boot): wire prompts.seedFromHardcoded() into server boot sequence

Runs after db.init() and before auth.init(). Idempotent; fresh DBs
get all known prompts seeded as v1, existing DBs are untouched.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Cut over `src/conversation.js` to the registry

**Files:**
- Modify: `src/conversation.js` — replace `buildStaticSystemPrompt()` body with a registry lookup; keep the hardcoded text as a local `FALLBACK` constant
- Test: `tests/conversation-registry-cutover.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/conversation-registry-cutover.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-conv-cutover-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const registry = require('../src/prompts/registry');

test('conversation registry cutover — setup', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });
  registry.seedFromHardcoded();
});

test('conversation.buildStaticSystemPrompt returns the active registry body', () => {
  const conversation = require('../src/conversation');
  const prompt = conversation._buildStaticSystemPrompt();
  assert.ok(prompt.includes('MOTHERSHIP'));
  assert.ok(prompt.includes("Yoel's voice register") || prompt.includes('voice register'));
});

test('conversation system prompt reflects registry after activateVersion', () => {
  registry.createVersion('system.conversation', 'CUSTOM BODY', { createdBy: 'test', activate: true });
  // Reload or clear cache to see the new value
  const conversation = require('../src/conversation');
  const prompt = conversation._buildStaticSystemPrompt();
  assert.strictEqual(prompt, 'CUSTOM BODY');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/conversation-registry-cutover.test.js`
Expected: fails — `_buildStaticSystemPrompt` is not exported.

- [ ] **Step 3: Edit `src/conversation.js`**

At the top of `src/conversation.js`, after `const hooks = require('./conversation-hooks');`, add:

```javascript
const prompts = require('./prompts/registry');
```

Replace the existing `buildStaticSystemPrompt()` function (lines 30-52) with:

```javascript
// Kept as a local fallback so the module is self-contained if the registry
// is unavailable. The registry is also seeded with this exact body on first
// boot (see src/prompts/registry.js seedFromHardcoded).
const SYSTEM_CONVERSATION_FALLBACK = `You are MOTHERSHIP — Yoel's personal AI operating system. You are not a generic assistant. You are a specific, persistent collaborator who is being built *with* Yoel, one conversation at a time.

# What this conversation is for
Yoel is actively building Mothership (you). He sends content — articles, videos, transcripts, ideas, random thoughts — and he wants you to do four things, every time:

1. **Review and comprehend** what he sent. Don't just acknowledge it — actually read it and identify the core insight.
2. **Consult the Mirror + Wiki** injected below to connect the content to how Yoel thinks and what he's building.
3. **Propose concrete next moves** for Mothership itself — features, modules, prompts, architecture decisions. Name files, sketch interfaces, call out tradeoffs.
4. **Respond in Yoel's voice register.** He's a senior builder. Skip preamble, skip hedging, skip "great question!" energy. Be direct and pick sides.

# Current Mothership architecture
- Node.js + Express, SQLite via sql.js (WASM, no native deps)
- Ingestion: Telegram bot, file watcher on ./inbox, URL/video processing
- Vision via Claude (src/vision.js), audio transcription, yt-dlp for video
- Quantum Mirror v2: dynamic mirror_entries + wiki_entries tables with semantic retrieval

# Output rules
- Plain prose, no markdown headers unless genuinely structured.
- Tight. One paragraph if one paragraph works.
- If Yoel sends a link/video, the transcript/summary IS the content — react to it.
- End with a concrete next step OR a sharp question, never both.`;

// Register fallback at module load so getPrompt never fails for this name.
prompts.setFallback('system.conversation', SYSTEM_CONVERSATION_FALLBACK);

function buildStaticSystemPrompt() {
  try {
    return prompts.getPrompt('system.conversation');
  } catch {
    return SYSTEM_CONVERSATION_FALLBACK;
  }
}
```

Update the `module.exports` at the bottom to expose `_buildStaticSystemPrompt` for test visibility:

```javascript
module.exports = { respond, _buildStaticSystemPrompt: buildStaticSystemPrompt };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/conversation-registry-cutover.test.js`
Expected: 2 tests pass.

- [ ] **Step 5: Run full suite**

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add src/conversation.js tests/conversation-registry-cutover.test.js
git commit -m "$(cat <<'EOF'
refactor(conversation): load system prompt via registry, keep fallback local

buildStaticSystemPrompt now calls prompts.getPrompt('system.conversation')
with a local SYSTEM_CONVERSATION_FALLBACK registered at module load. Body
unchanged — all seed + fallback paths point to the exact same string.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: (no standalone cutover — handled by Task 13)

`src/quantum-mirror.js` and `src/synthesizer.js` both need a new `logAction(...)` call but do NOT need a registry lookup at runtime (their prompts are template functions that take args, so they stay as local function imports from `./memory/synthesis-prompts`). Both the action-log wiring and the registry fallback registration happen together in **Task 13**, which runs after `src/action-logger.js` exists.

There is nothing to do in Task 10. Proceed to Task 11.

---

## Task 11: Cut over `src/health-check.js` — register fallbacks with the registry

**Files:**
- Modify: `src/health-check.js` — replace `HEALTH_CONTRADICTIONS` / `GAP_ANALYSIS` imports with registry-backed getters, keep the imported functions as local `FALLBACK_*`
- Test: extend `tests/health-check.test.js`

Note on the function-valued template problem: `HEALTH_CONTRADICTIONS` and `GAP_ANALYSIS` are functions that take args and return strings. The registry stores text bodies, not functions. We handle this by keeping the function form locally and only exposing the **template literal source** (the same string the registry was seeded with) through the registry. At runtime, `health-check.js` continues to call the local `HEALTH_CONTRADICTIONS(...)` function. The registry-stored body is used exclusively by the reflection agent's self-critique path. This matches the approach documented in Task 7's seed migration comments.

Therefore the "cutover" for this file is a no-op at the CALL SITE. The only thing this task does is register the fallbacks with the registry at module load so the registry always has a body to serve even before `seedFromHardcoded()` has run.

- [ ] **Step 1: Add failing test**

Append to `tests/health-check.test.js` (if it exists) — or create it — a test that verifies the registry returns `health.contradictions`:

```javascript
test('health-check registers fallbacks with the registry at module load', () => {
  const registry = require('../src/prompts/registry');
  require('../src/health-check');   // triggers module load
  const body = registry.getPrompt('health.contradictions');
  assert.ok(body && body.length > 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/health-check.test.js`
Expected: fails (registry either has no row and no fallback, or `getPrompt` throws).

- [ ] **Step 3: Edit `src/health-check.js`**

Near the top of the file, after the imports, add:

```javascript
const prompts = require('./prompts/registry');
prompts.setFallback('health.contradictions', HEALTH_CONTRADICTIONS.toString());
prompts.setFallback('health.gap_analysis', GAP_ANALYSIS.toString());
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/health-check.test.js`
Expected: pass.

- [ ] **Step 5: Run full suite**

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add src/health-check.js tests/health-check.test.js
git commit -m "$(cat <<'EOF'
refactor(health-check): register synthesis-prompt fallbacks with registry

No runtime change — HEALTH_CONTRADICTIONS and GAP_ANALYSIS are still
called as local template functions. The registry now holds their
stringified form as a fallback so reflection.daily can diff them
during self-critique.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Create `src/action-logger.js` with direct `logAction()`

**Files:**
- Create: `src/action-logger.js`
- Test: `tests/action-logger.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/action-logger.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-action-logger-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const users = require('../src/auth/users');
const authRoles = require('../src/auth/roles');
const actionLogger = require('../src/action-logger');

let uid;

test('action-logger — setup', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });
  await authRoles.seedOnce(db);
  uid = await users.createUser({ email: 'al@x', password: 'p' });
});

test('logAction writes a row via db.addAction', () => {
  const id = actionLogger.logAction({
    kind: 'mothership_reply',
    subject: 'test reply',
    data: { prompt_version: 'system.conversation@1' },
    sourceType: 'hook',
    sourceId: 'msg-1',
    userId: uid
  });
  assert.ok(id);
  const rows = db.getActions({ userId: uid, kind: 'mothership_reply' });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].data.prompt_version, 'system.conversation@1');
});

test('logAction swallows DB errors (never throws) and logs to db.log', () => {
  // Force a schema violation — missing required field
  assert.doesNotThrow(() => actionLogger.logAction({
    kind: null,  // will trigger addAction's "kind required" throw
    subject: 'x',
    sourceType: 'hook',
    userId: uid
  }));
});

test('confirmPendingAction flips status to active', () => {
  const id = actionLogger.logAction({
    kind: 'commitment', subject: 'do x',
    sourceType: 'conversation', status: 'pending_confirm', userId: uid
  });
  actionLogger.confirmPendingAction(id);
  const row = db.getActions({ userId: uid, kind: 'commitment' }).find(r => r.id === id);
  assert.strictEqual(row.status, 'active');
});

test('rejectPendingAction flips status to rejected', () => {
  const id = actionLogger.logAction({
    kind: 'state', subject: 'tired',
    sourceType: 'conversation', status: 'pending_confirm', userId: uid
  });
  actionLogger.rejectPendingAction(id);
  const row = db.getActions({ userId: uid, kind: 'state' }).find(r => r.id === id);
  assert.strictEqual(row.status, 'rejected');
});

test('resolveAction links commitment to resolving win', () => {
  const c = actionLogger.logAction({
    kind: 'commitment', subject: 'ship',
    sourceType: 'conversation', userId: uid
  });
  const w = actionLogger.logAction({
    kind: 'win', subject: 'shipped',
    sourceType: 'conversation', userId: uid
  });
  actionLogger.resolveAction(c, w);
  const row = db.getActions({ userId: uid, kind: 'commitment' }).find(r => r.id === c);
  assert.strictEqual(row.status, 'resolved');
  assert.strictEqual(row.parent_action_id, w);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/action-logger.test.js`
Expected: fails with "Cannot find module '../src/action-logger'".

- [ ] **Step 3: Create `src/action-logger.js`**

```javascript
/**
 * MOTHERSHIP — Action Logger
 *
 * Thin wrapper over db.addAction + status helpers. Two concerns:
 * 1. logAction() — direct structured log, used by Mothership-side callsites
 *    (conversation.js, quantum-mirror.js, synthesizer.js, processor.js)
 *    and by the hybrid extractor after it classifies a user turn.
 * 2. logActionFromTurn() — orchestrates the action-extractor LLM pass and
 *    auto-logs high-confidence candidates / queues borderline ones. Added
 *    in a later task.
 *
 * All calls are swallow-on-error: we never break the user path because an
 * audit write failed. Matches the existing pattern in conversation-hooks.js
 * and quantum-mirror.js.
 */

const db = require('./database');

function logAction({ kind, subject, data = {}, confidence = 0.8, status = 'active',
                     sourceType, sourceId = null, parentActionId = null, userId }) {
  try {
    return db.addAction({
      kind, subject, data, confidence, status,
      sourceType, sourceId, parentActionId, userId
    });
  } catch (err) {
    try { db.log('error', 'action-logger', err.message, { kind, subject }); } catch {}
    return null;
  }
}

function confirmPendingAction(actionId) {
  try {
    db.updateActionStatus(actionId, 'active');
  } catch (err) {
    db.log('error', 'action-logger', `confirm failed: ${err.message}`, { actionId });
  }
}

function rejectPendingAction(actionId) {
  try {
    db.updateActionStatus(actionId, 'rejected');
  } catch (err) {
    db.log('error', 'action-logger', `reject failed: ${err.message}`, { actionId });
  }
}

function resolveAction(commitmentId, resolvingActionId) {
  try {
    db.resolveAction(commitmentId, resolvingActionId);
  } catch (err) {
    db.log('error', 'action-logger', `resolve failed: ${err.message}`, { commitmentId });
  }
}

module.exports = {
  logAction,
  confirmPendingAction,
  rejectPendingAction,
  resolveAction
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/action-logger.test.js`
Expected: 5 tests pass.

- [ ] **Step 5: Run full suite**

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add src/action-logger.js tests/action-logger.test.js
git commit -m "$(cat <<'EOF'
feat(action-logger): direct logAction + confirm/reject/resolve

Thin wrapper over db.addAction with swallow-on-error semantics — audit
writes never break the user path. confirmPendingAction / rejectPendingAction
transition pending_confirm rows, resolveAction links commitments to wins.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Wire `mothership_*` action logs into existing callsites

**Files:**
- Modify: `src/conversation.js` — log `mothership_reply` after each successful reply
- Modify: `src/quantum-mirror.js` — log `mothership_synthesis` after each synthesis run
- Modify: `src/synthesizer.js` — log `mothership_synthesis` after each wiki synthesis run
- Modify: `src/processor.js` — log `mothership_categorize` after each file categorization
- Test: extend existing test files (`tests/quantum-mirror.test.js`, `tests/synthesizer.test.js`, `tests/processor-extensions.test.js`) with one action-log assertion each

- [ ] **Step 1: Add failing assertions to existing tests**

**In `tests/quantum-mirror.test.js`**, find the existing `synthesizeFromTurn` test and add at the end:

```javascript
const actions = db.getActions({ userId: testUserId, kind: 'mothership_synthesis' });
assert.ok(actions.length >= 1, 'mothership_synthesis action not logged');
assert.strictEqual(actions[0].data.prompt_version, 'synthesis.mirror');
```

**In `tests/synthesizer.test.js`**, find the existing synthesis test and add:

```javascript
const actions = db.getActions({ userId: testUserId, kind: 'mothership_synthesis' });
assert.ok(actions.some(a => a.data.prompt_version === 'synthesis.wiki'));
```

**In `tests/processor-extensions.test.js`**, find a test that calls `processor.processFile` and add at the end:

```javascript
const actions = db.getActions({ userId: testUserId, kind: 'mothership_categorize' });
assert.ok(actions.length >= 1, 'mothership_categorize action not logged');
```

These tests may need small edits to plumb a `userId` parameter if they do not already — existing tests in this project should already use auth-aware fixtures; check before editing.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/quantum-mirror.test.js tests/synthesizer.test.js tests/processor-extensions.test.js`
Expected: the three new assertions fail.

- [ ] **Step 3: Add logAction calls**

**Edit `src/quantum-mirror.js`:** at the top, add `const { logAction } = require('./action-logger');`. Inside `synthesizeFromTurn`, after the `db.log('info', 'quantum-mirror', ...)` line and before `return { created, superseded };`, insert:

```javascript
  logAction({
    kind: 'mothership_synthesis',
    subject: `mirror synthesis: +${created} new, ${superseded} superseded`,
    data: { created, superseded, prompt_version: 'synthesis.mirror' },
    sourceType: 'hook',
    sourceId,
    userId
  });
```

**Edit `src/synthesizer.js`:** at the top, add `const { logAction } = require('./action-logger');`. Find the main synthesis function (likely `synthesizeFromContent`) and after its core work, before its return, add:

```javascript
  logAction({
    kind: 'mothership_synthesis',
    subject: `wiki synthesis: ${topicsProcessed || 0} topics`,
    data: { topics_processed: topicsProcessed || 0, prompt_version: 'synthesis.wiki' },
    sourceType: 'hook',
    sourceId,
    userId
  });
```

Adjust `topicsProcessed` to the actual local variable name used in that function.

**Edit `src/processor.js`:** at the top, add `const { logAction } = require('./action-logger');`. In each process function (`processImage`, `processPdf`, `processAudio`, `processText`, `processVideo`), after the successful `db.addMessage(...)` call that returns `messageId`, add:

```javascript
  logAction({
    kind: 'mothership_categorize',
    subject: `categorized as ${kind}`,
    data: { detected_kind: kind, filename: path.basename(filePath) },
    sourceType: 'ingestion',
    sourceId: messageId,
    userId: resolvedUserId
  });
```

where `kind` is `'image'` / `'pdf'` / `'audio'` / etc. for the specific handler. Check that each handler has `resolvedUserId` in scope; if not, use the local `userId` variable.

**Edit `src/conversation.js`:** at the top, add `const { logAction } = require('./action-logger');`. At the end of `respond()`, after `logUsage(...)` and before `return text;`, add:

```javascript
  try {
    logAction({
      kind: 'mothership_reply',
      subject: `reply to ${opts.contextKind || 'text'} turn`,
      data: {
        prompt_version: 'system.conversation',
        tokens_in: response.usage?.input_tokens || 0,
        tokens_out: response.usage?.output_tokens || 0,
        context_kind: opts.contextKind || 'text'
      },
      sourceType: 'conversation',
      sourceId: null,
      userId
    });
  } catch {}
```

- [ ] **Step 4: Run targeted tests to verify they pass**

Run: `npm test -- tests/quantum-mirror.test.js tests/synthesizer.test.js tests/processor-extensions.test.js`
Expected: the three assertions pass.

- [ ] **Step 5: Run full suite**

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add src/conversation.js src/quantum-mirror.js src/synthesizer.js src/processor.js \
        tests/quantum-mirror.test.js tests/synthesizer.test.js tests/processor-extensions.test.js
git commit -m "$(cat <<'EOF'
feat(action-log): wire mothership_* logs into conversation/mirror/synth/processor

Every successful reply, mirror synthesis, wiki synthesis, and file
categorization now writes a mothership_* action row. This is the audit
trail the reflection agent will critique and the replay eval will use
to reconstruct historical inputs.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Create `src/extractors/action-extractor.js`

**Files:**
- Create: `src/extractors/action-extractor.js`
- Test: `tests/action-extractor.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/action-extractor.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-extractor-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const registry = require('../src/prompts/registry');
const extractor = require('../src/extractors/action-extractor');

test('action-extractor — setup', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });
  registry.seedFromHardcoded();
});

test('extract returns parsed candidates from mocked Claude', async () => {
  extractor._setClient({
    messages: { create: async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        candidates: [
          { kind: 'commitment', subject: 'ship mirror v2', data: { due_at: '2026-04-17' }, confidence: 0.92 },
          { kind: 'state', subject: 'exhausted', data: { dimension: 'energy', value: 3 }, confidence: 0.7 }
        ]
      }) }]
    }) }
  });
  const result = await extractor.extract({
    userText: "I'll ship mirror v2 by Friday. Exhausted today.",
    assistantText: 'noted',
    userId: 'test-user'
  });
  assert.strictEqual(result.candidates.length, 2);
  assert.strictEqual(result.candidates[0].kind, 'commitment');
  assert.strictEqual(result.candidates[1].confidence, 0.7);
});

test('extract returns empty candidates on malformed JSON', async () => {
  extractor._setClient({
    messages: { create: async () => ({
      content: [{ type: 'text', text: 'not json at all' }]
    }) }
  });
  const result = await extractor.extract({
    userText: "I'll do something with enough length to pass the guard",
    assistantText: 'ok',
    userId: 'test-user'
  });
  assert.deepStrictEqual(result.candidates, []);
});

test('extract short-circuits on short input (no API call)', async () => {
  let called = false;
  extractor._setClient({
    messages: { create: async () => { called = true; return { content: [{ type: 'text', text: '{}' }] }; } }
  });
  const result = await extractor.extract({
    userText: 'hi',
    assistantText: 'hey',
    userId: 'test-user'
  });
  assert.strictEqual(called, false);
  assert.deepStrictEqual(result.candidates, []);
});

test('extract recovers JSON from text with prose around it', async () => {
  extractor._setClient({
    messages: { create: async () => ({
      content: [{ type: 'text', text: 'Here is the JSON: { "candidates": [{"kind":"win","subject":"closed deal","data":{},"confidence":0.9}] } end.' }]
    }) }
  });
  const result = await extractor.extract({
    userText: 'I closed the Acme deal today — huge relief after months of back and forth',
    assistantText: 'congrats',
    userId: 'test-user'
  });
  assert.strictEqual(result.candidates.length, 1);
  assert.strictEqual(result.candidates[0].kind, 'win');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/action-extractor.test.js`
Expected: fails with "Cannot find module '../src/extractors/action-extractor'".

- [ ] **Step 3: Create `src/extractors/action-extractor.js`**

```javascript
/**
 * MOTHERSHIP — Action Extractor
 *
 * LLM pass that turns a conversation turn into structured action candidates.
 * Called by action-logger.logActionFromTurn() after each qualifying
 * postResponse hook.
 *
 * Uses claude-haiku-4-5 by default (much cheaper than the opus call running
 * for the reply itself). Swappable via _setClient() for tests.
 */

const Anthropic = require('@anthropic-ai/sdk');
const db = require('../database');
const prompts = require('../prompts/registry');

const MODEL = process.env.ACTION_EXTRACTOR_MODEL || 'claude-haiku-4-5';
const MAX_TOKENS = 800;
const MIN_TEXT_LENGTH = parseInt(process.env.ACTION_MIN_CHARS || '40', 10);

let client = null;
function _setClient(c) { client = c; }
function getClient() {
  if (client) return client;
  client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxRetries: 2,
    timeout: 60_000
  });
  return client;
}

function parseJsonFromText(text) {
  const trimmed = (text || '').trim();
  try { return JSON.parse(trimmed); }
  catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); }
      catch { return null; }
    }
    return null;
  }
}

function buildPrompt({ userText, assistantText }) {
  // The reflection.daily registry body is not used here; extractor has its
  // own prompt. Load it from the registry so prompt versioning works.
  const template = prompts.getPrompt('extractor.actions');
  return template
    .replace('{{userText}}', userText || '')
    .replace('{{assistantText}}', assistantText || '');
}

async function extract({ userText, assistantText, userId }) {
  if (!userText || userText.length < MIN_TEXT_LENGTH) {
    return { candidates: [] };
  }
  if (process.env.ACTION_EXTRACTION_ENABLED === 'false') {
    return { candidates: [] };
  }

  try {
    const c = getClient();
    const prompt = buildPrompt({ userText, assistantText });
    const res = await c.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = res.content.find(b => b.type === 'text')?.text || '{}';
    const parsed = parseJsonFromText(text);
    if (!parsed || !Array.isArray(parsed.candidates)) {
      db.log('warn', 'action-extractor', 'non-JSON response', { sample: text.slice(0, 200) });
      return { candidates: [] };
    }
    return { candidates: parsed.candidates };
  } catch (err) {
    db.log('error', 'action-extractor', err.message);
    return { candidates: [] };
  }
}

module.exports = { extract, _setClient };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/action-extractor.test.js`
Expected: 4 tests pass.

- [ ] **Step 5: Run full suite**

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add src/extractors/action-extractor.js tests/action-extractor.test.js
git commit -m "$(cat <<'EOF'
feat(extractors): action-extractor LLM pass over conversation turns

Uses claude-haiku-4-5 by default (cheap), loads its prompt from
the registry, short-circuits on < 40-char input and on the
ACTION_EXTRACTION_ENABLED=false kill switch. Malformed JSON and
API failures return empty candidates instead of throwing.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Add `logActionFromTurn()` to action-logger

**Files:**
- Modify: `src/action-logger.js` — add `logActionFromTurn()` that orchestrates the extractor
- Test: extend `tests/action-logger.test.js`

- [ ] **Step 1: Add failing test**

Append to `tests/action-logger.test.js`:

```javascript
const extractor = require('../src/extractors/action-extractor');

test('logActionFromTurn auto-logs high-confidence candidates', async () => {
  extractor._setClient({
    messages: { create: async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        candidates: [
          { kind: 'commitment', subject: 'ship v2', data: {}, confidence: 0.92 },
          { kind: 'state', subject: 'tired', data: {}, confidence: 0.6 },
          { kind: 'preference', subject: 'weak signal', data: {}, confidence: 0.3 }
        ]
      }) }]
    }) }
  });

  const result = await actionLogger.logActionFromTurn({
    userText: "I'll ship v2 this week and I'm tired today",
    assistantText: 'got it',
    sourceId: 'msg-test',
    userId: uid
  });

  // 0.92 → auto, 0.6 → pending_confirm, 0.3 → dropped
  assert.strictEqual(result.autoLogged, 1);
  assert.strictEqual(result.queued, 1);
  assert.strictEqual(result.dropped, 1);

  const active = db.getActions({ userId: uid, kind: 'commitment', status: 'active' });
  assert.ok(active.some(a => a.subject === 'ship v2'));

  const pending = db.getActions({ userId: uid, kind: 'state', status: 'pending_confirm' });
  assert.ok(pending.some(a => a.subject === 'tired'));
});

test('logActionFromTurn tolerates extractor failure (no throw)', async () => {
  extractor._setClient({
    messages: { create: async () => { throw new Error('api down'); } }
  });
  const result = await actionLogger.logActionFromTurn({
    userText: 'long enough text to pass the guard and trigger a call',
    assistantText: 'ok',
    sourceId: 'msg-fail',
    userId: uid
  });
  assert.strictEqual(result.autoLogged, 0);
  assert.strictEqual(result.queued, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/action-logger.test.js`
Expected: fails — `logActionFromTurn is not a function`.

- [ ] **Step 3: Add `logActionFromTurn` to `src/action-logger.js`**

Append before `module.exports`:

```javascript
const AUTOLOG_CONFIDENCE = parseFloat(process.env.ACTION_AUTOLOG_CONFIDENCE || '0.75');
const QUEUE_CONFIDENCE = parseFloat(process.env.ACTION_QUEUE_CONFIDENCE || '0.5');

async function logActionFromTurn({ userText, assistantText, sourceId, userId }) {
  if (!userId) return { autoLogged: 0, queued: 0, dropped: 0 };

  // Lazy-require to avoid a hard cycle: extractor → action-logger should be
  // one-way. action-logger only imports extractor, never the reverse.
  const extractor = require('./extractors/action-extractor');

  let result;
  try {
    result = await extractor.extract({ userText, assistantText, userId });
  } catch (err) {
    db.log('error', 'action-logger', `extractor failed: ${err.message}`);
    return { autoLogged: 0, queued: 0, dropped: 0 };
  }

  const candidates = result?.candidates || [];
  let autoLogged = 0;
  let queued = 0;
  let dropped = 0;

  for (const cand of candidates) {
    if (!cand || !cand.kind || !cand.subject) { dropped++; continue; }
    const conf = typeof cand.confidence === 'number' ? cand.confidence : 0;
    if (conf >= AUTOLOG_CONFIDENCE) {
      logAction({
        kind: cand.kind,
        subject: cand.subject,
        data: cand.data || {},
        confidence: conf,
        status: 'active',
        sourceType: 'conversation',
        sourceId,
        userId
      });
      autoLogged++;
    } else if (conf >= QUEUE_CONFIDENCE) {
      logAction({
        kind: cand.kind,
        subject: cand.subject,
        data: cand.data || {},
        confidence: conf,
        status: 'pending_confirm',
        sourceType: 'conversation',
        sourceId,
        userId
      });
      queued++;
    } else {
      dropped++;
    }
  }

  return { autoLogged, queued, dropped };
}
```

Update `module.exports`:

```javascript
module.exports = {
  logAction,
  logActionFromTurn,
  confirmPendingAction,
  rejectPendingAction,
  resolveAction
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/action-logger.test.js`
Expected: 7 tests pass (5 prior + 2 new).

- [ ] **Step 5: Run full suite**

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add src/action-logger.js tests/action-logger.test.js
git commit -m "$(cat <<'EOF'
feat(action-logger): logActionFromTurn orchestrates extractor + hybrid capture

High-confidence (≥0.75) candidates auto-log as active, borderline
(0.5-0.75) queue as pending_confirm, low-confidence (<0.5) drop.
Extractor failures return zero counts without throwing.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Wire `logActionFromTurn` into `conversation-hooks.postResponse`

**Files:**
- Modify: `src/conversation-hooks.js` — add tail call to `logActionFromTurn`
- Modify: `tests/conversation-hooks.test.js` — add assertion that action rows appear

- [ ] **Step 1: Add failing assertion**

In `tests/conversation-hooks.test.js`, add a new test at the end:

```javascript
test('conversation-hooks — postResponse calls logActionFromTurn', async () => {
  qm._setClient({
    messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify({ new_entries: [], supersede: [], contradictions: [] }) }] }) }
  });
  const extractor = require('../src/extractors/action-extractor');
  extractor._setClient({
    messages: { create: async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        candidates: [{ kind: 'commitment', subject: 'hook test', data: {}, confidence: 0.9 }]
      }) }]
    }) }
  });
  await hooks.postResponse({
    userText: "I'll do something meaningful and I really mean it this time",
    assistantText: 'ok',
    sourceId: 'hook-test',
    userId: testUserId
  });
  const actions = db.getActions({ userId: testUserId, kind: 'commitment' });
  assert.ok(actions.some(a => a.subject === 'hook test'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/conversation-hooks.test.js`
Expected: the new test fails — no action row.

- [ ] **Step 3: Edit `src/conversation-hooks.js`**

Add a require line at the top:

```javascript
const actionLogger = require('./action-logger');
```

Inside `postResponse`, after the existing `qm.synthesizeFromTurn` call, add a second tail call:

```javascript
  try {
    await actionLogger.logActionFromTurn({ userText, assistantText, sourceId, userId });
  } catch (err) {
    db.log('error', 'hooks.postResponse.extractor', err.message);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/conversation-hooks.test.js`
Expected: all tests including the new one pass.

- [ ] **Step 5: Run full suite**

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add src/conversation-hooks.js tests/conversation-hooks.test.js
git commit -m "$(cat <<'EOF'
feat(hooks): wire logActionFromTurn into postResponse

Every conversation turn now runs action extraction after the mirror
synthesis tail call. Swallow-on-error; user replies never break.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: Create `src/prompts/replay.js` — replay eval harness

**Files:**
- Create: `src/prompts/replay.js`
- Test: `tests/prompts-replay.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/prompts-replay.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-replay-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const users = require('../src/auth/users');
const authRoles = require('../src/auth/roles');
const registry = require('../src/prompts/registry');
const replay = require('../src/prompts/replay');

let uid;

test('replay — setup', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });
  await authRoles.seedOnce(db);
  uid = await users.createUser({ email: 'rp@x', password: 'p' });
  registry.seedFromHardcoded();
});

test('replay.run skips when sample size < 5', async () => {
  // Seed only 2 mothership_synthesis actions
  for (let i = 0; i < 2; i++) {
    db.addAction({
      kind: 'mothership_synthesis', subject: 'x', data: { prompt_version: 'synthesis.mirror' },
      sourceType: 'hook', userId: uid
    });
  }
  const out = await replay.run({
    promptName: 'synthesis.mirror',
    proposedBody: 'new body',
    sampleSize: 20,
    userId: uid
  });
  assert.strictEqual(out.skipped, true);
  assert.strictEqual(out.reason, 'insufficient_history');
});

test('replay.run returns structured diff when enough samples exist', async () => {
  // Seed 6 messages + 6 actions referencing them
  for (let i = 0; i < 6; i++) {
    const msgId = db.addMessage(`test user text ${i}`, 'telegram', 'uncategorized', {}, uid);
    db.addAction({
      kind: 'mothership_synthesis',
      subject: 'mirror synthesis',
      data: { prompt_version: 'synthesis.mirror' },
      sourceType: 'hook', sourceId: msgId, userId: uid
    });
  }

  let callCount = 0;
  replay._setClient({
    messages: { create: async () => {
      callCount++;
      return { content: [{ type: 'text', text: JSON.stringify({ new_entries: [], supersede: [] }) }] };
    }}
  });

  const out = await replay.run({
    promptName: 'synthesis.mirror',
    proposedBody: 'new body',
    sampleSize: 6,
    userId: uid
  });
  assert.strictEqual(out.skipped, undefined);
  assert.strictEqual(out.sample_size, 6);
  assert.ok(typeof out.agreement_rate === 'number');
  // Two prompts × 6 samples = 12 calls
  assert.strictEqual(callCount, 12);
});

test('replay.run tolerates per-sample failure', async () => {
  let i = 0;
  replay._setClient({
    messages: { create: async () => {
      i++;
      if (i === 3) throw new Error('simulated');
      return { content: [{ type: 'text', text: JSON.stringify({ new_entries: [] }) }] };
    }}
  });
  const out = await replay.run({
    promptName: 'synthesis.mirror',
    proposedBody: 'new body',
    sampleSize: 6,
    userId: uid
  });
  // Should not throw; sample_size should be ≤ 6 (surviving samples)
  assert.ok(out.sample_size <= 6);
  assert.ok(!out.error);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/prompts-replay.test.js`

- [ ] **Step 3: Create `src/prompts/replay.js`**

```javascript
/**
 * MOTHERSHIP — Prompt Replay Eval
 *
 * Runs a proposed prompt body against historical actions to show how it
 * would have behaved differently from the current active version. Used by
 * reflection.js when generating prompt_proposal rows.
 *
 * Deliberately cheap: uses claude-haiku-4-5 by default. Replay is a
 * previewing tool, not a production path — the real opus call still runs
 * live against whatever is active in the registry.
 */

const Anthropic = require('@anthropic-ai/sdk');
const db = require('../database');
const registry = require('./registry');

const MODEL = process.env.REPLAY_MODEL || 'claude-haiku-4-5';
const MAX_TOKENS = 800;
const MIN_SAMPLES = 5;

let client = null;
function _setClient(c) { client = c; }
function getClient() {
  if (client) return client;
  client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxRetries: 2,
    timeout: 60_000
  });
  return client;
}

function parseJsonFromText(text) {
  const trimmed = (text || '').trim();
  try { return JSON.parse(trimmed); }
  catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { return null; }
    }
    return null;
  }
}

function mapPromptNameToActionKind(promptName) {
  if (promptName === 'synthesis.mirror') return 'mothership_synthesis';
  if (promptName === 'synthesis.wiki') return 'mothership_synthesis';
  if (promptName === 'system.conversation') return 'mothership_reply';
  return 'mothership_reply';
}

async function runOne(body, sampleInput) {
  const c = getClient();
  const res = await c.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: `${body}\n\nINPUT:\n${sampleInput}` }]
  });
  const text = res.content.find(b => b.type === 'text')?.text || '';
  return parseJsonFromText(text) || { raw: text };
}

function reconstructInput(action) {
  if (!action.source_id) return null;
  const stmt = db._raw().prepare(`SELECT content FROM messages WHERE id = ?`);
  stmt.bind([action.source_id]);
  let content = null;
  if (stmt.step()) content = stmt.getAsObject().content;
  stmt.free();
  return content;
}

async function run({ promptName, proposedBody, sampleSize = 20, userId }) {
  if (!promptName || !proposedBody) throw new Error('replay.run: promptName and proposedBody required');

  const kind = mapPromptNameToActionKind(promptName);
  const allActions = db.getActions({ userId, kind, limit: sampleSize * 2 });
  const withInputs = allActions
    .map(a => ({ action: a, input: reconstructInput(a) }))
    .filter(x => x.input);

  if (withInputs.length < MIN_SAMPLES) {
    return {
      sample_size: withInputs.length,
      skipped: true,
      reason: 'insufficient_history'
    };
  }

  const samples = withInputs.slice(0, sampleSize);
  const activeBody = registry.getPrompt(promptName);

  const baseline_outputs = [];
  const proposed_outputs = [];
  let surviving = 0;

  for (const s of samples) {
    try {
      const b = await runOne(activeBody, s.input);
      const p = await runOne(proposedBody, s.input);
      baseline_outputs.push({ sample_id: s.action.id, output: b });
      proposed_outputs.push({ sample_id: s.action.id, output: p });
      surviving++;
    } catch (err) {
      db.log('warn', 'replay', `sample failed: ${err.message}`);
    }
  }

  // Deterministic diff: count how many samples produced identical outputs.
  let agreements = 0;
  const regressions = [];
  const improvements = [];
  for (let i = 0; i < baseline_outputs.length; i++) {
    const b = JSON.stringify(baseline_outputs[i].output);
    const p = JSON.stringify(proposed_outputs[i].output);
    if (b === p) { agreements++; continue; }
    // Heuristic: fewer new_entries in proposed → regression; more → improvement.
    const baseCount = baseline_outputs[i].output?.new_entries?.length || 0;
    const propCount = proposed_outputs[i].output?.new_entries?.length || 0;
    if (propCount < baseCount) regressions.push({ sample_id: baseline_outputs[i].sample_id, issue: 'dropped_entries' });
    else if (propCount > baseCount) improvements.push({ sample_id: baseline_outputs[i].sample_id, note: 'added_entries' });
  }

  return {
    sample_size: surviving,
    agreement_rate: surviving > 0 ? agreements / surviving : 0,
    regressions,
    improvements,
    baseline_sample: baseline_outputs.slice(0, 3),
    proposed_sample: proposed_outputs.slice(0, 3)
  };
}

module.exports = { run, _setClient };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/prompts-replay.test.js`
Expected: 3 tests pass.

- [ ] **Step 5: Run full suite**

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add src/prompts/replay.js tests/prompts-replay.test.js
git commit -m "$(cat <<'EOF'
feat(prompts): replay eval harness for prompt proposals

Pulls historical actions of the right kind, reconstructs their
inputs from the messages table, runs both active and proposed
prompt bodies through haiku, returns a deterministic diff
(agreement rate, regressions, improvements). Skips if < 5 samples.
Per-sample failures do not abort the run.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 18: Add `storeFromReflection()` to `src/quantum-mirror.js`

**Files:**
- Modify: `src/quantum-mirror.js` — new exported function
- Test: extend `tests/quantum-mirror.test.js`

- [ ] **Step 1: Add failing test**

Append to `tests/quantum-mirror.test.js`:

```javascript
test('storeFromReflection writes proposals via vector-engine', async () => {
  ve._setClient({
    embeddings: { create: async () => ({ data: [{ embedding: new Array(3).fill(0.5) }] }) }
  });
  const qm = require('../src/quantum-mirror');
  const out = await qm.storeFromReflection({
    proposals: [
      { category: 'patterns', content: 'energy dips Wednesdays', confidence: 0.7, supporting_action_ids: ['a','b'] },
      { category: 'goals', content: 'wants to ship phase 5 by May', confidence: 0.8 }
    ],
    userId: testUserId,
    reflectionId: 'refl-test'
  });
  assert.strictEqual(out.stored, 2);

  const entries = db.getMirrorEntries({ userId: testUserId });
  assert.ok(entries.some(e => e.content === 'energy dips Wednesdays' && e.source_type === 'reflection'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/quantum-mirror.test.js`
Expected: fails — `qm.storeFromReflection is not a function`.

- [ ] **Step 3: Add function to `src/quantum-mirror.js`**

Append before `module.exports`:

```javascript
async function storeFromReflection({ proposals = [], userId, reflectionId }) {
  if (!userId) throw new Error('storeFromReflection: userId required');
  let stored = 0;
  for (const p of proposals) {
    try {
      await ve.storeMirrorEntry({
        category: p.category,
        content: p.content,
        confidence: p.confidence ?? 0.6,
        source_type: 'reflection',
        source_id: reflectionId,
        userId
      });
      stored++;
    } catch (err) {
      db.log('error', 'quantum-mirror', `storeFromReflection failed: ${err.message}`);
    }
  }
  return { stored };
}
```

Update `module.exports`:

```javascript
module.exports = { synthesizeFromTurn, storeFromReflection, _setClient };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/quantum-mirror.test.js`

- [ ] **Step 5: Run full suite**

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add src/quantum-mirror.js tests/quantum-mirror.test.js
git commit -m "$(cat <<'EOF'
feat(mirror): storeFromReflection writes reflection-sourced mirror entries

Flows through vector-engine.storeMirrorEntry so reflection-sourced
entries get embeddings and participate in semantic retrieval. Uses
source_type='reflection' so they can be filtered or bulk-cleaned.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 19: Create `src/reflection.js` — core `runNow()`

**Files:**
- Create: `src/reflection.js`
- Test: `tests/reflection.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/reflection.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-reflection-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const users = require('../src/auth/users');
const authRoles = require('../src/auth/roles');
const registry = require('../src/prompts/registry');
const ve = require('../src/memory/vector-engine');
const reflection = require('../src/reflection');
const replay = require('../src/prompts/replay');

let uid;

test('reflection — setup', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });
  await authRoles.seedOnce(db);
  uid = await users.createUser({ email: 'rf@x', password: 'p' });
  registry.seedFromHardcoded();
  ve._setClient({
    embeddings: { create: async () => ({ data: [{ embedding: new Array(3).fill(0.5) }] }) }
  });

  // Seed 3 actions in the last 24h
  for (let i = 0; i < 3; i++) {
    db.addAction({
      kind: 'commitment', subject: `do thing ${i}`,
      sourceType: 'conversation', userId: uid
    });
  }
});

test('runNow writes a reflection row and processes LLM output', async () => {
  reflection._setClient({
    messages: { create: async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        briefing_md: '# Today\n\nTest briefing.',
        patterns: [{ description: 'test pattern', evidence_action_ids: [], confidence: 0.8 }],
        self_critique: [],
        mirror_proposals: [
          { category: 'patterns', content: 'test pattern fact', confidence: 0.7 }
        ]
      }) }]
    }) }
  });
  replay._setClient({
    messages: { create: async () => ({ content: [{ type: 'text', text: '{}' }] }) }
  });

  const out = await reflection.runNow({ userId: uid });
  assert.ok(out.reflectionId);
  assert.strictEqual(out.mirrorProposalsStored, 1);

  const latest = db.getLatestReflection({ userId: uid });
  assert.ok(latest);
  assert.ok(latest.briefing_md.includes('Test briefing'));
});

test('runNow with self-critique creates prompt_proposals + replay', async () => {
  reflection._setClient({
    messages: { create: async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        briefing_md: 'b',
        patterns: [],
        self_critique: [{
          prompt_name: 'synthesis.mirror',
          issue: 'misses thin categories',
          proposed_body: 'IMPROVED PROMPT BODY',
          rationale: 'needs better coverage'
        }],
        mirror_proposals: []
      }) }]
    }) }
  });

  await reflection.runNow({ userId: uid });
  const proposals = db.getPendingPromptProposals();
  assert.ok(proposals.some(p => p.prompt_name === 'synthesis.mirror' && p.proposed_body === 'IMPROVED PROMPT BODY'));
});

test('runNow concurrency lock returns already_running on second call', async () => {
  let release;
  const blocker = new Promise(r => { release = r; });
  reflection._setClient({
    messages: { create: async () => {
      await blocker;
      return { content: [{ type: 'text', text: JSON.stringify({
        briefing_md: 'x', patterns: [], self_critique: [], mirror_proposals: []
      }) }] };
    }}
  });
  const first = reflection.runNow({ userId: uid });
  const second = await reflection.runNow({ userId: uid });
  assert.strictEqual(second.status, 'already_running');
  release();
  await first;
});

test('runNow tolerates Claude failure cleanly', async () => {
  reflection._setClient({
    messages: { create: async () => { throw new Error('api down'); } }
  });
  const out = await reflection.runNow({ userId: uid });
  assert.strictEqual(out.status, 'failed');
  assert.ok(out.error);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/reflection.test.js`

- [ ] **Step 3: Create `src/reflection.js`**

```javascript
/**
 * MOTHERSHIP — Reflection Agent
 *
 * Daily self-improvement pass. Walks the last 24h of actions (user + Mothership),
 * asks Claude to critique Mothership's behavior and detect user patterns,
 * writes a reflection row, pushes proposed Mirror entries through the vector
 * engine, and queues prompt proposals for approval via dashboard or Telegram.
 *
 * Structure mirrors health-check.js — cron pattern, opus call, report write.
 */

const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');
const registry = require('./prompts/registry');
const replay = require('./prompts/replay');
const qm = require('./quantum-mirror');

const MODEL = process.env.REFLECTION_MODEL || 'claude-opus-4-6';
const MAX_TOKENS = 3000;
const WINDOW_HOURS = parseFloat(process.env.REFLECTION_WINDOW_HOURS || '24');
const MAX_PENDING_PROPOSALS = parseInt(process.env.MAX_PENDING_PROPOSALS || '20', 10);

let client = null;
function _setClient(c) { client = c; }
function getClient() {
  if (client) return client;
  client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxRetries: 3,
    timeout: 120_000
  });
  return client;
}

let reflectionInProgress = false;

function parseJsonFromText(text) {
  const trimmed = (text || '').trim();
  try { return JSON.parse(trimmed); }
  catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { return null; }
    }
    return null;
  }
}

function buildWindow() {
  const end = new Date();
  const start = new Date(end.getTime() - WINDOW_HOURS * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function buildReflectionPrompt({ actions, mirrorSnapshot, activePrompts, windowStart, windowEnd }) {
  const template = registry.getPrompt('reflection.daily');
  const actionsDump = actions.map(a =>
    `- [${a.id.slice(0, 8)}] (${a.kind}, conf=${a.confidence}, ${a.created_at}) ${a.subject}` +
    (Object.keys(a.data || {}).length ? ` ${JSON.stringify(a.data)}` : '')
  ).join('\n');

  return `${template}

WINDOW: ${windowStart} to ${windowEnd}

ACTIONS:
${actionsDump || '(none)'}

ACTIVE MIRROR (cognitive profile):
${mirrorSnapshot}

ACTIVE PROMPTS ELIGIBLE FOR CRITIQUE:
${activePrompts.map(p => `## ${p.name} (v${p.version})\n${p.body}`).join('\n\n')}
`;
}

async function runNow({ userId }) {
  if (!userId) throw new Error('runNow: userId required');
  if (reflectionInProgress) {
    return { status: 'already_running', started_at: reflectionInProgress };
  }
  reflectionInProgress = new Date().toISOString();

  try {
    const { start, end } = buildWindow();
    const actions = db.getActionsByWindow({ userId, windowStart: start, windowEnd: end });

    const mirrorRows = db.getMirrorEntries({ userId, limit: 100 });
    const mirrorSnapshot = mirrorRows.map(r => `- [${r.category}] (${r.confidence}) ${r.content}`).join('\n') || '(empty)';

    const activePrompts = registry.listActive();

    const prompt = buildReflectionPrompt({
      actions, mirrorSnapshot, activePrompts,
      windowStart: start, windowEnd: end
    });

    let parsed;
    try {
      const c = getClient();
      const res = await c.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }]
      });
      const text = res.content.find(b => b.type === 'text')?.text || '{}';
      parsed = parseJsonFromText(text);
    } catch (err) {
      db.log('error', 'reflection', `LLM call failed: ${err.message}`);
      return { status: 'failed', error: err.message };
    }

    if (!parsed) {
      return { status: 'failed', error: 'unparseable_response' };
    }

    const reflectionId = db.addReflection({
      userId,
      windowStart: start,
      windowEnd: end,
      briefingMd: parsed.briefing_md || '',
      actionCount: actions.length,
      patternJson: { patterns: parsed.patterns || [] },
      selfCritiqueJson: { items: parsed.self_critique || [] }
    });

    // Store mirror proposals
    let mirrorProposalsStored = 0;
    if (Array.isArray(parsed.mirror_proposals) && parsed.mirror_proposals.length) {
      try {
        const res = await qm.storeFromReflection({
          proposals: parsed.mirror_proposals,
          userId,
          reflectionId
        });
        mirrorProposalsStored = res.stored;
      } catch (err) {
        db.log('error', 'reflection', `mirror proposals failed: ${err.message}`);
      }
    }

    // Run replay for each self-critique proposal
    let promptProposalsCreated = 0;
    for (const sc of parsed.self_critique || []) {
      if (!sc?.prompt_name || !sc?.proposed_body) continue;

      const pending = db.countPromptProposals({ promptName: sc.prompt_name, status: 'pending' });
      if (pending >= MAX_PENDING_PROPOSALS) {
        db.log('warn', 'reflection', `skipping proposal — backlog cap hit for ${sc.prompt_name}`);
        continue;
      }

      const activeRow = db.getActivePromptVersion(sc.prompt_name);
      const baseVersion = activeRow?.version || 1;

      let replayResults = null;
      let replayError = null;
      try {
        replayResults = await replay.run({
          promptName: sc.prompt_name,
          proposedBody: sc.proposed_body,
          sampleSize: 20,
          userId
        });
      } catch (err) {
        replayError = err.message;
        db.log('warn', 'reflection', `replay failed for ${sc.prompt_name}: ${err.message}`);
      }

      db.addPromptProposal({
        promptName: sc.prompt_name,
        baseVersion,
        proposedBody: sc.proposed_body,
        rationale: sc.rationale || sc.issue || 'reflection self-critique',
        replayResultsJson: replayResults,
        replayError
      });
      promptProposalsCreated++;
    }

    return {
      status: 'ok',
      reflectionId,
      actionCount: actions.length,
      mirrorProposalsStored,
      promptProposalsCreated
    };
  } finally {
    reflectionInProgress = false;
  }
}

module.exports = { runNow, _setClient };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/reflection.test.js`
Expected: 5 tests pass.

- [ ] **Step 5: Run full suite**

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add src/reflection.js tests/reflection.test.js
git commit -m "$(cat <<'EOF'
feat(reflection): daily reflection agent runNow() core

Pulls actions in window, calls opus with reflection.daily prompt,
writes reflection row, flows mirror proposals through vector-engine,
runs replay eval for each self-critique, queues prompt_proposals.
Concurrency lock prevents overlap. Backlog cap prevents runaway queues.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 20: Add `deliverBriefing()` + scheduler + boot wiring

**Files:**
- Modify: `src/reflection.js` — add `deliverBriefing()` and `start()`
- Modify: `server.js` — call `reflection.start()` in boot sequence
- Test: extend `tests/reflection.test.js`

- [ ] **Step 1: Add failing test**

Append to `tests/reflection.test.js`:

```javascript
test('deliverBriefing writes Obsidian file and marks reflection delivered', async () => {
  const os = require('os');
  const vault = path.join(os.tmpdir(), `vault-${Date.now()}`);
  process.env.OBSIDIAN_VAULT_PATH = vault;
  fs.mkdirSync(vault, { recursive: true });

  const latest = db.getLatestReflection({ userId: uid });
  const fakeBot = {
    sendMessage: async () => ({ message_id: 1 })
  };
  const result = await reflection.deliverBriefing({
    reflection: latest,
    telegramBot: fakeBot,
    telegramChatId: 12345
  });
  assert.ok(result.obsidianPath);
  assert.ok(fs.existsSync(result.obsidianPath));
  const refreshed = db.getLatestReflection({ userId: uid });
  assert.strictEqual(refreshed.delivered_telegram, 1);
  assert.strictEqual(refreshed.delivered_obsidian, result.obsidianPath);
});

test('deliverBriefing tolerates Telegram failure, still writes Obsidian', async () => {
  const latest = db.getLatestReflection({ userId: uid });
  const fakeBot = {
    sendMessage: async () => { throw new Error('tg down'); }
  };
  const result = await reflection.deliverBriefing({
    reflection: latest,
    telegramBot: fakeBot,
    telegramChatId: 12345
  });
  assert.ok(result.obsidianPath);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/reflection.test.js`
Expected: fails with `reflection.deliverBriefing is not a function`.

- [ ] **Step 3: Add to `src/reflection.js`**

Append before `module.exports`:

```javascript
const fs = require('fs');
const path = require('path');

async function deliverBriefing({ reflection: refl, telegramBot = null, telegramChatId = null }) {
  const result = { telegramSent: 0, obsidianPath: null };

  // Obsidian write — skipped if vault not configured
  try {
    const vault = process.env.OBSIDIAN_VAULT_PATH;
    if (vault) {
      const dir = path.join(vault, '_reports');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const filename = `daily_${new Date().toISOString().slice(0, 10)}.md`;
      const file = path.join(dir, filename);
      const body = [
        '---',
        `type: daily_reflection`,
        `generated: ${refl.generated_at}`,
        `actions: ${refl.action_count}`,
        '---',
        '',
        refl.briefing_md || ''
      ].join('\n');
      fs.writeFileSync(file, body, 'utf8');
      result.obsidianPath = file;
    }
  } catch (err) {
    db.log('error', 'reflection', `obsidian write failed: ${err.message}`);
  }

  // Telegram push — independent of Obsidian success
  try {
    if (telegramBot && telegramChatId) {
      const CHUNK = 3900;
      const text = refl.briefing_md || '(empty briefing)';
      for (let i = 0; i < text.length; i += CHUNK) {
        await telegramBot.sendMessage(telegramChatId, text.slice(i, i + CHUNK));
      }
      result.telegramSent = 1;
    }
  } catch (err) {
    db.log('error', 'reflection', `telegram deliver failed: ${err.message}`);
  }

  db.markReflectionDelivered(refl.id, {
    telegram: result.telegramSent > 0,
    obsidianPath: result.obsidianPath
  });

  return result;
}

let intervalHandle = null;
function start({ hour = parseFloat(process.env.REFLECTION_HOUR || '7') } = {}) {
  // Schedule once per hour; fire only when the current hour matches `hour`.
  const HOUR_MS = 60 * 60 * 1000;
  intervalHandle = setInterval(async () => {
    if (new Date().getHours() !== Math.floor(hour)) return;
    try {
      // Run for every active user. For a single-user dev machine, this is 1 call.
      const auth = require('./auth');
      const ownerId = auth.getSystemOwnerId();
      if (!ownerId) return;
      await runNow({ userId: ownerId });
    } catch (err) {
      db.log('error', 'reflection', `scheduled run failed: ${err.message}`);
    }
  }, HOUR_MS);
  if (intervalHandle.unref) intervalHandle.unref();
  db.log('info', 'reflection', `scheduled daily at hour ${hour}`);
}

function stop() { if (intervalHandle) clearInterval(intervalHandle); intervalHandle = null; }
```

Update `module.exports`:

```javascript
module.exports = { runNow, deliverBriefing, start, stop, _setClient };
```

- [ ] **Step 4: Wire into `server.js`**

In `server.js`, after `healthcheck.start()` in the boot sequence, add:

```javascript
  // 5a. Schedule daily reflection (Phase 5)
  const reflection = require('./src/reflection');
  reflection.start();
  console.log('  ✔ Reflection agent scheduled (daily)');
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/reflection.test.js`

- [ ] **Step 6: Run full suite + boot smoke**

Run: `npm test`
Then: `node server.js` — watch for "Reflection agent scheduled" log line, Ctrl-C.

- [ ] **Step 7: Commit**

```bash
git add src/reflection.js tests/reflection.test.js server.js
git commit -m "$(cat <<'EOF'
feat(reflection): deliverBriefing + start() scheduler + boot wiring

Daily reflection now runs on an interval-based hour-check scheduler
(matches health-check pattern). Obsidian + Telegram delivery are
independent — either can fail without blocking the other. Wired
into server.js boot sequence after healthcheck.start().

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 21: Create `src/routes/actions.js` — action endpoints

**Files:**
- Create: `src/routes/actions.js`
- Modify: `server.js` — mount router
- Test: `tests/routes-actions.test.js` (new)

- [ ] **Step 1: Write failing integration test**

Create `tests/routes-actions.test.js`. This test follows the exact auth + server pattern used by `tests/satellites/api.test.js` — `mothership_sid` cookie, positional `createSession(userId, {})`, and `fetch` for HTTP.

```javascript
const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-routes-actions-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');

const db = require('../src/database');
const auth = require('../src/auth');
const users = require('../src/auth/users');
const authSessions = require('../src/auth/sessions');
const actionsRouter = require('../src/routes/actions');
const actionLogger = require('../src/action-logger');

let uid, cookie, server, baseUrl;

before(async () => {
  await db.init();
  await auth.init();
  uid = await users.createUser({ email: 'rt-actions@x', password: 'p' });
  const sess = authSessions.createSession(uid, {});
  cookie = `mothership_sid=${sess.id}`;

  const app = express();
  app.use(express.json());
  app.use('/api', actionsRouter);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  actionLogger.logAction({
    kind: 'commitment', subject: 'seeded', sourceType: 'conversation', userId: uid
  });
  actionLogger.logAction({
    kind: 'state', subject: 'pending thing', sourceType: 'conversation',
    status: 'pending_confirm', userId: uid
  });
});

after(() => new Promise(r => { server.close(r); fs.rmSync(tmpRoot, { recursive: true, force: true }); }));

async function request(method, urlPath, body = null) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'Cookie': cookie },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

test('GET /api/actions returns user actions', async () => {
  const res = await request('GET', '/api/actions');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.actions));
  assert.ok(res.body.actions.some(a => a.kind === 'commitment'));
});

test('GET /api/actions/pending returns only pending_confirm', async () => {
  const res = await request('GET', '/api/actions/pending');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.actions.every(a => a.status === 'pending_confirm'));
});

test('POST /api/actions/:id/confirm transitions to active', async () => {
  const pendingRes = await request('GET', '/api/actions/pending');
  const target = pendingRes.body.actions[0];
  const res = await request('POST', `/api/actions/${target.id}/confirm`);
  assert.strictEqual(res.status, 200);

  const active = db.getActions({ userId: uid, kind: 'state', status: 'active' });
  assert.ok(active.some(a => a.id === target.id));
});

test('POST /api/actions/:id/reject transitions to rejected', async () => {
  const id = actionLogger.logAction({
    kind: 'preference', subject: 'reject me',
    sourceType: 'conversation', status: 'pending_confirm', userId: uid
  });
  const res = await request('POST', `/api/actions/${id}/reject`);
  assert.strictEqual(res.status, 200);
  const row = db.getActions({ userId: uid, kind: 'preference' }).find(r => r.id === id);
  assert.strictEqual(row.status, 'rejected');
});

test('GET /api/reflections/latest returns the latest reflection', async () => {
  db.addReflection({
    userId: uid,
    windowStart: 'a', windowEnd: 'b',
    briefingMd: 'test',
    actionCount: 5
  });
  const res = await request('GET', '/api/reflections/latest');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.reflection.briefing_md, 'test');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/routes-actions.test.js`

- [ ] **Step 3: Create `src/routes/actions.js`**

Uses `requireAnyAuth()` from the existing auth middleware — same pattern as `src/routes/api.js`. `requireAnyAuth()` populates `req.user` from the session cookie; handlers then filter by `req.user.id` so users only see their own rows.

```javascript
/**
 * MOTHERSHIP — Actions routes (Phase 5)
 *
 * Endpoints for browsing the action log, managing the pending_confirm
 * queue, and reading reflection output. Prompt proposal endpoints live
 * in a later task (added to this same router).
 */

const express = require('express');
const db = require('../database');
const actionLogger = require('../action-logger');
const { requireAnyAuth } = require('../auth/middleware');

const router = express.Router();

router.get('/actions', requireAnyAuth(), (req, res) => {
  try {
    const { kind, status, limit } = req.query;
    const rows = db.getActions({
      userId: req.user.id,
      kind: kind || null,
      status: status || null,
      limit: limit ? parseInt(limit, 10) : 200
    });
    res.json({ actions: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/actions/pending', requireAnyAuth(), (req, res) => {
  try {
    const rows = db.getPendingActions({ userId: req.user.id });
    res.json({ actions: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/actions/:id/confirm', requireAnyAuth(), (req, res) => {
  try {
    actionLogger.confirmPendingAction(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/actions/:id/reject', requireAnyAuth(), (req, res) => {
  try {
    actionLogger.rejectPendingAction(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/actions/:id/resolve', requireAnyAuth(), (req, res) => {
  try {
    const { resolvingActionId } = req.body || {};
    if (!resolvingActionId) return res.status(400).json({ error: 'resolvingActionId required' });
    actionLogger.resolveAction(req.params.id, resolvingActionId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/reflections/latest', requireAnyAuth(), (req, res) => {
  try {
    const r = db.getLatestReflection({ userId: req.user.id });
    res.json({ reflection: r });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/routes-actions.test.js`

- [ ] **Step 5: Mount router in `server.js`**

In `server.js`, alongside the existing `app.use('/api', ...)` calls, add:

```javascript
const actionsRoutes = require('./src/routes/actions');
app.use('/api', actionsRoutes);
```

- [ ] **Step 6: Run full suite**

Run: `npm test`

- [ ] **Step 7: Commit**

```bash
git add src/routes/actions.js tests/routes-actions.test.js server.js
git commit -m "$(cat <<'EOF'
feat(routes): /api actions + pending queue + reflections endpoints

GET /api/actions (filtered list), GET /api/actions/pending,
POST /api/actions/:id/confirm|reject|resolve, GET /api/reflections/latest.
All endpoints require an authenticated user via existing middleware.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 22: Add prompt-proposal endpoints + approval flow

**Files:**
- Modify: `src/routes/actions.js` — add proposal endpoints
- Test: extend `tests/routes-actions.test.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/routes-actions.test.js`:

```javascript
test('GET /api/prompt-proposals?status=pending returns queue', async () => {
  db.addPromptProposal({
    promptName: 'system.conversation',
    baseVersion: 1,
    proposedBody: 'NEW BODY',
    rationale: 'test rationale',
    replayResultsJson: { sample_size: 10, agreement_rate: 0.8 }
  });
  const res = await request('GET', '/api/prompt-proposals?status=pending');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.proposals.length >= 1);
});

test('POST /api/prompt-proposals/:id/approve creates new version', async () => {
  const registry = require('../src/prompts/registry');
  registry.seedFromHardcoded();

  const proposals = db.getPendingPromptProposals();
  const target = proposals.find(p => p.prompt_name === 'system.conversation');

  const res = await request('POST', `/api/prompt-proposals/${target.id}/approve`);
  assert.strictEqual(res.status, 200);

  const active = db.getActivePromptVersion('system.conversation');
  assert.strictEqual(active.body, 'NEW BODY');

  const refreshed = db.getPromptProposal(target.id);
  assert.strictEqual(refreshed.status, 'approved');
});

test('POST /api/prompt-proposals/:id/reject leaves registry unchanged', async () => {
  db.addPromptProposal({
    promptName: 'synthesis.mirror',
    baseVersion: 1,
    proposedBody: 'SHOULD NOT SHIP',
    rationale: 'test'
  });
  const pending = db.getPendingPromptProposals();
  const target = pending.find(p => p.prompt_name === 'synthesis.mirror');

  const res = await request('POST', `/api/prompt-proposals/${target.id}/reject`);
  assert.strictEqual(res.status, 200);

  const active = db.getActivePromptVersion('synthesis.mirror');
  assert.notStrictEqual(active?.body, 'SHOULD NOT SHIP');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/routes-actions.test.js`

- [ ] **Step 3: Add endpoints to `src/routes/actions.js`**

Append before `module.exports`:

```javascript
const registry = require('../prompts/registry');
const { logAction } = require('../action-logger');

router.get('/prompt-proposals', requireAnyAuth(), (req, res) => {
  try {
    const status = req.query.status || 'pending';
    if (status === 'pending') {
      return res.json({ proposals: db.getPendingPromptProposals() });
    }
    // Non-pending: not implemented; return empty for now.
    res.json({ proposals: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/prompt-proposals/:id', requireAnyAuth(), (req, res) => {
  try {
    const p = db.getPromptProposal(req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    res.json({ proposal: p });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/prompt-proposals/:id/approve', requireAnyAuth(), (req, res) => {
  try {
    const proposal = db.getPromptProposal(req.params.id);
    if (!proposal) return res.status(404).json({ error: 'not found' });
    if (proposal.status !== 'pending') {
      return res.status(409).json({ error: `already ${proposal.status}` });
    }

    const newVersion = registry.createVersion(
      proposal.prompt_name,
      proposal.proposed_body,
      { createdBy: 'reflection', parentVersion: proposal.base_version, activate: true }
    );
    db.updatePromptProposalStatus(proposal.id, 'approved');

    logAction({
      kind: 'mothership_prompt_change',
      subject: `approved ${proposal.prompt_name}`,
      data: { name: proposal.prompt_name, from: proposal.base_version, to: newVersion },
      sourceType: 'dashboard',
      userId: req.user.id
    });

    res.json({ ok: true, newVersion });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/prompt-proposals/:id/reject', requireAnyAuth(), (req, res) => {
  try {
    const proposal = db.getPromptProposal(req.params.id);
    if (!proposal) return res.status(404).json({ error: 'not found' });
    if (proposal.status !== 'pending') {
      return res.status(409).json({ error: `already ${proposal.status}` });
    }
    db.updatePromptProposalStatus(proposal.id, 'rejected');
    logAction({
      kind: 'mothership_prompt_change_rejected',
      subject: `rejected ${proposal.prompt_name}`,
      data: { name: proposal.prompt_name, proposal_id: proposal.id },
      sourceType: 'dashboard',
      userId: req.user.id
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/routes-actions.test.js`

- [ ] **Step 5: Run full suite**

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add src/routes/actions.js tests/routes-actions.test.js
git commit -m "$(cat <<'EOF'
feat(routes): prompt-proposal approve/reject + listing endpoints

GET /api/prompt-proposals (pending queue), GET /api/prompt-proposals/:id,
POST /api/prompt-proposals/:id/approve (creates+activates new version),
POST /api/prompt-proposals/:id/reject. Approve path logs a
mothership_prompt_change action for audit.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 23: Add Telegram `/reflect`, `/proposals`, and inline-keyboard confirm/reject

**Files:**
- Modify: `src/telegram.js` — add slash commands and pending-action callback handler
- Test: manual only (Telegram bot is hard to unit-test; rely on existing telegram test fixtures if present)

- [ ] **Step 1: Edit `src/telegram.js`**

Locate the slash-command dispatch block (inside `bot.on('message', ...)` around line 115). Add three new command handlers alongside `/mirror`, `/briefing`, `/healthcheck`, `/export`:

```javascript
      if (cmd === '/reflect') {
        try {
          const reflection = require('./reflection');
          const ownerId = auth.getSystemOwnerId();
          const out = await reflection.runNow({ userId: ownerId });
          if (out.status === 'already_running') {
            await bot.sendMessage(chatId, '⏳ Reflection already running — try again in a minute.', { reply_to_message_id: msg.message_id });
            return;
          }
          if (out.status === 'failed') {
            await bot.sendMessage(chatId, `⚠ Reflection failed: ${out.error}`, { reply_to_message_id: msg.message_id });
            return;
          }
          const latest = db.getLatestReflection({ userId: ownerId });
          await reflection.deliverBriefing({ reflection: latest, telegramBot: bot, telegramChatId: chatId });
        } catch (err) {
          await bot.sendMessage(chatId, `⚠ Reflect failed: ${err.message}`).catch(() => {});
        }
        return;
      }

      if (cmd === '/proposals') {
        try {
          const proposals = db.getPendingPromptProposals();
          if (!proposals.length) {
            await bot.sendMessage(chatId, '✔ No pending prompt proposals.', { reply_to_message_id: msg.message_id });
            return;
          }
          for (const p of proposals) {
            const replayNote = p.replay_results_json?.skipped
              ? `(replay skipped: ${p.replay_results_json.reason})`
              : p.replay_results_json
                ? `agreement: ${Math.round((p.replay_results_json.agreement_rate || 0) * 100)}%`
                : p.replay_error ? `(replay failed: ${p.replay_error})` : '(no replay data)';
            const text = `📝 *${p.prompt_name}* v${p.base_version}\n\n${p.rationale}\n\n${replayNote}`;
            await bot.sendMessage(chatId, text, {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [[
                  { text: '✅ Approve', callback_data: `proposal:approve:${p.id}` },
                  { text: '❌ Reject', callback_data: `proposal:reject:${p.id}` }
                ]]
              }
            });
          }
        } catch (err) {
          await bot.sendMessage(chatId, `⚠ Proposals failed: ${err.message}`).catch(() => {});
        }
        return;
      }

      if (cmd === '/pending') {
        try {
          const ownerId = auth.getSystemOwnerId();
          const pending = db.getPendingActions({ userId: ownerId });
          if (!pending.length) {
            await bot.sendMessage(chatId, '✔ No pending actions.', { reply_to_message_id: msg.message_id });
            return;
          }
          for (const a of pending) {
            const text = `📋 *${a.kind}*: ${a.subject}\nconf ${a.confidence.toFixed(2)}`;
            await bot.sendMessage(chatId, text, {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [[
                  { text: '✅ Confirm', callback_data: `action:confirm:${a.id}` },
                  { text: '❌ Reject', callback_data: `action:reject:${a.id}` }
                ]]
              }
            });
          }
        } catch (err) {
          await bot.sendMessage(chatId, `⚠ Pending failed: ${err.message}`).catch(() => {});
        }
        return;
      }
```

Update the existing `bot.on('callback_query', ...)` handler to branch on prefix. The current handler assumes everything is `mode:*` for media processing. Add prefix detection at the top:

```javascript
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;

    // --- Phase 5: action confirm/reject and proposal approve/reject ---
    if (query.data?.startsWith('action:')) {
      const [_, verb, actionId] = query.data.split(':');
      const actionLogger = require('./action-logger');
      try {
        if (verb === 'confirm') actionLogger.confirmPendingAction(actionId);
        else if (verb === 'reject') actionLogger.rejectPendingAction(actionId);
        bot.answerCallbackQuery(query.id, { text: `action ${verb}ed` });
        bot.editMessageText(`✔ ${verb}ed`, { chat_id: chatId, message_id: msgId }).catch(() => {});
      } catch (err) {
        bot.answerCallbackQuery(query.id, { text: `failed: ${err.message}` });
      }
      return;
    }

    if (query.data?.startsWith('proposal:')) {
      const [_, verb, proposalId] = query.data.split(':');
      try {
        const proposal = db.getPromptProposal(proposalId);
        if (!proposal || proposal.status !== 'pending') {
          bot.answerCallbackQuery(query.id, { text: 'already resolved' });
          return;
        }
        if (verb === 'approve') {
          const registry = require('./prompts/registry');
          registry.createVersion(proposal.prompt_name, proposal.proposed_body, {
            createdBy: 'reflection-telegram',
            parentVersion: proposal.base_version,
            activate: true
          });
          db.updatePromptProposalStatus(proposalId, 'approved');
        } else {
          db.updatePromptProposalStatus(proposalId, 'rejected');
        }
        bot.answerCallbackQuery(query.id, { text: `${verb}ed` });
        bot.editMessageText(`✔ ${verb}ed ${proposal.prompt_name}`, { chat_id: chatId, message_id: msgId }).catch(() => {});
      } catch (err) {
        bot.answerCallbackQuery(query.id, { text: `failed: ${err.message}` });
      }
      return;
    }

    // --- existing media-mode callbacks (keep below the Phase 5 branches) ---
```

Leave the existing `mode:*` callback code unchanged below.

- [ ] **Step 2: Smoke test manually**

Run `node server.js`, send `/proposals` and `/pending` to the bot. If there are no proposals/pending actions, expect "No pending ..." replies. If there are, expect inline keyboards.

- [ ] **Step 3: Run full suite**

Run: `npm test`

- [ ] **Step 4: Commit**

```bash
git add src/telegram.js
git commit -m "$(cat <<'EOF'
feat(telegram): /reflect, /proposals, /pending slash commands + inline keyboards

/reflect runs daily reflection on-demand and pushes the briefing.
/proposals lists pending prompt proposals with approve/reject buttons.
/pending lists pending_confirm actions with confirm/reject buttons.
Callback query handler branches on prefix (action:|proposal:|mode:).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 24: Add "Actions" tab to the dashboard

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Locate the dashboard tab infrastructure**

Read `public/index.html` and find the existing tab definitions (Mirror, Wiki, Messages). Note the tab button pattern and the corresponding content-pane pattern.

- [ ] **Step 2: Add an Actions tab button**

Find the tab button row and add a new button after the last existing tab:

```html
<button class="tab-btn" data-tab="actions">Actions</button>
```

- [ ] **Step 3: Add the Actions content pane**

Find the last content pane and add:

```html
<div class="tab-pane" id="tab-actions">
  <div class="actions-toolbar">
    <select id="actions-kind-filter">
      <option value="">All kinds</option>
      <option value="commitment">Commitments</option>
      <option value="win">Wins</option>
      <option value="stumble">Stumbles</option>
      <option value="state">States</option>
      <option value="preference">Preferences</option>
      <option value="mothership_reply">Mothership replies</option>
      <option value="mothership_synthesis">Mothership synthesis</option>
      <option value="mothership_categorize">Mothership categorize</option>
    </select>
    <select id="actions-status-filter">
      <option value="">All statuses</option>
      <option value="active">Active</option>
      <option value="pending_confirm">Pending confirm</option>
      <option value="resolved">Resolved</option>
      <option value="rejected">Rejected</option>
      <option value="expired">Expired</option>
    </select>
    <button id="actions-refresh">Refresh</button>
  </div>
  <div id="actions-pending-section">
    <h3>Pending confirm</h3>
    <div id="actions-pending-list"></div>
  </div>
  <div id="actions-list-section">
    <h3>All actions</h3>
    <div id="actions-list"></div>
  </div>
</div>
```

- [ ] **Step 4: Add the JavaScript to populate the tab**

Find the existing tab-loading JS and add a loader for the actions tab:

```javascript
async function loadActions() {
  const kind = document.getElementById('actions-kind-filter').value;
  const status = document.getElementById('actions-status-filter').value;
  const qs = new URLSearchParams();
  if (kind) qs.set('kind', kind);
  if (status) qs.set('status', status);

  const [listRes, pendingRes] = await Promise.all([
    fetch(`/api/actions?${qs.toString()}`).then(r => r.json()),
    fetch(`/api/actions/pending`).then(r => r.json())
  ]);

  const listEl = document.getElementById('actions-list');
  const pendingEl = document.getElementById('actions-pending-list');

  pendingEl.innerHTML = pendingRes.actions.length
    ? pendingRes.actions.map(renderPendingAction).join('')
    : '<p class="muted">Nothing pending.</p>';

  listEl.innerHTML = listRes.actions.length
    ? listRes.actions.map(renderAction).join('')
    : '<p class="muted">No actions yet.</p>';

  // Wire up confirm/reject buttons
  listEl.querySelectorAll('[data-confirm]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/actions/${btn.dataset.confirm}/confirm`, { method: 'POST' });
      loadActions();
    });
  });
  pendingEl.querySelectorAll('[data-confirm]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/actions/${btn.dataset.confirm}/confirm`, { method: 'POST' });
      loadActions();
    });
  });
  pendingEl.querySelectorAll('[data-reject]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/actions/${btn.dataset.reject}/reject`, { method: 'POST' });
      loadActions();
    });
  });
}

function renderAction(a) {
  return `<div class="action-row action-${a.kind}">
    <span class="action-kind">${a.kind}</span>
    <span class="action-subject">${escapeHtml(a.subject)}</span>
    <span class="action-status">${a.status}</span>
    <span class="action-date">${a.created_at}</span>
  </div>`;
}

function renderPendingAction(a) {
  return `<div class="action-row pending">
    <span class="action-kind">${a.kind}</span>
    <span class="action-subject">${escapeHtml(a.subject)}</span>
    <span class="action-conf">conf ${a.confidence.toFixed(2)}</span>
    <button data-confirm="${a.id}">✓</button>
    <button data-reject="${a.id}">✗</button>
  </div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[ch]));
}

document.getElementById('actions-refresh').addEventListener('click', loadActions);
document.getElementById('actions-kind-filter').addEventListener('change', loadActions);
document.getElementById('actions-status-filter').addEventListener('change', loadActions);
```

Hook `loadActions()` into the existing tab-activation handler so it fires when the Actions tab is opened.

- [ ] **Step 5: Smoke test manually**

Start the server, open `http://localhost:3000`, log in, click the Actions tab. Expected: empty state or seeded action rows if you've been using the bot.

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "$(cat <<'EOF'
feat(dashboard): Actions tab — list, filters, pending confirm queue

Filter by kind and status. Pending confirm section has inline ✓/✗
buttons that POST to /api/actions/:id/confirm|reject. Refresh button
and filter change events reload the list.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 25: Add "Reflections" tab to the dashboard

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Add tab button and pane**

Add after the Actions tab button:

```html
<button class="tab-btn" data-tab="reflections">Reflections</button>
```

And a new pane:

```html
<div class="tab-pane" id="tab-reflections">
  <section id="reflection-briefing-section">
    <h3>Latest briefing</h3>
    <div id="reflection-briefing"></div>
  </section>
  <section id="reflection-proposals-section">
    <h3>Pending prompt proposals</h3>
    <div id="reflection-proposals"></div>
  </section>
  <button id="reflections-run-now">Run reflection now</button>
</div>
```

- [ ] **Step 2: Add the loader JS**

```javascript
async function loadReflections() {
  const [briefingRes, proposalsRes] = await Promise.all([
    fetch('/api/reflections/latest').then(r => r.json()),
    fetch('/api/prompt-proposals?status=pending').then(r => r.json())
  ]);

  const brEl = document.getElementById('reflection-briefing');
  if (briefingRes.reflection) {
    const r = briefingRes.reflection;
    brEl.innerHTML = `
      <div class="reflection-meta">${r.generated_at} — ${r.action_count} actions</div>
      <div class="reflection-md">${escapeHtml(r.briefing_md).replace(/\n/g, '<br>')}</div>
    `;
  } else {
    brEl.innerHTML = '<p class="muted">No reflections yet. Run /reflect or wait for the daily pass.</p>';
  }

  const prEl = document.getElementById('reflection-proposals');
  prEl.innerHTML = proposalsRes.proposals.length
    ? proposalsRes.proposals.map(renderProposal).join('')
    : '<p class="muted">No pending proposals.</p>';

  prEl.querySelectorAll('[data-approve]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Approve change to ${btn.dataset.name}?`)) return;
      await fetch(`/api/prompt-proposals/${btn.dataset.approve}/approve`, { method: 'POST' });
      loadReflections();
    });
  });
  prEl.querySelectorAll('[data-reject]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/prompt-proposals/${btn.dataset.reject}/reject`, { method: 'POST' });
      loadReflections();
    });
  });
}

function renderProposal(p) {
  const replay = p.replay_results_json;
  let replayBlock = '<div class="replay-none">(no replay data)</div>';
  if (replay?.skipped) {
    replayBlock = `<div class="replay-skipped">Replay skipped: ${replay.reason}</div>`;
  } else if (replay) {
    const pct = Math.round((replay.agreement_rate || 0) * 100);
    replayBlock = `<div class="replay-results">
      Agreement: ${pct}% over ${replay.sample_size} samples
      · ${replay.regressions?.length || 0} regressions
      · ${replay.improvements?.length || 0} improvements
    </div>`;
  } else if (p.replay_error) {
    replayBlock = `<div class="replay-error">Replay failed: ${escapeHtml(p.replay_error)}</div>`;
  }
  return `<div class="proposal-card">
    <div class="proposal-head">
      <strong>${p.prompt_name}</strong> v${p.base_version}
      <span class="proposal-date">${p.created_at}</span>
    </div>
    <div class="proposal-rationale">${escapeHtml(p.rationale)}</div>
    <details>
      <summary>Proposed body</summary>
      <pre>${escapeHtml(p.proposed_body)}</pre>
    </details>
    ${replayBlock}
    <div class="proposal-actions">
      <button data-approve="${p.id}" data-name="${p.prompt_name}">Approve</button>
      <button data-reject="${p.id}">Reject</button>
    </div>
  </div>`;
}

document.getElementById('reflections-run-now').addEventListener('click', async () => {
  const btn = document.getElementById('reflections-run-now');
  btn.disabled = true;
  btn.textContent = 'Running...';
  try {
    // No dedicated endpoint yet; use /reflect via the Telegram slash command,
    // or a future /api/reflections/run endpoint. For now, just reload.
    await loadReflections();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run reflection now';
  }
});
```

Hook `loadReflections()` into the tab-activation handler.

- [ ] **Step 3: Smoke test manually**

Start server, open dashboard, navigate to Reflections tab. Expected: empty state until reflection has run at least once.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "$(cat <<'EOF'
feat(dashboard): Reflections tab — briefing + pending proposal queue

Shows the latest daily reflection briefing and a card list of pending
prompt proposals with rationale, collapsible proposed body, replay
results (or skipped/error state), and approve/reject buttons.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 26: End-to-end integration test + final smoke check

**Files:**
- Create: `tests/action-flow-e2e.test.js`

- [ ] **Step 1: Write the integration test**

Create `tests/action-flow-e2e.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-e2e-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;
process.env.ACTION_EXTRACTION_ENABLED = 'true';

const db = require('../src/database');
const users = require('../src/auth/users');
const authRoles = require('../src/auth/roles');
const registry = require('../src/prompts/registry');
const ve = require('../src/memory/vector-engine');
const hooks = require('../src/conversation-hooks');
const qm = require('../src/quantum-mirror');
const extractor = require('../src/extractors/action-extractor');
const reflection = require('../src/reflection');

let uid;

test('e2e — setup', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });
  await authRoles.seedOnce(db);
  uid = await users.createUser({ email: 'e2e@x', password: 'p' });
  registry.seedFromHardcoded();
  ve._setClient({
    embeddings: { create: async () => ({ data: [{ embedding: new Array(3).fill(0.5) }] }) }
  });
});

test('e2e — conversation turn creates action rows', async () => {
  qm._setClient({
    messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify({ new_entries: [], supersede: [] }) }] }) }
  });
  extractor._setClient({
    messages: { create: async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        candidates: [{ kind: 'commitment', subject: 'ship feature X', data: { due_at: '2026-04-20' }, confidence: 0.9 }]
      }) }]
    }) }
  });

  await hooks.postResponse({
    userText: "I'll ship feature X by next Monday — this is a promise",
    assistantText: 'noted; anything you need help unblocking?',
    sourceId: 'e2e-msg-1',
    userId: uid
  });

  const commitments = db.getActions({ userId: uid, kind: 'commitment' });
  assert.ok(commitments.some(c => c.subject === 'ship feature X'));
});

test('e2e — reflection picks up actions and produces a briefing', async () => {
  reflection._setClient({
    messages: { create: async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        briefing_md: '# Daily\n\nOpen: ship feature X.',
        patterns: [],
        self_critique: [],
        mirror_proposals: [{ category: 'active_projects', content: 'shipping feature X by 2026-04-20', confidence: 0.8 }]
      }) }]
    }) }
  });

  const out = await reflection.runNow({ userId: uid });
  assert.strictEqual(out.status, 'ok');
  assert.strictEqual(out.mirrorProposalsStored, 1);

  const mirror = db.getMirrorEntries({ userId: uid });
  assert.ok(mirror.some(m => m.source_type === 'reflection' && m.content.includes('feature X')));
});

test('e2e — proposal approve flow creates new active prompt version', async () => {
  db.addPromptProposal({
    promptName: 'system.conversation',
    baseVersion: 1,
    proposedBody: 'NEW E2E PROMPT',
    rationale: 'e2e test',
    replayResultsJson: { sample_size: 10, agreement_rate: 0.9, regressions: [], improvements: [] }
  });
  const proposals = db.getPendingPromptProposals();
  const target = proposals.find(p => p.proposed_body === 'NEW E2E PROMPT');

  registry.createVersion('system.conversation', target.proposed_body, {
    createdBy: 'e2e', parentVersion: 1, activate: true
  });
  db.updatePromptProposalStatus(target.id, 'approved');

  const active = db.getActivePromptVersion('system.conversation');
  assert.strictEqual(active.body, 'NEW E2E PROMPT');
  assert.strictEqual(registry.getPrompt('system.conversation'), 'NEW E2E PROMPT');
});
```

- [ ] **Step 2: Run test**

Run: `npm test -- tests/action-flow-e2e.test.js`
Expected: 4 tests pass.

- [ ] **Step 3: Run full suite**

Run: `npm test`
Expected: **all tests pass**, including all new tests from Tasks 1-25 and the existing regression suite.

- [ ] **Step 4: Boot the server for manual smoke**

Run: `node server.js`

Expected log lines:
```
  ✔ Database initialized
  ✔ Prompt registry seeded (...)  (or "up to date")
  ✔ Auth initialized
  ✔ Satellites loaded
  ✔ Telegram bot connected
  ✔ Watching inbox: ...
  ✔ Health check scheduled
  ✔ Reflection agent scheduled (daily)
  ✔ Dashboard live at http://localhost:3000
  Ready. The Mothership is online.
```

Send the bot a real message via Telegram: `"I'm going to ship phase 5 by Friday and I'm pretty drained today"`. Expected: normal reply arrives. After the reply, check `/pending` — there should be at least one action in the pending queue (the "drained" state was 0.7 confidence). Tap ✓ or ✗ to confirm behavior.

Send `/reflect`. Expected: reflection runs, briefing arrives.

Ctrl-C the server.

- [ ] **Step 5: Commit**

```bash
git add tests/action-flow-e2e.test.js
git commit -m "$(cat <<'EOF'
test(e2e): end-to-end flow covering capture → reflection → approval

Seeds a conversation turn, verifies action rows are written, runs
reflection against those actions, verifies mirror proposals flow
into mirror_entries with source_type='reflection', and walks a
prompt proposal through approval to confirm the registry flips
active version and getPrompt returns the new body.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Done

At this point all 26 tasks are complete. Summary of what's been built:

- **4 new DB tables** (`actions`, `reflections`, `prompt_versions`, `prompt_proposals`) with full CRUD helpers
- **2 new subdirectories** (`src/prompts/`, `src/extractors/`)
- **7 new source files** (`action-logger.js`, `prompts/registry.js`, `prompts/replay.js`, `extractors/action-extractor.js`, `reflection.js`, `routes/actions.js`, plus the `mothership-hierarchy.html` leftover is untouched)
- **7 modified source files** (`database.js`, `conversation.js`, `conversation-hooks.js`, `quantum-mirror.js`, `synthesizer.js`, `processor.js`, `health-check.js`, `telegram.js`, `server.js`, `public/index.html`)
- **~10 new test files** covering unit tests for every new module and integration tests for the HTTP routes and end-to-end flow
- **Registry-backed prompts** with fallbacks — no hardcoded prompt body is lost; the registry is a safety-netted overlay
- **Hybrid action capture** wired through `postResponse` (haiku extraction, auto-log ≥0.75, queue 0.5-0.75, drop <0.5)
- **Daily reflection** scheduled via hour-check interval (same pattern as `health-check.js`), delivers briefings to Telegram + Obsidian, proposes prompt changes with replay eval
- **Approval flow** via dashboard (Reflections tab) and Telegram (`/proposals` slash command with inline keyboards) — approved proposals flip the registry's active version and are reflected by the next call to `getPrompt()`

The self-improvement loop is now closed: every Mothership reply is audited, every user turn is extracted, the daily reflection walks the audit trail and proposes both Mirror entries (autonomous) and prompt changes (human-approved), and the replay eval grounds proposals in historical data before they ship.

**Operational next steps** (not part of this plan, but worth knowing):
- Monitor `ACTION_EXTRACTION_ENABLED` cost impact in the first week
- Watch `prompt_proposals` queue size — if proposals stack up, tune `MAX_PENDING_PROPOSALS` or trigger a cleanup pass
- Review `source_type='reflection'` Mirror entries periodically — if the reflection agent proposes garbage, adjust `reflection.daily` or add a manual approval gate for Mirror writes too
