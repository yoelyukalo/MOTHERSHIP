# Satellite Model & Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase 6 sub-project #1 — the satellite registry, kind loader, sovereignty wrapper, directive inbox, and draft-capture layer — with zero UI, zero auth, and zero bot routing, per `docs/superpowers/specs/2026-04-13-satellite-model-and-registry-design.md`.

**Architecture:** Two new tables in Mothership core (`satellites`, `satellite_drafts`), a new `src/satellites/` module (`registry.js`, `loader.js`, `directives.js`, `drafts.js`, `sovereignty.js`, `kinds.js`, `index.js`), a reserved `src/satellite-kinds/` directory (README only), per-instance folders under `data/satellites/<slug>/` with their own sql.js DB + directives inbox, and ~14 new REST endpoints mounted on the existing `/api` router. The trust boundary is enforced by a closure in `loader.js` that never exposes a raw writable DB handle to anything except the directive consumer.

**Tech Stack:** Node.js (existing), Express.js, sql.js (WASM SQLite), chokidar (already a dep), uuid (already a dep), `node --test` runner. No new dependencies.

---

## Prerequisites

The branch has three uncommitted files from the previous session:
- `src/routes/api.js` — adds `POST /api/chat` endpoint for dashboard → conversation.respond plumbing
- `src/conversation.js` — history builder now pulls dashboard rows alongside telegram rows
- `public/index.html` — ~1700 lines of UI edits, unrelated to satellites

The first two are **prerequisites** for the drafts feature in §9.2(a) of the spec (they let a chat turn be linked to a draft via `metadata.draft_slug`). Task 1 commits only those two. `public/index.html` is left alone — it's unrelated work that belongs in a separate commit decided by the user later.

---

## File Structure

**New module (`src/satellites/`):**
- `index.js` — public surface imported by `server.js` and `routes/api.js`; exports `init`, `registry`, `loader`, `directives`, `drafts`
- `registry.js` — CRUD on the `satellites` table, slug validation, per-satellite folder + DB bootstrap, lifecycle (archive/unarchive/transfer/visibility)
- `kinds.js` — kind module resolver, schema.sql auto-attach, shallow merge with `custom.js`
- `sovereignty.js` — DB handle wrapper enforcing no-write + visibility-gated reads, defines `SovereigntyViolation` and `VisibilityViolation` error classes
- `loader.js` — boot-time loader, in-memory satellite map, `register(slug)`, `unregister(slug)`, `get(slug)`; holds raw writable handles in a private closure
- `directives.js` — directive JSON file I/O (issue), chokidar consumer loop, startup sweep, history recording
- `drafts.js` — `satellite_drafts` CRUD, `getDraftWithMessages`, `regenerateBrief`

**New reserved directory:**
- `src/satellite-kinds/README.md` — authoring guide for kind modules (empty of real kinds in #1)

**New test fixtures:**
- `tests/fixtures/satellite-kinds/test-kind/index.js` — minimal kind module used by every integration test
- `tests/fixtures/satellite-kinds/test-kind/schema.sql` — one trivial domain table to prove the kind schema loader works

**New test files:**
- `tests/satellites/registry.test.js`
- `tests/satellites/kinds.test.js`
- `tests/satellites/sovereignty.test.js`
- `tests/satellites/loader.test.js`
- `tests/satellites/directives.test.js`
- `tests/satellites/drafts.test.js`
- `tests/satellites/lifecycle.test.js`
- `tests/satellites/api.test.js`
- `tests/satellites/e2e.test.js`

**Modified:**
- `src/database.js` — add `satellites` and `satellite_drafts` CREATE TABLE statements inside `init()`
- `src/routes/api.js` — mount the 14 new endpoints, extend existing `/api/chat` to accept `draft_slug`
- `src/conversation-hooks.js` — accept optional `draftSlug` in `postResponse`, pass `forceCategory` through to synthesis
- `src/quantum-mirror.js` — honor optional `forceCategory` option on `synthesizeFromTurn`
- `server.js` — call `satellites.init()` after `db.init()` during boot
- `.gitignore` — add `data/satellites/*` with `!data/satellites/.gitkeep` and `!data/satellites/README.md` (note: `data/` is already gitignored wholesale, so we only need to make sure the new README is tracked via a targeted `!`-exclusion OR just track those files explicitly via `git add -f`)

**New data stubs:**
- `data/satellites/.gitkeep`
- `data/satellites/README.md` — one paragraph explaining per-instance folders are gitignored

---

## Testing conventions used throughout this plan

Every test file starts with this preamble so tests run in isolation with their own temp DB and temp satellites dir:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-sat-'));
const tmpDb = path.join(tmpRoot, 'mothership.db');
const tmpSatDir = path.join(tmpRoot, 'satellites');
fs.mkdirSync(tmpSatDir, { recursive: true });

process.env.MOTHERSHIP_DB_PATH = tmpDb;
process.env.MOTHERSHIP_SATELLITES_DIR = tmpSatDir;
process.env.MOTHERSHIP_KINDS_DIR = path.join(__dirname, '..', 'fixtures', 'satellite-kinds');

const db = require('../../src/database');
```

Tests use `t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }))` for cleanup.

Running a single test file:
```
npm test -- tests/satellites/registry.test.js
```

Running all tests:
```
npm test
```

---

## Task 1: Commit prerequisite dashboard-chat work

**Files:**
- Commit: `src/routes/api.js`, `src/conversation.js` (already modified)
- Untouched: `public/index.html` (unrelated UI work, left for later)

- [ ] **Step 1: Verify the two files are the intended prerequisite work**

Run: `git diff --stat src/routes/api.js src/conversation.js`
Expected: `api.js` adds ~38 lines (the `/api/chat` handler), `conversation.js` shows the ~5-line history-builder change.

- [ ] **Step 2: Stage only the prerequisite files**

Run:
```bash
git add src/routes/api.js src/conversation.js
```

- [ ] **Step 3: Verify public/index.html is NOT staged**

Run: `git status --short`
Expected: `M  src/conversation.js`, `M  src/routes/api.js`, and ` M public/index.html` (unstaged).

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(api): dashboard → conversation chat endpoint

Adds POST /api/chat mirroring the Telegram text path: stores the user
turn, calls conversation.respond(), stores the mothership reply, fires
postResponse hook for mirror synthesis. History builder now pulls
dashboard rows alongside telegram rows. Prerequisite for the draft
linking in the satellite spec §9.2.
EOF
)"
```

---

## Task 2: Add `satellites` and `satellite_drafts` tables to Mothership core DB

**Files:**
- Modify: `src/database.js` (inside `init()`, after the existing `wiki_entries` block)
- Test: `tests/satellites/schema.test.js` (new)

- [ ] **Step 1: Write the failing schema test**

Create `tests/satellites/schema.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-sat-'));
const tmpDb = path.join(tmpRoot, 'mothership.db');
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../../src/database');

test('database — satellites and satellite_drafts tables exist after init', async (t) => {
  await db.init();
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const raw = db._raw();
  const tables = raw.exec(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  )[0].values.map(r => r[0]);

  assert.ok(tables.includes('satellites'), 'satellites table missing');
  assert.ok(tables.includes('satellite_drafts'), 'satellite_drafts table missing');
});

test('database — satellites has the expected columns', async () => {
  const raw = db._raw();
  const cols = raw.exec("PRAGMA table_info(satellites)")[0].values.map(r => r[1]);
  for (const col of ['id', 'slug', 'name', 'kind', 'db_path', 'owner', 'visibility', 'status', 'config_json', 'created_at', 'transferred_at', 'notes']) {
    assert.ok(cols.includes(col), `satellites missing column ${col}`);
  }
});

test('database — satellite_drafts has the expected columns', async () => {
  const raw = db._raw();
  const cols = raw.exec("PRAGMA table_info(satellite_drafts)")[0].values.map(r => r[1]);
  for (const col of ['id', 'slug', 'name', 'kind', 'status', 'brief_md', 'brief_updated_at', 'created_satellite_id', 'created_at', 'updated_at']) {
    assert.ok(cols.includes(col), `satellite_drafts missing column ${col}`);
  }
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `npm test -- tests/satellites/schema.test.js`
Expected: FAIL with "satellites table missing".

- [ ] **Step 3: Add the CREATE TABLE statements to `src/database.js`**

Inside `init()`, immediately before the `save()` call on line 92, insert:

```javascript
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
```

Note: we use `TEXT DEFAULT (datetime('now'))` to match the existing rows-as-text pattern used elsewhere in this file (see `messages`, `logs`). We do not set `FOREIGN KEY` constraints because sql.js does not enforce them without `PRAGMA foreign_keys = ON`, and the existing schema does not enable that PRAGMA — adding it here unilaterally would change behavior for unrelated tables.

- [ ] **Step 4: Run the test, see it pass**

Run: `npm test -- tests/satellites/schema.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/database.js tests/satellites/schema.test.js
git commit -m "feat(db): add satellites and satellite_drafts tables for Phase 6 #1"
```

---

## Task 3: Slug validation and registry row CRUD

**Files:**
- Create: `src/satellites/registry.js`
- Test: `tests/satellites/registry.test.js`

- [ ] **Step 1: Write the failing test for slug validation**

Create `tests/satellites/registry.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-sat-reg-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');
process.env.MOTHERSHIP_SATELLITES_DIR = path.join(tmpRoot, 'satellites');
fs.mkdirSync(process.env.MOTHERSHIP_SATELLITES_DIR, { recursive: true });

const db = require('../../src/database');
const registry = require('../../src/satellites/registry');

test.before(async () => { await db.init(); });
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test('registry — validateSlug accepts valid slugs', () => {
  assert.strictEqual(registry.validateSlug('abc-auto-titles'), true);
  assert.strictEqual(registry.validateSlug('dental1'), true);
  assert.strictEqual(registry.validateSlug('a1b'), true);
});

test('registry — validateSlug rejects invalid slugs', () => {
  assert.strictEqual(registry.validateSlug('ABC'), false);         // uppercase
  assert.strictEqual(registry.validateSlug('-abc'), false);        // leading hyphen
  assert.strictEqual(registry.validateSlug('ab'), false);          // too short (min 3)
  assert.strictEqual(registry.validateSlug('a'.repeat(65)), false); // too long (max 64)
  assert.strictEqual(registry.validateSlug('has_underscore'), false);
  assert.strictEqual(registry.validateSlug('has space'), false);
});

test('registry — insertRow writes a row with defaults', () => {
  const id = registry.insertRow({
    slug: 'test-sat-1', name: 'Test One', kind: 'test-kind', db_path: 'data/satellites/test-sat-1/db.sqlite'
  });
  assert.ok(id);
  const row = registry.getBySlug('test-sat-1');
  assert.strictEqual(row.slug, 'test-sat-1');
  assert.strictEqual(row.owner, 'mothership');
  assert.strictEqual(row.visibility, 'full');
  assert.strictEqual(row.status, 'active');
});

test('registry — insertRow rejects duplicate slug', () => {
  assert.throws(
    () => registry.insertRow({ slug: 'test-sat-1', name: 'dup', kind: 'test-kind' }),
    /slug/
  );
});

test('registry — listRows filters by status and kind', () => {
  registry.insertRow({ slug: 'test-sat-2', name: 'Two', kind: 'test-kind' });
  registry.insertRow({ slug: 'test-sat-3', name: 'Three', kind: 'other-kind' });
  registry.updateStatus('test-sat-2', 'archived');

  const active = registry.listRows({ status: 'active' });
  const archived = registry.listRows({ status: 'archived' });
  const testKind = registry.listRows({ kind: 'test-kind' });

  assert.ok(active.find(r => r.slug === 'test-sat-1'));
  assert.ok(!active.find(r => r.slug === 'test-sat-2'));
  assert.ok(archived.find(r => r.slug === 'test-sat-2'));
  assert.strictEqual(testKind.length, 2);
});
```

- [ ] **Step 2: Run the tests, see them fail**

Run: `npm test -- tests/satellites/registry.test.js`
Expected: FAIL with "Cannot find module '../../src/satellites/registry'".

- [ ] **Step 3: Create `src/satellites/registry.js` — slug validation + row CRUD**

```javascript
/**
 * MOTHERSHIP — Satellite Registry
 *
 * Owns the `satellites` table. Slug validation, row CRUD, lifecycle
 * (archive/unarchive/transfer/visibility). Per-instance folder and DB
 * bootstrap live here too (added in Task 7). Sovereignty enforcement
 * lives in sovereignty.js; this module only writes to the Mothership
 * core DB, never to satellite-owned DBs.
 */

const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;

function validateSlug(slug) {
  if (typeof slug !== 'string') return false;
  return SLUG_RE.test(slug);
}

function satellitesDir() {
  return process.env.MOTHERSHIP_SATELLITES_DIR ||
         path.join(__dirname, '..', '..', 'data', 'satellites');
}

function insertRow({ slug, name, kind, db_path = null, owner = 'mothership', visibility = 'full', status = 'active', config_json = null, notes = null }) {
  if (!validateSlug(slug)) throw new Error(`invalid slug: ${slug}`);
  const existing = getBySlug(slug);
  if (existing) throw new Error(`slug already exists: ${slug}`);

  const id = uuidv4();
  const raw = db._raw();
  raw.run(
    `INSERT INTO satellites (id, slug, name, kind, db_path, owner, visibility, status, config_json, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, slug, name, kind, db_path, owner, visibility, status, config_json, notes]
  );
  db.save();
  return id;
}

function getBySlug(slug) {
  const raw = db._raw();
  const stmt = raw.prepare('SELECT * FROM satellites WHERE slug = ?');
  stmt.bind([slug]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function getById(id) {
  const raw = db._raw();
  const stmt = raw.prepare('SELECT * FROM satellites WHERE id = ?');
  stmt.bind([id]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function listRows({ status, kind, visibility } = {}) {
  let q = 'SELECT * FROM satellites WHERE 1=1';
  const p = [];
  if (status) { q += ' AND status = ?'; p.push(status); }
  if (kind) { q += ' AND kind = ?'; p.push(kind); }
  if (visibility) { q += ' AND visibility = ?'; p.push(visibility); }
  q += ' ORDER BY created_at ASC';

  const raw = db._raw();
  const stmt = raw.prepare(q);
  stmt.bind(p);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function updateStatus(slug, status) {
  const raw = db._raw();
  raw.run('UPDATE satellites SET status = ? WHERE slug = ?', [status, slug]);
  db.save();
}

function updateVisibility(slug, visibility) {
  const raw = db._raw();
  raw.run('UPDATE satellites SET visibility = ? WHERE slug = ?', [visibility, slug]);
  db.save();
}

function updateConfigJson(slug, configJsonString) {
  const raw = db._raw();
  raw.run('UPDATE satellites SET config_json = ? WHERE slug = ?', [configJsonString, slug]);
  db.save();
}

function deleteRow(slug) {
  const raw = db._raw();
  raw.run('DELETE FROM satellites WHERE slug = ?', [slug]);
  db.save();
}

module.exports = {
  validateSlug,
  satellitesDir,
  insertRow,
  getBySlug,
  getById,
  listRows,
  updateStatus,
  updateVisibility,
  updateConfigJson,
  deleteRow
};
```

- [ ] **Step 4: Run the tests, see them pass**

Run: `npm test -- tests/satellites/registry.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/satellites/registry.js tests/satellites/registry.test.js
git commit -m "feat(satellites): registry row CRUD + slug validation"
```

---

## Task 4: Kind module resolver with schema.sql auto-attach and custom.js merge

**Files:**
- Create: `src/satellites/kinds.js`
- Create: `tests/fixtures/satellite-kinds/test-kind/index.js`
- Create: `tests/fixtures/satellite-kinds/test-kind/schema.sql`
- Create: `src/satellite-kinds/README.md`
- Test: `tests/satellites/kinds.test.js`

- [ ] **Step 1: Create the fixture kind module**

Create `tests/fixtures/satellite-kinds/test-kind/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS test_widgets (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
```

Create `tests/fixtures/satellite-kinds/test-kind/index.js`:

```javascript
module.exports = {
  kind: 'test-kind',
  displayName: 'Test Kind',
  version: '0.0.1',
  description: 'Fixture kind used by integration tests only.',
  defaultConfig: {
    greeting: 'hello',
    nested: { a: 1 }
  },
  directiveHandlers: {
    'config.set': async ({ payload, db }) => {
      db.run(
        'INSERT OR REPLACE INTO satellite_meta (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))',
        [payload.key, JSON.stringify(payload.value)]
      );
      return { status: 'applied' };
    }
  },
  onCreate: async () => {},
  onBoot: async () => {},
  onArchive: async () => {},
  handlers: {}
};
```

- [ ] **Step 2: Create `src/satellite-kinds/README.md`**

```markdown
# Satellite kinds

A **kind** is a vertical template shared across satellites of the same type
(`title-service`, `dental`, `dealership`, ...). See
`docs/superpowers/specs/2026-04-13-satellite-model-and-registry-design.md` §6
for the module contract.

No real kinds ship in Phase 6 sub-project #1. This directory exists to
reserve the location and shape. Real kinds arrive with sub-project #7 when
actual satellites are provisioned.
```

- [ ] **Step 3: Write the failing tests for `kinds.js`**

Create `tests/satellites/kinds.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'satellite-kinds');
process.env.MOTHERSHIP_KINDS_DIR = FIXTURES;

const kinds = require('../../src/satellites/kinds');

test('kinds — loadKind returns module with schema attached', () => {
  const k = kinds.loadKind('test-kind');
  assert.strictEqual(k.kind, 'test-kind');
  assert.ok(k.schema.includes('CREATE TABLE IF NOT EXISTS test_widgets'));
  assert.ok(k.directiveHandlers['config.set']);
});

test('kinds — loadKind throws on missing kind', () => {
  assert.throws(() => kinds.loadKind('does-not-exist'), /kind not found/i);
});

test('kinds — mergeCustom overrides top-level keys only', async () => {
  const base = kinds.loadKind('test-kind');
  const custom = {
    defaultConfig: { greeting: 'howdy' },
    directiveHandlers: {
      'config.set': async () => ({ status: 'applied', from: 'custom' })
    }
  };
  const merged = kinds.mergeCustom(base, custom);
  assert.strictEqual(merged.defaultConfig.greeting, 'howdy');
  // directiveHandlers is REPLACED, not merged — so only the custom handler exists.
  const result = await merged.directiveHandlers['config.set']({ payload: {}, db: null });
  assert.strictEqual(result.from, 'custom');
  // Top-level base fields survive the merge
  assert.strictEqual(merged.kind, 'test-kind');
  assert.strictEqual(merged.version, '0.0.1');
});
```

- [ ] **Step 4: Run the tests, see them fail**

Run: `npm test -- tests/satellites/kinds.test.js`
Expected: FAIL with "Cannot find module '../../src/satellites/kinds'".

- [ ] **Step 5: Implement `src/satellites/kinds.js`**

```javascript
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
```

- [ ] **Step 6: Run the tests, see them pass**

Run: `npm test -- tests/satellites/kinds.test.js`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src/satellites/kinds.js src/satellite-kinds/README.md tests/fixtures/satellite-kinds/test-kind/ tests/satellites/kinds.test.js
git commit -m "feat(satellites): kind module resolver + test fixture kind"
```

---

## Task 5: Sovereignty wrapper — block writes, gate reads by visibility

**Files:**
- Create: `src/satellites/sovereignty.js`
- Test: `tests/satellites/sovereignty.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/satellites/sovereignty.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const initSqlJs = require('sql.js');

const sovereignty = require('../../src/satellites/sovereignty');

let SQL;
test.before(async () => { SQL = await initSqlJs(); });

function fresh() {
  const db = new SQL.Database();
  db.run(`CREATE TABLE satellite_meta (key TEXT PRIMARY KEY, value TEXT)`);
  db.run(`CREATE TABLE satellite_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT)`);
  db.run(`CREATE TABLE satellite_directives_history (id TEXT PRIMARY KEY, kind TEXT)`);
  db.run(`CREATE TABLE customers (id TEXT PRIMARY KEY, name TEXT)`);
  db.run(`INSERT INTO satellite_meta (key, value) VALUES ('greeting', '"hello"')`);
  db.run(`INSERT INTO customers (id, name) VALUES ('c1', 'Acme')`);
  return db;
}

test('sovereignty — full visibility: reads on any table pass', () => {
  const wrapped = sovereignty.wrap(fresh(), { visibility: 'full' });
  const res = wrapped.exec('SELECT * FROM customers');
  assert.strictEqual(res[0].values[0][1], 'Acme');
});

test('sovereignty — full visibility: INSERT on exec throws', () => {
  const wrapped = sovereignty.wrap(fresh(), { visibility: 'full' });
  assert.throws(
    () => wrapped.exec("INSERT INTO customers (id, name) VALUES ('c2', 'Beta')"),
    /SovereigntyViolation/
  );
});

test('sovereignty — full visibility: run UPDATE throws', () => {
  const wrapped = sovereignty.wrap(fresh(), { visibility: 'full' });
  assert.throws(
    () => wrapped.run("UPDATE customers SET name = ? WHERE id = ?", ['X', 'c1']),
    /SovereigntyViolation/
  );
});

test('sovereignty — full visibility: prepare on INSERT throws', () => {
  const wrapped = sovereignty.wrap(fresh(), { visibility: 'full' });
  assert.throws(
    () => wrapped.prepare("INSERT INTO customers (id, name) VALUES (?, ?)"),
    /SovereigntyViolation/
  );
});

test('sovereignty — full visibility: prepare on SELECT returns a wrapped stmt', () => {
  const wrapped = sovereignty.wrap(fresh(), { visibility: 'full' });
  const stmt = wrapped.prepare("SELECT name FROM customers WHERE id = ?");
  stmt.bind(['c1']);
  stmt.step();
  assert.strictEqual(stmt.getAsObject().name, 'Acme');
  stmt.free();
});

test('sovereignty — limited visibility: allowed tables pass', () => {
  const wrapped = sovereignty.wrap(fresh(), { visibility: 'limited' });
  const res = wrapped.exec('SELECT * FROM satellite_meta');
  assert.strictEqual(res[0].values[0][0], 'greeting');
});

test('sovereignty — limited visibility: disallowed table throws', () => {
  const wrapped = sovereignty.wrap(fresh(), { visibility: 'limited' });
  assert.throws(
    () => wrapped.exec('SELECT * FROM customers'),
    /VisibilityViolation/
  );
});

test('sovereignty — none visibility: all reads throw', () => {
  const wrapped = sovereignty.wrap(fresh(), { visibility: 'none' });
  assert.throws(() => wrapped.exec('SELECT * FROM satellite_meta'), /VisibilityViolation/);
});

test('sovereignty — writes are blocked regardless of visibility', () => {
  for (const vis of ['full', 'limited', 'none']) {
    const wrapped = sovereignty.wrap(fresh(), { visibility: vis });
    assert.throws(
      () => wrapped.run('DELETE FROM customers'),
      /SovereigntyViolation/,
      `visibility=${vis} should still block writes`
    );
  }
});
```

- [ ] **Step 2: Run the tests, see them fail**

Run: `npm test -- tests/satellites/sovereignty.test.js`
Expected: FAIL with "Cannot find module '../../src/satellites/sovereignty'".

- [ ] **Step 3: Implement `src/satellites/sovereignty.js`**

```javascript
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
```

- [ ] **Step 4: Run the tests, see them pass**

Run: `npm test -- tests/satellites/sovereignty.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/satellites/sovereignty.js tests/satellites/sovereignty.test.js
git commit -m "feat(satellites): sovereignty wrapper — block writes, gate reads by visibility"
```

---

## Task 6: Per-satellite DB bootstrap (folder tree + baseline schema + kind schema)

**Files:**
- Modify: `src/satellites/registry.js` — add `createInstance({ slug, name, kind, visibility, owner, config })`
- Test: extend `tests/satellites/registry.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/satellites/registry.test.js`:

```javascript
const initSqlJs = require('sql.js');
const kinds = require('../../src/satellites/kinds');

test('registry — createInstance builds folder tree and baseline+kind tables', async () => {
  const inst = await registry.createInstance({
    slug: 'inst-1',
    name: 'Instance One',
    kind: 'test-kind',
    visibility: 'full',
    owner: 'mothership',
    config: { greeting: 'hi' }
  });
  assert.strictEqual(inst.slug, 'inst-1');
  assert.ok(inst.id);

  const base = path.join(process.env.MOTHERSHIP_SATELLITES_DIR, 'inst-1');
  assert.ok(fs.existsSync(path.join(base, 'db.sqlite')));
  assert.ok(fs.existsSync(path.join(base, 'config.json')));
  assert.ok(fs.existsSync(path.join(base, 'directives', 'pending')));
  assert.ok(fs.existsSync(path.join(base, 'directives', 'applied')));
  assert.ok(fs.existsSync(path.join(base, 'directives', 'rejected')));
  assert.ok(fs.existsSync(path.join(base, 'agents')));

  const cfg = JSON.parse(fs.readFileSync(path.join(base, 'config.json'), 'utf8'));
  assert.strictEqual(cfg.greeting, 'hi');
  assert.strictEqual(cfg.nested.a, 1); // from kind default

  const SQL = await initSqlJs();
  const buf = fs.readFileSync(path.join(base, 'db.sqlite'));
  const sdb = new SQL.Database(buf);
  const tables = sdb.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")[0].values.map(r => r[0]);
  for (const t of ['satellite_meta', 'satellite_messages', 'satellite_logs', 'satellite_directives_history', 'test_widgets']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
});

test('registry — createInstance rolls back on kind load failure', async () => {
  await assert.rejects(
    registry.createInstance({ slug: 'inst-bad', name: 'Bad', kind: 'missing-kind' }),
    /kind not found/i
  );
  assert.ok(!fs.existsSync(path.join(process.env.MOTHERSHIP_SATELLITES_DIR, 'inst-bad')));
  assert.strictEqual(registry.getBySlug('inst-bad'), null);
});
```

- [ ] **Step 2: Run the tests, see them fail**

Run: `npm test -- tests/satellites/registry.test.js`
Expected: FAIL with "registry.createInstance is not a function".

- [ ] **Step 3: Implement `createInstance` (+ the baseline schema constant) in `src/satellites/registry.js`**

Add at the top of the module:

```javascript
const fs = require('fs');
const initSqlJs = require('sql.js');
const kinds = require('./kinds');

const BASELINE_SCHEMA = `
CREATE TABLE IF NOT EXISTS satellite_meta (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS satellite_messages (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  direction TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS satellite_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS satellite_directives_history (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  applied_at TEXT DEFAULT (datetime('now'))
);
`;
```

Add helper functions:

```javascript
function ensureFolderTree(slug) {
  const base = path.join(satellitesDir(), slug);
  const subdirs = ['directives/pending', 'directives/applied', 'directives/rejected', 'agents'];
  fs.mkdirSync(base, { recursive: true });
  for (const sd of subdirs) fs.mkdirSync(path.join(base, sd), { recursive: true });
  return base;
}

function instancePaths(slug) {
  const base = path.join(satellitesDir(), slug);
  return {
    base,
    dbFile: path.join(base, 'db.sqlite'),
    configFile: path.join(base, 'config.json'),
    pending: path.join(base, 'directives', 'pending'),
    applied: path.join(base, 'directives', 'applied'),
    rejected: path.join(base, 'directives', 'rejected')
  };
}

async function applyBaselineAndKindSchema(sdb, kindModule) {
  sdb.exec(BASELINE_SCHEMA);
  if (kindModule.schema && kindModule.schema.trim()) {
    sdb.exec(kindModule.schema);
  }
}

function writeDbFile(sdb, filePath) {
  const bytes = sdb.export();
  fs.writeFileSync(filePath, Buffer.from(bytes));
}

async function createInstance({ slug, name, kind, visibility = 'full', owner = 'mothership', config = {}, fromDraftSlug = null, notes = null }) {
  if (!validateSlug(slug)) throw new Error(`invalid slug: ${slug}`);
  if (getBySlug(slug)) throw new Error(`slug already exists: ${slug}`);

  // Load the kind BEFORE we write any side effects. If this throws we are clean.
  const kindModule = kinds.loadKind(kind);

  const paths = instancePaths(slug);
  let rowInserted = false;
  try {
    ensureFolderTree(slug);

    // Merge kind default config with caller-supplied config (shallow, top-level).
    const mergedConfig = { ...kindModule.defaultConfig, ...config };
    fs.writeFileSync(paths.configFile, JSON.stringify(mergedConfig, null, 2));

    const SQL = await initSqlJs();
    const sdb = new SQL.Database();
    await applyBaselineAndKindSchema(sdb, kindModule);

    // onCreate lifecycle hook — receives raw writable handle
    if (kindModule.onCreate) {
      await kindModule.onCreate({ db: sdb, config: mergedConfig, logger: consoleLogger(slug) });
    }

    writeDbFile(sdb, paths.dbFile);
    sdb.close();

    const id = insertRow({
      slug, name, kind,
      db_path: path.relative(path.join(__dirname, '..', '..'), paths.dbFile).replace(/\\/g, '/'),
      owner, visibility,
      status: 'active',
      config_json: JSON.stringify(mergedConfig),
      notes
    });
    rowInserted = true;

    // TODO in Task 10: if (fromDraftSlug) update the draft row to status='created' with created_satellite_id=id

    return { id, slug };
  } catch (err) {
    // Rollback: remove folder tree and registry row
    try { fs.rmSync(paths.base, { recursive: true, force: true }); } catch {}
    if (rowInserted) deleteRow(slug);
    throw err;
  }
}

function consoleLogger(slug) {
  return {
    info: (msg, data) => db.log('info', `satellite:${slug}`, msg, data || {}),
    warn: (msg, data) => db.log('warn', `satellite:${slug}`, msg, data || {}),
    error: (msg, data) => db.log('error', `satellite:${slug}`, msg, data || {})
  };
}
```

Export `createInstance`, `instancePaths`, `ensureFolderTree`, `consoleLogger` from the module.

- [ ] **Step 4: Run the tests, see them pass**

Run: `npm test -- tests/satellites/registry.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/satellites/registry.js tests/satellites/registry.test.js
git commit -m "feat(satellites): per-instance DB bootstrap with baseline + kind schema"
```

---

## Task 7: Loader — boot-time registration, in-memory map, private raw handles

**Files:**
- Create: `src/satellites/loader.js`
- Test: `tests/satellites/loader.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/satellites/loader.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-sat-loader-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');
process.env.MOTHERSHIP_SATELLITES_DIR = path.join(tmpRoot, 'satellites');
process.env.MOTHERSHIP_KINDS_DIR = path.join(__dirname, '..', 'fixtures', 'satellite-kinds');
fs.mkdirSync(process.env.MOTHERSHIP_SATELLITES_DIR, { recursive: true });

const db = require('../../src/database');
const registry = require('../../src/satellites/registry');
const loader = require('../../src/satellites/loader');
const { SovereigntyViolation, VisibilityViolation } = require('../../src/satellites/sovereignty');

test.before(async () => { await db.init(); });
test.after(async () => {
  await loader.shutdown();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('loader — register returns a wrapped handle stored in the map', async () => {
  await registry.createInstance({ slug: 'load-1', name: 'Load One', kind: 'test-kind' });
  await loader.register('load-1');
  const entry = loader.get('load-1');
  assert.ok(entry);
  assert.strictEqual(entry.kind, 'test-kind');
  // Reads pass under full visibility
  const res = entry.db.exec('SELECT * FROM satellite_meta');
  assert.ok(Array.isArray(res));
});

test('loader — wrapped handle blocks writes', async () => {
  const entry = loader.get('load-1');
  assert.throws(
    () => entry.db.run("INSERT INTO satellite_meta (key, value) VALUES ('x', '1')"),
    SovereigntyViolation
  );
});

test('loader — init loads all active non-embedded satellites', async () => {
  await registry.createInstance({ slug: 'load-2', name: 'Load Two', kind: 'test-kind' });
  await loader.shutdown();
  await loader.init();
  assert.ok(loader.get('load-1'));
  assert.ok(loader.get('load-2'));
});

test('loader — archived satellites are not loaded at boot', async () => {
  registry.updateStatus('load-2', 'archived');
  await loader.shutdown();
  await loader.init();
  assert.ok(loader.get('load-1'));
  assert.strictEqual(loader.get('load-2'), undefined);
});

test('loader — broken kind is marked and does not crash init', async () => {
  // Insert a row directly pointing at a non-existent kind
  registry.insertRow({ slug: 'load-broken', name: 'Broken', kind: 'nope-kind' });
  await loader.shutdown();
  await loader.init();
  const row = registry.getBySlug('load-broken');
  assert.strictEqual(row.status, 'broken');
  assert.strictEqual(loader.get('load-broken'), undefined);
});

test('loader — limited visibility blocks reads of non-meta tables', async () => {
  await registry.createInstance({ slug: 'load-3', name: 'Load Three', kind: 'test-kind' });
  registry.updateVisibility('load-3', 'limited');
  await loader.register('load-3');
  const entry = loader.get('load-3');
  assert.throws(
    () => entry.db.exec('SELECT * FROM test_widgets'),
    VisibilityViolation
  );
  // satellite_meta is still readable
  entry.db.exec('SELECT * FROM satellite_meta');
});
```

- [ ] **Step 2: Run the tests, see them fail**

Run: `npm test -- tests/satellites/loader.test.js`
Expected: FAIL with "Cannot find module '../../src/satellites/loader'".

- [ ] **Step 3: Implement `src/satellites/loader.js`**

```javascript
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

async function register(slug) {
  if (publicMap.has(slug)) return publicMap.get(slug);

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
    rawDb.exec(registry.BASELINE_SCHEMA || '');
    if (kindModule.schema) rawDb.exec(kindModule.schema);
    flushDb(rawDb, paths.dbFile);
  }

  const config = row.config_json ? JSON.parse(row.config_json) : (kindModule.defaultConfig || {});
  const logger = registry.consoleLogger(slug);

  // onBoot lifecycle hook
  if (kindModule.onBoot) {
    try {
      await kindModule.onBoot({ db: rawDb, config, logger });
      flushDb(rawDb, paths.dbFile);
    } catch (err) {
      db.log('error', 'satellites.loader', `onBoot failed for ${slug}: ${err.message}`);
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
  privateMap.set(slug, { rawDb, kindModule, config, directivesStop, dbFile: paths.dbFile });

  return entry;
}

async function unregister(slug) {
  const priv = privateMap.get(slug);
  if (priv) {
    try { if (priv.directivesStop) await priv.directivesStop(); } catch {}
    try { priv.rawDb.close(); } catch {}
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
```

Note: this module references `registry.BASELINE_SCHEMA`. In Task 6 we defined `BASELINE_SCHEMA` as a module-local constant — export it from `registry.js` now:

Add to the bottom of `src/satellites/registry.js`:

```javascript
module.exports.BASELINE_SCHEMA = BASELINE_SCHEMA;
```

Also note: Task 7 introduces a circular dep shape (loader → directives → loader) that we avoid by having `directives.js` take the raw handle as a parameter in `start()`, NOT by importing the loader. This is already reflected in the `directives.start(...)` call above. `directives.js` will be implemented in Task 8 below and must NOT require the loader.

- [ ] **Step 4: Create a minimal `src/satellites/directives.js` stub so loader tests can run**

Create `src/satellites/directives.js` with just enough to let the loader's `directives.start` call succeed. The full implementation arrives in Task 8.

```javascript
/**
 * MOTHERSHIP — Directive consumer (stub; Task 8 fills this in)
 */
async function start(slug, ctx) {
  // Stub: return a no-op stopper. Task 8 replaces with a chokidar watcher.
  return async () => {};
}

module.exports = { start };
```

- [ ] **Step 5: Run the tests, see them pass**

Run: `npm test -- tests/satellites/loader.test.js`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/satellites/loader.js src/satellites/directives.js src/satellites/registry.js tests/satellites/loader.test.js
git commit -m "feat(satellites): loader with private raw handles + sovereignty-wrapped public map"
```

---

## Task 8: Directive consumer — chokidar loop, config.set handler, history

**Files:**
- Modify: `src/satellites/directives.js` (replace stub with real implementation)
- Test: `tests/satellites/directives.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/satellites/directives.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-sat-dir-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');
process.env.MOTHERSHIP_SATELLITES_DIR = path.join(tmpRoot, 'satellites');
process.env.MOTHERSHIP_KINDS_DIR = path.join(__dirname, '..', 'fixtures', 'satellite-kinds');
fs.mkdirSync(process.env.MOTHERSHIP_SATELLITES_DIR, { recursive: true });

const db = require('../../src/database');
const registry = require('../../src/satellites/registry');
const loader = require('../../src/satellites/loader');
const directives = require('../../src/satellites/directives');

test.before(async () => { await db.init(); });
test.after(async () => {
  await loader.shutdown();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

test('directives — issue writes a JSON file to pending/', async () => {
  await registry.createInstance({ slug: 'd-1', name: 'Dir One', kind: 'test-kind' });
  const id = directives.issue('d-1', {
    kind: 'config.set',
    payload: { key: 'hours', value: '9-5' },
    issuedBy: 'test'
  });
  assert.ok(id);
  const pending = path.join(process.env.MOTHERSHIP_SATELLITES_DIR, 'd-1', 'directives', 'pending');
  const files = fs.readdirSync(pending);
  assert.strictEqual(files.length, 1);
  const body = JSON.parse(fs.readFileSync(path.join(pending, files[0]), 'utf8'));
  assert.strictEqual(body.kind, 'config.set');
  assert.strictEqual(body.payload.key, 'hours');
  assert.strictEqual(body.issued_by, 'test');
});

test('directives — consumer processes pending directives on register', async () => {
  await loader.register('d-1');
  // Wait for the startup sweep to run the directive.
  await sleep(200);

  const inst = path.join(process.env.MOTHERSHIP_SATELLITES_DIR, 'd-1', 'directives');
  assert.strictEqual(fs.readdirSync(path.join(inst, 'pending')).length, 0);
  assert.strictEqual(fs.readdirSync(path.join(inst, 'applied')).length, 1);

  // History row
  const entry = loader.get('d-1');
  const res = entry.db.exec('SELECT kind, status FROM satellite_directives_history');
  assert.strictEqual(res[0].values[0][0], 'config.set');
  assert.strictEqual(res[0].values[0][1], 'applied');

  // satellite_meta contains the key
  const meta = entry.db.exec("SELECT value FROM satellite_meta WHERE key = 'hours'");
  assert.strictEqual(JSON.parse(meta[0].values[0][0]), '9-5');
});

test('directives — unknown kind is rejected with error file', async () => {
  await registry.createInstance({ slug: 'd-2', name: 'Dir Two', kind: 'test-kind' });
  directives.issue('d-2', { kind: 'does.not.exist', payload: {}, issuedBy: 'test' });
  await loader.register('d-2');
  await sleep(200);

  const rejected = path.join(process.env.MOTHERSHIP_SATELLITES_DIR, 'd-2', 'directives', 'rejected');
  const files = fs.readdirSync(rejected);
  assert.ok(files.some(f => f.endsWith('.json')));
  assert.ok(files.some(f => f.endsWith('_error.txt')));
});

test('directives — hot-added directive is processed by chokidar', async () => {
  await registry.createInstance({ slug: 'd-3', name: 'Dir Three', kind: 'test-kind' });
  await loader.register('d-3');
  directives.issue('d-3', {
    kind: 'config.set',
    payload: { key: 'greeting', value: 'hi' },
    issuedBy: 'test'
  });
  await sleep(500);

  const entry = loader.get('d-3');
  const res = entry.db.exec("SELECT value FROM satellite_meta WHERE key = 'greeting'");
  assert.strictEqual(JSON.parse(res[0].values[0][0]), 'hi');
});
```

- [ ] **Step 2: Run the tests, see them fail**

Run: `npm test -- tests/satellites/directives.test.js`
Expected: FAIL with "directives.issue is not a function" or similar.

- [ ] **Step 3: Replace the stub `src/satellites/directives.js` with the real implementation**

```javascript
/**
 * MOTHERSHIP — Directive consumer
 *
 * Watches `data/satellites/<slug>/directives/pending/` for JSON directive
 * files, looks up the matching handler in the kind/custom module, and calls
 * it with the raw writable DB handle (supplied by the loader via closure).
 *
 * Files move to applied/ or rejected/ after handling. A history row is
 * written to the satellite's own satellite_directives_history table.
 *
 * Trust boundary: this module is one of only two that sees the raw handle
 * (the other is loader.js). It does NOT write to the DB itself — it only
 * passes the handle into the handler that was authored inside the kind
 * module or the instance's custom.js.
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const chokidar = require('chokidar');

const registry = require('./registry');
const db = require('../database');

function pendingDir(slug) { return path.join(registry.satellitesDir(), slug, 'directives', 'pending'); }
function appliedDir(slug) { return path.join(registry.satellitesDir(), slug, 'directives', 'applied'); }
function rejectedDir(slug) { return path.join(registry.satellitesDir(), slug, 'directives', 'rejected'); }

function fsSafeTs() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function issue(slug, { kind, payload, issuedBy = 'mothership' }) {
  const id = uuidv4();
  const body = {
    id,
    kind,
    issued_at: new Date().toISOString(),
    issued_by: issuedBy,
    payload
  };
  const fname = `${fsSafeTs()}-${kind}-${id.slice(0, 8)}.json`;
  const target = path.join(pendingDir(slug), fname);
  fs.mkdirSync(pendingDir(slug), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(body, null, 2));
  return id;
}

async function processFile(filePath, ctx) {
  const { slug, rawDb, kindModule, config, logger, flush } = ctx;
  let body;
  try {
    body = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return moveToRejected(filePath, slug, `parse error: ${err.message}`, { kind: 'unknown', payload: {} }, rawDb, flush);
  }

  const handler = (kindModule.directiveHandlers || {})[body.kind];
  if (!handler) {
    return moveToRejected(filePath, slug, `unknown directive kind: ${body.kind}`, body, rawDb, flush);
  }

  try {
    await handler({ payload: body.payload, db: rawDb, config, logger });
    writeHistory(rawDb, body, 'applied', null);
    flush();
    const target = path.join(appliedDir(slug), path.basename(filePath));
    fs.mkdirSync(appliedDir(slug), { recursive: true });
    fs.renameSync(filePath, target);
    db.log('info', `satellites.directives:${slug}`, `applied ${body.kind} ${body.id}`);
  } catch (err) {
    return moveToRejected(filePath, slug, err.message, body, rawDb, flush);
  }
}

function moveToRejected(filePath, slug, errorMsg, body, rawDb, flush) {
  try { writeHistory(rawDb, body, 'rejected', errorMsg); flush(); } catch {}
  fs.mkdirSync(rejectedDir(slug), { recursive: true });
  const target = path.join(rejectedDir(slug), path.basename(filePath));
  try { fs.renameSync(filePath, target); } catch {}
  try { fs.writeFileSync(target + '_error.txt', errorMsg); } catch {}
  db.log('warn', `satellites.directives:${slug}`, `rejected ${body.kind || 'unknown'}: ${errorMsg}`);
}

function writeHistory(rawDb, body, status, errorMsg) {
  rawDb.run(
    `INSERT OR REPLACE INTO satellite_directives_history
     (id, kind, payload_json, status, error, applied_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    [body.id || uuidv4(), body.kind || 'unknown', JSON.stringify(body.payload || {}), status, errorMsg || null]
  );
}

async function start(slug, { rawDb, kindModule, config, logger, flush }) {
  const ctx = { slug, rawDb, kindModule, config, logger, flush };

  // Startup sweep — process any leftover files
  const pending = pendingDir(slug);
  fs.mkdirSync(pending, { recursive: true });
  for (const f of fs.readdirSync(pending)) {
    if (f.endsWith('.json')) {
      await processFile(path.join(pending, f), ctx);
    }
  }

  // chokidar watcher for live additions
  const watcher = chokidar.watch(pending, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 30 }
  });
  watcher.on('add', async (file) => {
    if (!file.endsWith('.json')) return;
    try { await processFile(file, ctx); }
    catch (err) { db.log('error', `satellites.directives:${slug}`, err.message); }
  });

  return async () => { await watcher.close(); };
}

module.exports = { issue, start };
```

- [ ] **Step 4: Run the tests, see them pass**

Run: `npm test -- tests/satellites/directives.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/satellites/directives.js tests/satellites/directives.test.js
git commit -m "feat(satellites): directive inbox with chokidar consumer and config.set handler"
```

---

## Task 9: Satellite lifecycle — archive / unarchive / transfer / visibility changes

**Files:**
- Modify: `src/satellites/registry.js` — add lifecycle functions
- Modify: `src/satellites/loader.js` — wire lifecycle to unregister/re-register
- Test: `tests/satellites/lifecycle.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/satellites/lifecycle.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-sat-life-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');
process.env.MOTHERSHIP_SATELLITES_DIR = path.join(tmpRoot, 'satellites');
process.env.MOTHERSHIP_KINDS_DIR = path.join(__dirname, '..', 'fixtures', 'satellite-kinds');
fs.mkdirSync(process.env.MOTHERSHIP_SATELLITES_DIR, { recursive: true });

const db = require('../../src/database');
const registry = require('../../src/satellites/registry');
const loader = require('../../src/satellites/loader');
const { VisibilityViolation } = require('../../src/satellites/sovereignty');

test.before(async () => { await db.init(); });
test.after(async () => {
  await loader.shutdown();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('lifecycle — archive unloads the satellite and sets status', async () => {
  await registry.createInstance({ slug: 'lc-1', name: 'LC One', kind: 'test-kind' });
  await loader.register('lc-1');
  assert.ok(loader.get('lc-1'));

  await registry.archive('lc-1');
  assert.strictEqual(registry.getBySlug('lc-1').status, 'archived');
  assert.strictEqual(loader.get('lc-1'), undefined);
});

test('lifecycle — unarchive reloads the satellite', async () => {
  await registry.unarchive('lc-1');
  assert.strictEqual(registry.getBySlug('lc-1').status, 'active');
  assert.ok(loader.get('lc-1'));
});

test('lifecycle — transfer sets transferred_at and unloads', async () => {
  await registry.transfer('lc-1', { visibility: 'none', owner: 'client' });
  const row = registry.getBySlug('lc-1');
  assert.strictEqual(row.status, 'transferred');
  assert.ok(row.transferred_at);
  assert.strictEqual(row.visibility, 'none');
  assert.strictEqual(row.owner, 'client');
  assert.strictEqual(loader.get('lc-1'), undefined);
});

test('lifecycle — setVisibility updates in-memory wrapper', async () => {
  await registry.createInstance({ slug: 'lc-2', name: 'LC Two', kind: 'test-kind' });
  await loader.register('lc-2');
  await registry.setVisibility('lc-2', 'limited');
  const entry = loader.get('lc-2');
  assert.throws(
    () => entry.db.exec('SELECT * FROM test_widgets'),
    VisibilityViolation
  );
});
```

- [ ] **Step 2: Run the tests, see them fail**

Run: `npm test -- tests/satellites/lifecycle.test.js`
Expected: FAIL with "registry.archive is not a function".

- [ ] **Step 3: Add lifecycle functions to `src/satellites/registry.js`**

Append to `registry.js`:

```javascript
async function archive(slug) {
  const loader = require('./loader'); // lazy to avoid circular require
  updateStatus(slug, 'archived');
  await loader.unregister(slug);
}

async function unarchive(slug) {
  const loader = require('./loader');
  updateStatus(slug, 'active');
  await loader.register(slug);
}

async function transfer(slug, { visibility, owner } = {}) {
  const loader = require('./loader');
  const raw = db._raw();
  const patches = ["status = 'transferred'", "transferred_at = datetime('now')"];
  const params = [];
  if (visibility) { patches.push('visibility = ?'); params.push(visibility); }
  if (owner) { patches.push('owner = ?'); params.push(owner); }
  params.push(slug);
  raw.run(`UPDATE satellites SET ${patches.join(', ')} WHERE slug = ?`, params);
  db.save();
  await loader.unregister(slug);
}

async function setVisibility(slug, visibility) {
  if (!['full', 'limited', 'none'].includes(visibility)) {
    throw new Error(`invalid visibility: ${visibility}`);
  }
  const loader = require('./loader');
  updateVisibility(slug, visibility);

  // Re-wrap the in-memory handle if loaded — simplest path: unregister then register.
  if (loader.get(slug)) {
    await loader.unregister(slug);
    await loader.register(slug);
  }
}

module.exports.archive = archive;
module.exports.unarchive = unarchive;
module.exports.transfer = transfer;
module.exports.setVisibility = setVisibility;
```

- [ ] **Step 4: Run the tests, see them pass**

Run: `npm test -- tests/satellites/lifecycle.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/satellites/registry.js tests/satellites/lifecycle.test.js
git commit -m "feat(satellites): lifecycle — archive, unarchive, transfer, visibility"
```

---

## Task 10: Drafts module — CRUD, message linking, brief regeneration

**Files:**
- Create: `src/satellites/drafts.js`
- Test: `tests/satellites/drafts.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/satellites/drafts.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-sat-drafts-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');

const db = require('../../src/database');
const drafts = require('../../src/satellites/drafts');

test.before(async () => { await db.init(); });
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test('drafts — create inserts a row with discussing status', () => {
  const id = drafts.create({ slug: 'dr-1', name: 'Draft One', kind: 'test-kind' });
  assert.ok(id);
  const row = drafts.getBySlug('dr-1');
  assert.strictEqual(row.status, 'discussing');
  assert.strictEqual(row.kind, 'test-kind');
});

test('drafts — create accepts missing kind', () => {
  drafts.create({ slug: 'dr-2', name: 'Fuzzy idea' });
  const row = drafts.getBySlug('dr-2');
  assert.strictEqual(row.kind, null);
});

test('drafts — list returns all drafts ordered by created_at', () => {
  const all = drafts.list();
  assert.ok(all.length >= 2);
});

test('drafts — getDraftWithMessages returns linked messages', () => {
  db.addMessage('What if we build a dental satellite?', 'dashboard', 'uncategorized', { draft_slug: 'dr-1' });
  db.addMessage("Sure — what's the main workflow?", 'mothership', 'reply', { draft_slug: 'dr-1' });
  db.addMessage('Unrelated chatter', 'dashboard', 'uncategorized', {});

  const { draft, messages } = drafts.getDraftWithMessages('dr-1');
  assert.strictEqual(draft.slug, 'dr-1');
  assert.strictEqual(messages.length, 2);
  assert.ok(messages.find(m => m.content.includes('dental satellite')));
  assert.ok(messages.find(m => m.content.includes('main workflow')));
});

test('drafts — setBrief stores markdown and bumps updated timestamp', () => {
  drafts.setBrief('dr-1', '# Brief\n\nThis is the brief.');
  const row = drafts.getBySlug('dr-1');
  assert.ok(row.brief_md.includes('# Brief'));
  assert.ok(row.brief_updated_at);
});

test('drafts — setStatus updates status', () => {
  drafts.setStatus('dr-1', 'planned');
  assert.strictEqual(drafts.getBySlug('dr-1').status, 'planned');
});

test('drafts — linkToSatellite sets status created and fk', () => {
  drafts.linkToSatellite('dr-1', 'sat-id-fake');
  const row = drafts.getBySlug('dr-1');
  assert.strictEqual(row.status, 'created');
  assert.strictEqual(row.created_satellite_id, 'sat-id-fake');
});
```

- [ ] **Step 2: Run the tests, see them fail**

Run: `npm test -- tests/satellites/drafts.test.js`
Expected: FAIL with "Cannot find module '../../src/satellites/drafts'".

- [ ] **Step 3: Implement `src/satellites/drafts.js`**

```javascript
/**
 * MOTHERSHIP — Satellite draft capture
 *
 * Drafts are in-progress satellite ideas. Each links to a slug and
 * accumulates chat turns (by metadata.draft_slug on the messages table)
 * plus an optional synthesized brief. Claude Code reads the draft endpoint
 * to get the full conversation + brief as build context.
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../database');

function create({ slug, name, kind = null }) {
  const id = uuidv4();
  const raw = db._raw();
  raw.run(
    `INSERT INTO satellite_drafts (id, slug, name, kind) VALUES (?, ?, ?, ?)`,
    [id, slug, name, kind]
  );
  db.save();
  return id;
}

function getBySlug(slug) {
  const raw = db._raw();
  const stmt = raw.prepare('SELECT * FROM satellite_drafts WHERE slug = ?');
  stmt.bind([slug]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function list({ status } = {}) {
  const raw = db._raw();
  let q = 'SELECT * FROM satellite_drafts WHERE 1=1';
  const p = [];
  if (status) { q += ' AND status = ?'; p.push(status); }
  q += ' ORDER BY created_at ASC';
  const stmt = raw.prepare(q);
  stmt.bind(p);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function setBrief(slug, briefMd) {
  const raw = db._raw();
  raw.run(
    `UPDATE satellite_drafts
     SET brief_md = ?, brief_updated_at = datetime('now'), updated_at = datetime('now')
     WHERE slug = ?`,
    [briefMd, slug]
  );
  db.save();
}

function setStatus(slug, status) {
  const raw = db._raw();
  raw.run(
    `UPDATE satellite_drafts SET status = ?, updated_at = datetime('now') WHERE slug = ?`,
    [status, slug]
  );
  db.save();
}

function linkToSatellite(slug, satelliteId) {
  const raw = db._raw();
  raw.run(
    `UPDATE satellite_drafts
     SET status = 'created', created_satellite_id = ?, updated_at = datetime('now')
     WHERE slug = ?`,
    [satelliteId, slug]
  );
  db.save();
}

function getDraftWithMessages(slug) {
  const draft = getBySlug(slug);
  if (!draft) return null;

  const raw = db._raw();
  const stmt = raw.prepare(
    `SELECT * FROM messages
     WHERE json_extract(metadata, '$.draft_slug') = ?
     ORDER BY created_at ASC`
  );
  stmt.bind([slug]);
  const messages = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    row.tags = JSON.parse(row.tags || '[]');
    row.metadata = JSON.parse(row.metadata || '{}');
    messages.push(row);
  }
  stmt.free();
  return { draft, messages };
}

async function regenerateBrief(slug, { conversation } = {}) {
  const { draft, messages } = getDraftWithMessages(slug) || {};
  if (!draft) throw new Error(`no such draft: ${slug}`);

  const conv = conversation || require('../conversation');
  const transcript = messages.map(m =>
    `${m.source === 'mothership' ? 'MOTHERSHIP' : 'YOEL'}: ${m.content}`
  ).join('\n\n');

  const systemHint = [
    `You are generating a structured build brief for a satellite named "${draft.name}" (slug: ${draft.slug}, kind: ${draft.kind || 'unknown'}).`,
    'Read the transcript below and produce a markdown brief with these sections:',
    '## Goal', '## Users', '## Data kinds', '## Operational constraints', '## Open questions',
    'Be concise. If a section has no evidence in the transcript, write "not yet specified".'
  ].join('\n');

  const reply = await conv.respond(`${systemHint}\n\n---\n\n${transcript}`, { contextKind: 'text' });
  setBrief(slug, reply);
  return reply;
}

module.exports = {
  create, getBySlug, list,
  setBrief, setStatus, linkToSatellite,
  getDraftWithMessages, regenerateBrief
};
```

- [ ] **Step 4: Run the tests, see them pass**

Run: `npm test -- tests/satellites/drafts.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/satellites/drafts.js tests/satellites/drafts.test.js
git commit -m "feat(satellites): draft capture — CRUD, message linking, brief regeneration"
```

---

## Task 11: Wire `draft_slug` into `/api/chat` and tag mirror entries `satellite-building`

**Files:**
- Modify: `src/routes/api.js` — extend `/api/chat` body handling
- Modify: `src/conversation-hooks.js` — accept `draftSlug` and pass `forceCategory`
- Modify: `src/quantum-mirror.js` — honor `forceCategory` option
- Test: `tests/satellites/chat-draft.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/satellites/chat-draft.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-sat-chat-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');

const db = require('../../src/database');
const ve = require('../../src/memory/vector-engine');
const qm = require('../../src/quantum-mirror');
const hooks = require('../../src/conversation-hooks');

test.before(async () => { await db.init(); });
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test('hooks.postResponse — draftSlug forces satellite-building category', async () => {
  ve._setClient({
    embeddings: { create: async () => ({ data: [{ embedding: new Array(3).fill(0.5) }] }) }
  });
  qm._setClient({
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: JSON.stringify({
          new_entries: [
            { category: 'random-category', content: 'some insight about the workflow', confidence: 0.7 }
          ],
          supersede: [], contradictions: []
        }) }]
      })
    }
  });

  await hooks.postResponse({
    userText: 'Long enough message to trigger synthesis about a new dental satellite idea',
    assistantText: 'ok',
    sourceId: 't-draft',
    draftSlug: 'dr-chat-1'
  });

  const entries = db.getMirrorEntries({ activeOnly: true, limit: 100 });
  assert.ok(entries.some(e => e.category === 'satellite-building'));
  assert.ok(!entries.some(e => e.category === 'random-category'));
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `npm test -- tests/satellites/chat-draft.test.js`
Expected: FAIL — entries still have `random-category` because `forceCategory` is not plumbed through.

- [ ] **Step 3: Modify `src/quantum-mirror.js` to honor `forceCategory`**

Change the signature of `synthesizeFromTurn` to accept the option and override each new_entry's category:

```javascript
async function synthesizeFromTurn({ userText, assistantText, sourceId, forceCategory = null }) {
  // ... existing body unchanged until the for loop ...

  let created = 0;
  for (const entry of parsed.new_entries || []) {
    try {
      await ve.storeMirrorEntry({
        category: forceCategory || entry.category,
        content: entry.content,
        confidence: entry.confidence ?? 0.6,
        source_type: 'conversation',
        source_id: sourceId
      });
      created++;
    } catch (err) {
      db.log('error', 'quantum-mirror', `storeMirrorEntry failed: ${err.message}`);
    }
  }
  // ... rest unchanged ...
}
```

- [ ] **Step 4: Modify `src/conversation-hooks.js` to accept `draftSlug` and pass `forceCategory`**

Change `postResponse`:

```javascript
async function postResponse({ userText, assistantText, sourceId, draftSlug = null }) {
  if (!userText || userText.length < MIN_TURN_LENGTH) return;
  try {
    await qm.synthesizeFromTurn({
      userText,
      assistantText,
      sourceId,
      forceCategory: draftSlug ? 'satellite-building' : null
    });
  } catch (err) {
    db.log('error', 'hooks.postResponse', err.message);
  }
}
```

- [ ] **Step 5: Modify `src/routes/api.js` `/api/chat` to accept `draft_slug`**

Change the `/chat` route body to:

```javascript
router.post('/chat', async (req, res) => {
  const { content, draft_slug } = req.body || {};
  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'content is required' });
  }
  const userText = content.trim();
  const draftSlug = typeof draft_slug === 'string' && draft_slug.length > 0 ? draft_slug : null;

  try {
    const userMeta = { via: 'dashboard-chat' };
    if (draftSlug) userMeta.draft_slug = draftSlug;
    const userId = db.addMessage(userText, 'dashboard', 'uncategorized', userMeta);

    const reply = await conversation.respond(userText, { contextKind: 'text' });

    const replyMeta = { via: 'dashboard-chat', in_reply_to: userId };
    if (draftSlug) replyMeta.draft_slug = draftSlug;
    const replyId = db.addMessage(reply, 'mothership', 'reply', replyMeta);

    hooks.postResponse({
      userText,
      assistantText: reply,
      sourceId: replyId,
      draftSlug
    }).catch(err => db.log('error', 'api.chat.postResponse', err.message));

    res.json({ userId, replyId, reply });
  } catch (err) {
    db.log('error', 'api.chat', err.message);
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 6: Run the test, see it pass**

Run: `npm test -- tests/satellites/chat-draft.test.js`
Expected: PASS.

- [ ] **Step 7: Run the existing hook tests to ensure no regression**

Run: `npm test -- tests/conversation-hooks.test.js`
Expected: PASS (all 5 existing tests).

- [ ] **Step 8: Commit**

```bash
git add src/routes/api.js src/conversation-hooks.js src/quantum-mirror.js tests/satellites/chat-draft.test.js
git commit -m "feat(satellites): tag mirror entries 'satellite-building' when turn is linked to a draft"
```

---

## Task 12: Public module surface `src/satellites/index.js`

**Files:**
- Create: `src/satellites/index.js`

- [ ] **Step 1: Create the public surface**

```javascript
/**
 * MOTHERSHIP — Satellites public surface
 *
 * Imported by server.js and routes/api.js. This is the only module the rest
 * of Mothership should reach into. Internals (sovereignty, kinds, raw
 * handles) are deliberately not re-exported.
 */

const registry = require('./registry');
const loader = require('./loader');
const directives = require('./directives');
const drafts = require('./drafts');

async function init() {
  await loader.init();
}

async function shutdown() {
  await loader.shutdown();
}

module.exports = {
  init,
  shutdown,
  registry,
  loader,
  directives,
  drafts
};
```

- [ ] **Step 2: Commit**

```bash
git add src/satellites/index.js
git commit -m "feat(satellites): public module surface for server.js and routes"
```

---

## Task 13: REST API endpoints for satellites and drafts

**Files:**
- Modify: `src/routes/api.js`
- Test: `tests/satellites/api.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/satellites/api.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-sat-api-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');
process.env.MOTHERSHIP_SATELLITES_DIR = path.join(tmpRoot, 'satellites');
process.env.MOTHERSHIP_KINDS_DIR = path.join(__dirname, '..', 'fixtures', 'satellite-kinds');
fs.mkdirSync(process.env.MOTHERSHIP_SATELLITES_DIR, { recursive: true });

const db = require('../../src/database');
const satellites = require('../../src/satellites');
const express = require('express');
const apiRoutes = require('../../src/routes/api');

let server, baseUrl;

test.before(async () => {
  await db.init();
  await satellites.init();
  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);
  server = app.listen(0);
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  server.close();
  await satellites.shutdown();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function req(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

test('api — POST /api/satellites creates a satellite', async () => {
  const { status, body } = await req('POST', '/api/satellites', {
    slug: 'api-1', name: 'API One', kind: 'test-kind', visibility: 'full'
  });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.slug, 'api-1');
});

test('api — GET /api/satellites lists', async () => {
  const { status, body } = await req('GET', '/api/satellites');
  assert.strictEqual(status, 200);
  assert.ok(body.some(r => r.slug === 'api-1'));
});

test('api — GET /api/satellites/:slug returns details', async () => {
  const { status, body } = await req('GET', '/api/satellites/api-1');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.kind, 'test-kind');
});

test('api — POST /api/satellites/:slug/directives issues a directive', async () => {
  const { status } = await req('POST', '/api/satellites/api-1/directives', {
    kind: 'config.set',
    payload: { key: 'motto', value: 'ship it' }
  });
  assert.strictEqual(status, 200);
});

test('api — POST /api/satellites/:slug/archive and unarchive', async () => {
  let r = await req('POST', '/api/satellites/api-1/archive', {});
  assert.strictEqual(r.status, 200);
  r = await req('POST', '/api/satellites/api-1/unarchive', {});
  assert.strictEqual(r.status, 200);
});

test('api — POST /api/satellites/:slug/visibility', async () => {
  const r = await req('POST', '/api/satellites/api-1/visibility', { visibility: 'limited' });
  assert.strictEqual(r.status, 200);
});

test('api — POST /api/satellites/drafts creates a draft', async () => {
  const r = await req('POST', '/api/satellites/drafts', {
    slug: 'api-draft-1', name: 'API Draft One', kind: 'test-kind'
  });
  assert.strictEqual(r.status, 200);
});

test('api — GET /api/satellites/drafts/:slug returns draft and messages', async () => {
  db.addMessage('test draft message', 'dashboard', 'uncategorized', { draft_slug: 'api-draft-1' });
  const r = await req('GET', '/api/satellites/drafts/api-draft-1');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.draft.slug, 'api-draft-1');
  assert.strictEqual(r.body.messages.length, 1);
});

test('api — POST /api/satellites/drafts/:slug/status changes status', async () => {
  const r = await req('POST', '/api/satellites/drafts/api-draft-1/status', { status: 'planned' });
  assert.strictEqual(r.status, 200);
});

test('api — POST /api/satellites from draft links back', async () => {
  const r = await req('POST', '/api/satellites', {
    slug: 'api-from-draft', name: 'From Draft', kind: 'test-kind',
    from_draft_slug: 'api-draft-1'
  });
  assert.strictEqual(r.status, 200);
  const drafts = require('../../src/satellites/drafts');
  const draft = drafts.getBySlug('api-draft-1');
  assert.strictEqual(draft.status, 'created');
  assert.strictEqual(draft.created_satellite_id, r.body.id);
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `npm test -- tests/satellites/api.test.js`
Expected: FAIL — endpoints return 404.

- [ ] **Step 3: Add the endpoints to `src/routes/api.js`**

Add after the existing routes, before `module.exports`:

```javascript
// --- Satellites ---

const satellites = require('../satellites');

router.post('/satellites', async (req, res) => {
  try {
    const { slug, name, kind, visibility, owner, config, from_draft_slug, notes } = req.body || {};
    const result = await satellites.registry.createInstance({
      slug, name, kind, visibility, owner, config, notes
    });
    if (from_draft_slug) {
      satellites.drafts.linkToSatellite(from_draft_slug, result.id);
    }
    await satellites.loader.register(slug);
    res.json({ id: result.id, slug: result.slug, status: 'active' });
  } catch (err) {
    db.log('error', 'api.satellites.create', err.message);
    res.status(400).json({ error: err.message });
  }
});

router.get('/satellites', (req, res) => {
  const { status, kind, visibility } = req.query;
  res.json(satellites.registry.listRows({ status, kind, visibility }));
});

router.get('/satellites/:slug', (req, res) => {
  const row = satellites.registry.getBySlug(req.params.slug);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

router.post('/satellites/:slug/archive', async (req, res) => {
  try { await satellites.registry.archive(req.params.slug); res.json({ status: 'archived' }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/satellites/:slug/unarchive', async (req, res) => {
  try { await satellites.registry.unarchive(req.params.slug); res.json({ status: 'active' }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/satellites/:slug/transfer', async (req, res) => {
  try {
    const { visibility, owner } = req.body || {};
    await satellites.registry.transfer(req.params.slug, { visibility, owner });
    res.json({ status: 'transferred' });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/satellites/:slug/visibility', async (req, res) => {
  try {
    const { visibility } = req.body || {};
    await satellites.registry.setVisibility(req.params.slug, visibility);
    res.json({ visibility });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/satellites/:slug/directives', (req, res) => {
  try {
    const { kind, payload } = req.body || {};
    if (!kind) return res.status(400).json({ error: 'kind is required' });
    const id = satellites.directives.issue(req.params.slug, {
      kind, payload: payload || {}, issuedBy: 'mothership:api'
    });
    res.json({ id, status: 'issued' });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/satellites/:slug/directives', (req, res) => {
  const entry = satellites.loader.get(req.params.slug);
  if (!entry) return res.status(404).json({ error: 'satellite not loaded' });
  const result = entry.db.exec(
    'SELECT id, kind, payload_json, status, error, applied_at FROM satellite_directives_history ORDER BY applied_at DESC'
  );
  if (!result.length) return res.json([]);
  const [firstResult] = result;
  res.json(firstResult.values.map(row => {
    const obj = {};
    firstResult.columns.forEach((c, i) => { obj[c] = row[i]; });
    return obj;
  }));
});

// --- Satellite drafts ---

router.post('/satellites/drafts', (req, res) => {
  try {
    const { slug, name, kind } = req.body || {};
    if (!slug || !name) return res.status(400).json({ error: 'slug and name required' });
    const id = satellites.drafts.create({ slug, name, kind });
    res.json({ id, slug });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/satellites/drafts', (req, res) => {
  res.json(satellites.drafts.list({ status: req.query.status }));
});

router.get('/satellites/drafts/:slug', (req, res) => {
  const result = satellites.drafts.getDraftWithMessages(req.params.slug);
  if (!result) return res.status(404).json({ error: 'not found' });
  res.json(result);
});

router.post('/satellites/drafts/:slug/regenerate-brief', async (req, res) => {
  try {
    const brief = await satellites.drafts.regenerateBrief(req.params.slug);
    res.json({ brief });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/satellites/drafts/:slug/status', (req, res) => {
  try {
    const { status } = req.body || {};
    satellites.drafts.setStatus(req.params.slug, status);
    res.json({ status });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
```

Important: the `POST /satellites/drafts` route must be declared **before** `GET /satellites/:slug` would ever be called in a way that captures `drafts` as a slug. Express routes are matched in order, so place the drafts group **after** `GET /satellites/:slug` is fine because Express's `:slug` pattern does match `drafts` — BUT there is a collision: `GET /satellites/drafts` vs `GET /satellites/:slug` — the first declared wins. Place `GET /satellites/drafts` and `POST /satellites/drafts` BEFORE `GET /satellites/:slug` to avoid the collision.

Reorder the routes accordingly when adding them.

- [ ] **Step 4: Run the test, see it pass**

Run: `npm test -- tests/satellites/api.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Run the full test suite to confirm no regression**

Run: `npm test`
Expected: PASS — all existing tests + the new satellite tests.

- [ ] **Step 6: Commit**

```bash
git add src/routes/api.js tests/satellites/api.test.js
git commit -m "feat(satellites): REST endpoints for registry, lifecycle, directives, drafts"
```

---

## Task 14: Wire `satellites.init()` into `server.js` boot, add data stubs and .gitignore

**Files:**
- Modify: `server.js`
- Create: `data/satellites/README.md`
- Create: `data/satellites/.gitkeep`
- Modify: `.gitignore`

- [ ] **Step 1: Modify `server.js` boot sequence**

At the top, add:

```javascript
const satellites = require('./src/satellites');
```

Inside `boot()`, after the `migrate.runIfNeeded()` line (between step 1a and step 2), insert:

```javascript
  // 1b. Initialize satellites (Phase 6 #1)
  try {
    await satellites.init();
    console.log('  ✔ Satellites loaded');
  } catch (err) {
    console.log(`  ⚠ Satellite init error: ${err.message}`);
  }
```

- [ ] **Step 2: Create `data/satellites/README.md`**

```markdown
# data/satellites/

Per-instance satellite data. Each subdirectory is owned by one satellite:

```
data/satellites/<slug>/
├── db.sqlite          — the satellite's own SQLite DB (sovereign)
├── config.json        — merged kind-default + instance config
├── .secrets           — bot tokens, API keys (chmod 600, gitignored)
├── custom.js          — optional per-instance override
├── agents/            — staff sub-bots (reserved for sub-project #6)
└── directives/
    ├── pending/       — Mothership writes directive JSON here
    ├── applied/       — satellite moves applied directives here
    └── rejected/      — satellite moves failed directives here
```

Instance folders are gitignored. This README and the adjacent `.gitkeep`
are the only files here that get tracked by git.
```

- [ ] **Step 3: Create `data/satellites/.gitkeep`**

Empty file.

- [ ] **Step 4: Update `.gitignore`**

The existing `.gitignore` already has `data/` which would hide the new README. Amend the `data/` line to exclude the satellite metadata files:

```
node_modules/
data/
!data/satellites/
data/satellites/*
!data/satellites/README.md
!data/satellites/.gitkeep
.env
.env.premigration
downloads/
inbox/*
!inbox/.gitkeep
**/.tmp-*.db
*.db.corrupted
.claude/
launch/
```

Verify with `git check-ignore data/satellites/README.md` — expected: no output (not ignored).

Verify with `git check-ignore data/satellites/example/db.sqlite` — expected: `data/satellites/example/db.sqlite` (ignored).

- [ ] **Step 5: Smoke-test the server boots**

Run: `node -e "require('./server.js')"` in the background, then kill it after 3 seconds.

Or more simply, create `tests/satellites/boot.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-sat-boot-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');
process.env.MOTHERSHIP_SATELLITES_DIR = path.join(tmpRoot, 'satellites');
process.env.MOTHERSHIP_KINDS_DIR = path.join(__dirname, '..', 'fixtures', 'satellite-kinds');
fs.mkdirSync(process.env.MOTHERSHIP_SATELLITES_DIR, { recursive: true });

const db = require('../../src/database');
const satellites = require('../../src/satellites');

test.before(async () => { await db.init(); });
test.after(async () => {
  await satellites.shutdown();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('satellites — init runs with zero instances and returns', async () => {
  await satellites.init(); // should not throw
  assert.deepStrictEqual(satellites.loader.list(), []);
});

test('satellites — init re-runs after a satellite is created', async () => {
  await satellites.registry.createInstance({ slug: 'boot-1', name: 'Boot One', kind: 'test-kind' });
  await satellites.shutdown();
  await satellites.init();
  assert.ok(satellites.loader.list().includes('boot-1'));
});
```

- [ ] **Step 6: Run the boot test**

Run: `npm test -- tests/satellites/boot.test.js`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add server.js .gitignore data/satellites/README.md data/satellites/.gitkeep tests/satellites/boot.test.js
git commit -m "feat(satellites): boot wiring + data/satellites README and gitignore scoping"
```

---

## Task 15: End-to-end integration test covering the §17 success criteria

**Files:**
- Create: `tests/satellites/e2e.test.js`

- [ ] **Step 1: Write the end-to-end test**

```javascript
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-sat-e2e-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');
process.env.MOTHERSHIP_SATELLITES_DIR = path.join(tmpRoot, 'satellites');
process.env.MOTHERSHIP_KINDS_DIR = path.join(__dirname, '..', 'fixtures', 'satellite-kinds');
fs.mkdirSync(process.env.MOTHERSHIP_SATELLITES_DIR, { recursive: true });

const db = require('../../src/database');
const satellites = require('../../src/satellites');
const { SovereigntyViolation, VisibilityViolation } = require('../../src/satellites/sovereignty');

test.before(async () => { await db.init(); await satellites.init(); });
test.after(async () => {
  await satellites.shutdown();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

test('e2e — draft → satellite → directive → applied', async () => {
  // 1. Create draft
  satellites.drafts.create({ slug: 'e2e-draft', name: 'E2E Draft', kind: 'test-kind' });

  // 2. Link a chat turn by metadata
  db.addMessage('We should build an E2E satellite', 'dashboard', 'uncategorized', { draft_slug: 'e2e-draft' });

  // 3. Verify linked message retrieval
  const { draft, messages } = satellites.drafts.getDraftWithMessages('e2e-draft');
  assert.strictEqual(draft.slug, 'e2e-draft');
  assert.strictEqual(messages.length, 1);

  // 4. Promote draft to satellite
  const { id } = await satellites.registry.createInstance({
    slug: 'e2e-sat', name: 'E2E Sat', kind: 'test-kind'
  });
  satellites.drafts.linkToSatellite('e2e-draft', id);
  assert.strictEqual(satellites.drafts.getBySlug('e2e-draft').status, 'created');

  // 5. Register in loader
  await satellites.loader.register('e2e-sat');
  const entry = satellites.loader.get('e2e-sat');
  assert.ok(entry);

  // 6. Sovereignty: writes blocked
  assert.throws(
    () => entry.db.run("INSERT INTO satellite_meta (key, value) VALUES ('x', '1')"),
    SovereigntyViolation
  );

  // 7. Issue a config.set directive
  satellites.directives.issue('e2e-sat', {
    kind: 'config.set',
    payload: { key: 'greeting', value: 'howdy' },
    issuedBy: 'e2e'
  });
  await sleep(500);

  // 8. Assert applied
  const applied = fs.readdirSync(path.join(process.env.MOTHERSHIP_SATELLITES_DIR, 'e2e-sat', 'directives', 'applied'));
  assert.strictEqual(applied.length, 1);
  const histRow = entry.db.exec("SELECT status FROM satellite_directives_history WHERE kind='config.set'")[0];
  assert.strictEqual(histRow.values[0][0], 'applied');
  const metaRow = entry.db.exec("SELECT value FROM satellite_meta WHERE key='greeting'")[0];
  assert.strictEqual(JSON.parse(metaRow.values[0][0]), 'howdy');

  // 9. Change visibility to limited, re-read
  await satellites.registry.setVisibility('e2e-sat', 'limited');
  const refreshed = satellites.loader.get('e2e-sat');
  refreshed.db.exec('SELECT * FROM satellite_meta'); // ok
  assert.throws(
    () => refreshed.db.exec('SELECT * FROM test_widgets'),
    VisibilityViolation
  );

  // 10. Archive and verify unload
  await satellites.registry.archive('e2e-sat');
  assert.strictEqual(satellites.loader.get('e2e-sat'), undefined);
  assert.strictEqual(satellites.registry.getBySlug('e2e-sat').status, 'archived');

  // 11. Unarchive and verify reload
  await satellites.registry.unarchive('e2e-sat');
  assert.ok(satellites.loader.get('e2e-sat'));
});
```

- [ ] **Step 2: Run the test**

Run: `npm test -- tests/satellites/e2e.test.js`
Expected: PASS (1 test, 11 assertions inside).

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS — every new satellite test plus every pre-existing test.

- [ ] **Step 4: Commit**

```bash
git add tests/satellites/e2e.test.js
git commit -m "test(satellites): end-to-end draft → satellite → directive flow"
```

---

## Task 16: Success-criteria checklist walk-through and manual smoke test

**Files:** none modified — this is a verification pass.

- [ ] **Step 1: Walk the §17 success criteria from the spec**

Confirm each is green:

1. `satellites` and `satellite_drafts` tables exist — verified by Task 2 test.
2. `POST /api/satellites` produces a valid folder, bootable DB, in-memory handle — verified by Tasks 6, 7, 13.
3. Boot-time loader registers active satellites and marks broken ones — verified by Task 7.
4. `config.set` directive applied end-to-end — verified by Tasks 8, 15.
5. `INSERT` via wrapper throws `SovereigntyViolation` — verified by Task 5.
6. `SELECT` on non-meta table under `limited` throws `VisibilityViolation` — verified by Task 5.
7. Draft → linked turns → `GET /api/satellites/drafts/:slug` returns linked messages — verified by Tasks 10, 13.
8. Draft promoted via `from_draft_slug` updates `status='created'` + `created_satellite_id` — verified by Task 13.
9. All integration tests pass — verified by Task 15.
10. No UI, no auth, no bot routing shipped — visual inspection of diff.

- [ ] **Step 2: Manual server smoke test**

In a terminal:
```bash
ANTHROPIC_API_KEY=dummy npm start &
sleep 2
curl -s http://localhost:3000/api/satellites | head
curl -s -X POST http://localhost:3000/api/satellites/drafts -H 'content-type: application/json' -d '{"slug":"smoke","name":"Smoke Draft","kind":"test-kind"}'
curl -s http://localhost:3000/api/satellites/drafts/smoke
kill %1
```

Expected: no crashes, endpoints respond with JSON.

Note: smoke test requires `src/satellite-kinds/test-kind/` to exist OR `MOTHERSHIP_KINDS_DIR` env var pointing at the fixture dir. The smoke test is best run with:
```bash
MOTHERSHIP_KINDS_DIR=./tests/fixtures/satellite-kinds ANTHROPIC_API_KEY=dummy npm start
```
Alternatively, accept that real kinds ship in #7 and skip the satellite-creation part of the smoke test — the draft endpoints don't need a kind to exist.

- [ ] **Step 3: Verify the public/index.html change is still uncommitted and untouched**

Run: `git status --short`
Expected: ` M public/index.html` (only that file; everything else committed).

- [ ] **Step 4: Final commit or no-op**

If any minor fix-ups were needed during the walk-through, commit them:
```bash
git add -u
git commit -m "chore(satellites): polish from success-criteria walkthrough"
```

Otherwise, no commit.

---

## Self-review summary

**Spec coverage check:**
- §4 architecture → Tasks 7, 12, 14
- §5 data model (core + baseline) → Tasks 2, 6
- §6 kind module interface → Tasks 4
- §7 lifecycle (create/archive/transfer) → Tasks 6, 9, 13
- §8 directive protocol → Task 8
- §9 drafts + chat linking → Tasks 10, 11, 13
- §10 visibility → Tasks 5, 9
- §11 mirror convention → Task 11
- §12 API surface → Task 13
- §13 file manifest → Tasks 3–14
- §14 error handling → covered across all tasks (rollback in 6, broken in 7, rejected in 8)
- §15 testing strategy → Tasks 5, 6, 7, 8, 9, 10, 13, 15
- §17 success criteria → Task 16

**Known trade-offs:**
- The sovereignty wrapper uses regex-based SQL classification, not a parser. Good enough for trusted internal callers; not a defense against adversarial SQL. The spec explicitly says this is module-boundary enforcement, not runtime reflection.
- `satellite_drafts.created_satellite_id` has no enforced FK at the DB level because sql.js does not enable foreign keys by default and changing that PRAGMA would affect unrelated tables. Application-level integrity only.
- Baseline SQL lives as a string constant in `registry.js` rather than as a separate `.sql` file. This is simpler but means schema changes ship via JS edit rather than migration files. Acceptable for #1; migration support is a deferred concern per the spec (`schema.migrate` directive is specified but not implemented).
- The drafts `regenerateBrief` path calls `conversation.respond()` with a prompt that doesn't use any special system override — it piggybacks on the existing system prompt. If Yoel wants a cleaner brief-only prompt, add a dedicated Claude call in a later sub-project.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-13-satellite-model-and-registry.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
