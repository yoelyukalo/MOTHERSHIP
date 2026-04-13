# Quantum Mirror v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static JSON Quantum Mirror with a dynamic, semantically-retrieved memory system that grows from every conversation and ingestion, synthesizes a wiki knowledge base, and exports to Obsidian with weekly self-reflection.

**Architecture:** Two new SQLite tables (`mirror_entries`, `wiki_entries`) store per-row self-knowledge and world-knowledge with embeddings as BLOBs. An embedding engine (OpenAI `text-embedding-3-small`, 1536 dims) generates vectors at write time. A retriever does brute-force cosine similarity at query time and injects top-k results into the conversation system prompt, replacing the current static JSON dump. Post-response and post-ingestion hooks trigger Claude-driven synthesis. A scheduled health-check scans for contradictions, decays stale entries, and exports reports to Obsidian.

**Tech Stack:** Node.js, sql.js (WASM SQLite), `@anthropic-ai/sdk` (synthesis), `openai` (embeddings — already a dep), `node:test` (built-in test runner, zero new deps), existing `uuid`/`dotenv`.

---

## Architectural Decisions (Locked)

- **Embedding provider:** OpenAI `text-embedding-3-small` (1536 dims). Rationale: `openai` is already in `package.json`, cheap (~$0.02 / 1M tokens), fast, no native deps. Swappable via adapter in `src/memory/embeddings.js`.
- **Storage format:** `Float32Array.buffer → Buffer` for BLOB columns. sql.js accepts `Uint8Array` for BLOB binds.
- **Similarity:** Brute-force cosine in JS. At <100k entries it's sub-millisecond; revisit if we cross that threshold.
- **Test framework:** `node:test` + `node:assert` (built-in since Node 18). Zero new deps, aligns with CLAUDE.md's "no native compilation" rule.
- **Scheduler:** `setInterval` on boot for weekly health check. No `node-cron` dep.
- **Obsidian vault path:** `OBSIDIAN_VAULT_PATH` env var. If unset, export is skipped (graceful).
- **Migration strategy:** On first boot after deploy, if `mirror_entries` is empty and the legacy `config.quantum_mirror` JSON exists, migrate rows and keep the old JSON as backup for one release cycle.
- **Superseding, not deleting:** Mirror entries are immutable; updates write a new row and set `superseded_by` on the old one. Retrieval filters `WHERE superseded_by IS NULL`.
- **Conversation usage budget:** Retriever injects top-5 mirror + top-5 wiki entries by default (configurable via `MIRROR_TOPK` / `WIKI_TOPK`).

## File Structure

```
src/
├── database.js                  MODIFY — add mirror_entries + wiki_entries tables, add CRUD helpers
├── mirror.js                    KEEP (legacy API) — back it with the new table via shim in Task 15
├── conversation.js              MODIFY (Task 13) — swap static prompt injection for retriever
├── memory/
│   ├── embeddings.js            CREATE — generate, serialize, deserialize, cosine similarity
│   ├── vector-engine.js         CREATE — write-time embedding + store, query-time retrieval
│   ├── retriever.js             CREATE — query orchestrator, returns top-k mirror + wiki
│   └── synthesis-prompts.js     CREATE — prompt templates for Claude synthesis calls
├── quantum-mirror.js            CREATE — dynamic mirror read/write (replaces mirror.js internals)
├── synthesizer.js               CREATE — wiki synthesis from ingested content
├── conversation-hooks.js        CREATE — pre/post-response + post-ingestion wiring
├── health-check.js              CREATE — contradiction scan, confidence decay, gap analysis
├── exporters/
│   └── obsidian.js              CREATE — markdown + wikilinks + frontmatter export
└── routes/
    └── api.js                   MODIFY — new endpoints for mirror_entries, wiki, export, healthcheck

server.js                        MODIFY — boot sequence: init new tables, schedule health check
telegram.js                      MODIFY — wire post-response + post-ingestion hooks, add /export /mirror /briefing commands
.env.example                     MODIFY — add OPENAI_API_KEY, EMBEDDING_MODEL, OBSIDIAN_VAULT_PATH, HEALTH_CHECK_INTERVAL_HOURS

tests/
├── memory/
│   ├── embeddings.test.js       CREATE
│   ├── vector-engine.test.js    CREATE
│   └── retriever.test.js        CREATE
├── quantum-mirror.test.js       CREATE
├── synthesizer.test.js          CREATE
├── health-check.test.js         CREATE
└── exporters/
    └── obsidian.test.js         CREATE
```

## Testing Strategy

- Unit tests use `node:test` + `node:assert`, run via `npm test` (add script).
- Embedding tests use a **fake embedder** injected via constructor — no real API calls in tests. Deterministic `Float32Array` inputs verify cosine math.
- DB tests spin up an in-memory sql.js instance per test (no file I/O).
- Claude-synthesis tests mock the Anthropic client.
- Integration test at end of each phase runs `node server.js --selftest` which loads everything, runs one synthesis round on a fixture, and exits.

---

## Phase 1 — Foundation tables & test scaffolding

### Task 1: Add `npm test` script and smoke test

**Files:**
- Modify: `package.json`
- Create: `tests/smoke.test.js`

- [ ] **Step 1: Add test script**

Edit `package.json`:

```json
"scripts": {
  "start": "node server.js",
  "dev": "node server.js --dev",
  "test": "node --test tests/**/*.test.js"
}
```

- [ ] **Step 2: Write smoke test**

Create `tests/smoke.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

test('smoke — node:test is wired', () => {
  assert.strictEqual(1 + 1, 2);
});
```

- [ ] **Step 3: Run test**

Run: `npm test`
Expected: `tests 1 / pass 1 / fail 0`

- [ ] **Step 4: Commit**

```bash
git add package.json tests/smoke.test.js
git commit -m "test: wire node:test runner with smoke test"
```

### Task 2: `mirror_entries` table migration

**Files:**
- Modify: `src/database.js` (add table DDL in `init`, add helpers at bottom)
- Create: `tests/database-mirror-entries.test.js`

- [ ] **Step 1: Write failing test for mirror_entries CRUD**

Create `tests/database-mirror-entries.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

// Use a temp DB file per run so tests don't stomp production data.
const tmpDb = path.join(__dirname, `.tmp-mirror-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');

test('mirror_entries table — insert and fetch', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });

  const id = db.addMirrorEntry({
    category: 'mental_models',
    content: 'Prefers first-principles reasoning',
    confidence: 0.9,
    source_type: 'conversation',
    source_id: 'abc-123',
    embedding: Buffer.alloc(1536 * 4) // zero-filled float32
  });

  assert.ok(id);
  const rows = db.getMirrorEntries({ category: 'mental_models' });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].content, 'Prefers first-principles reasoning');
  assert.ok(rows[0].embedding instanceof Uint8Array);
  assert.strictEqual(rows[0].embedding.length, 1536 * 4);
  assert.strictEqual(rows[0].superseded_by, null);
});

test('mirror_entries — supersede returns new id and hides old', async () => {
  const db = require('../src/database');
  const oldId = db.addMirrorEntry({
    category: 'preferences',
    content: 'Likes dark mode',
    confidence: 0.6,
    source_type: 'conversation',
    source_id: 'x',
    embedding: Buffer.alloc(1536 * 4)
  });
  const newId = db.supersedeMirrorEntry(oldId, {
    category: 'preferences',
    content: 'Likes dark mode except for PDFs',
    confidence: 0.8,
    source_type: 'conversation',
    source_id: 'y',
    embedding: Buffer.alloc(1536 * 4)
  });
  const active = db.getMirrorEntries({ category: 'preferences', activeOnly: true });
  assert.strictEqual(active.length, 1);
  assert.strictEqual(active[0].id, newId);
});
```

- [ ] **Step 2: Run test — should fail (function missing)**

Run: `npm test -- tests/database-mirror-entries.test.js`
Expected: FAIL — `db.addMirrorEntry is not a function`

- [ ] **Step 3: Add table DDL and CRUD to database.js**

In `src/database.js`, make `DB_PATH` honor the env var (so tests can redirect):

```js
const DB_PATH = process.env.MOTHERSHIP_DB_PATH || path.join(__dirname, '..', 'data', 'mothership.db');
```

Inside `init()`, after the existing `CREATE TABLE` calls, add:

```js
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
```

Append CRUD helpers before `module.exports`:

```js
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

function updateMirrorEntryConfidence(id, newConfidence) {
  db.run(
    `UPDATE mirror_entries SET confidence = ?, updated_at = datetime('now') WHERE id = ?`,
    [newConfidence, id]
  );
  save();
}
```

Add to `module.exports`:

```js
addMirrorEntry, getMirrorEntries, supersedeMirrorEntry, updateMirrorEntryConfidence,
```

- [ ] **Step 4: Run tests — should pass**

Run: `npm test -- tests/database-mirror-entries.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/database.js tests/database-mirror-entries.test.js
git commit -m "feat(db): add mirror_entries table with supersede semantics"
```

### Task 3: `wiki_entries` table migration

**Files:**
- Modify: `src/database.js`
- Create: `tests/database-wiki-entries.test.js`

- [ ] **Step 1: Write failing test**

Create `tests/database-wiki-entries.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-wiki-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');

test('wiki_entries — insert, fetch, update', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });

  const id = db.addWikiEntry({
    topic: 'RAG architecture',
    summary: 'Retrieval-augmented generation patterns',
    source_ids: ['msg-1', 'msg-2'],
    tags: ['ai', 'architecture'],
    embedding: Buffer.alloc(1536 * 4)
  });

  const rows = db.getWikiEntries({ topic: 'RAG architecture' });
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0].source_ids, ['msg-1', 'msg-2']);
  assert.deepStrictEqual(rows[0].tags, ['ai', 'architecture']);

  db.updateWikiEntry(id, {
    summary: 'Updated summary',
    source_ids: ['msg-1', 'msg-2', 'msg-3'],
    tags: ['ai', 'architecture', 'retrieval'],
    embedding: Buffer.alloc(1536 * 4)
  });
  const updated = db.getWikiEntries({ topic: 'RAG architecture' })[0];
  assert.strictEqual(updated.summary, 'Updated summary');
  assert.strictEqual(updated.source_ids.length, 3);
});
```

- [ ] **Step 2: Run test, confirm fail**

Run: `npm test -- tests/database-wiki-entries.test.js`
Expected: FAIL — `db.addWikiEntry is not a function`

- [ ] **Step 3: Add table + helpers**

In `src/database.js` `init()`, add after the `mirror_entries` DDL:

```js
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
```

Append helpers:

```js
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
```

Add to exports: `addWikiEntry, getWikiEntries, getAllWikiEntries, updateWikiEntry`.

- [ ] **Step 4: Run test — pass**

Run: `npm test -- tests/database-wiki-entries.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/database.js tests/database-wiki-entries.test.js
git commit -m "feat(db): add wiki_entries table with topic uniqueness"
```

---

## Phase 2 — Embedding engine

### Task 4: `src/memory/embeddings.js` — serialization + cosine math

**Files:**
- Create: `src/memory/embeddings.js`
- Create: `tests/memory/embeddings.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/memory/embeddings.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const emb = require('../../src/memory/embeddings');

test('serialize/deserialize round-trip preserves values', () => {
  const v = new Float32Array([0.1, -0.2, 0.3, 0.4, 0.5]);
  const buf = emb.toBuffer(v);
  const out = emb.fromBuffer(buf);
  assert.strictEqual(out.length, 5);
  for (let i = 0; i < 5; i++) {
    assert.ok(Math.abs(out[i] - v[i]) < 1e-6);
  }
});

test('cosineSimilarity — identical vectors = 1', () => {
  const a = new Float32Array([1, 2, 3]);
  const b = new Float32Array([1, 2, 3]);
  assert.ok(Math.abs(emb.cosineSimilarity(a, b) - 1) < 1e-6);
});

test('cosineSimilarity — orthogonal = 0', () => {
  const a = new Float32Array([1, 0]);
  const b = new Float32Array([0, 1]);
  assert.ok(Math.abs(emb.cosineSimilarity(a, b)) < 1e-6);
});

test('cosineSimilarity — opposite = -1', () => {
  const a = new Float32Array([1, 0]);
  const b = new Float32Array([-1, 0]);
  assert.ok(Math.abs(emb.cosineSimilarity(a, b) + 1) < 1e-6);
});

test('generateEmbedding uses injected client and returns Float32Array', async () => {
  const fakeClient = {
    embeddings: {
      create: async ({ input }) => ({
        data: [{ embedding: new Array(1536).fill(0.01) }]
      })
    }
  };
  const vec = await emb.generateEmbedding('hello world', { client: fakeClient, model: 'fake' });
  assert.ok(vec instanceof Float32Array);
  assert.strictEqual(vec.length, 1536);
  assert.ok(Math.abs(vec[0] - 0.01) < 1e-6);
});

test('findRelevant — returns top-k by similarity score', () => {
  const query = new Float32Array([1, 0, 0]);
  const candidates = [
    { id: 'a', vec: new Float32Array([1, 0, 0]) },     // 1.0
    { id: 'b', vec: new Float32Array([0.7, 0.7, 0]) }, // ~0.7
    { id: 'c', vec: new Float32Array([0, 1, 0]) },     // 0
    { id: 'd', vec: new Float32Array([-1, 0, 0]) }     // -1
  ];
  const results = emb.findRelevant(query, candidates, 2);
  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].id, 'a');
  assert.strictEqual(results[1].id, 'b');
  assert.ok(results[0].score > results[1].score);
});
```

- [ ] **Step 2: Run tests — fail**

Run: `npm test -- tests/memory/embeddings.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the module**

Create `src/memory/embeddings.js`:

```js
/**
 * MOTHERSHIP — Embedding engine
 *
 * Pure-JS wrappers around embedding generation, serialization for SQLite BLOB
 * storage, and cosine similarity. Provider is OpenAI text-embedding-3-small
 * by default; swappable by passing a `client` into generateEmbedding.
 */

const OpenAI = require('openai');

const MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
const DIMS = parseInt(process.env.EMBEDDING_DIMS || '1536', 10);

let defaultClient = null;
function getDefaultClient() {
  if (defaultClient) return defaultClient;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set — required for embeddings');
  defaultClient = new OpenAI({ apiKey });
  return defaultClient;
}

function toBuffer(float32) {
  if (!(float32 instanceof Float32Array)) {
    throw new TypeError('toBuffer expects Float32Array');
  }
  return Buffer.from(float32.buffer, float32.byteOffset, float32.byteLength);
}

function fromBuffer(buf) {
  if (!buf) return null;
  const view = buf instanceof Buffer ? buf : Buffer.from(buf);
  return new Float32Array(view.buffer, view.byteOffset, view.byteLength / 4);
}

async function generateEmbedding(text, { client, model = MODEL } = {}) {
  if (!text || typeof text !== 'string') {
    throw new TypeError('generateEmbedding requires a non-empty string');
  }
  const c = client || getDefaultClient();
  const res = await c.embeddings.create({ model, input: text.slice(0, 8000) });
  const arr = res.data[0].embedding;
  return new Float32Array(arr);
}

function cosineSimilarity(a, b) {
  if (a.length !== b.length) throw new Error('Vector length mismatch');
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Score candidates against a query vector and return the top-k.
 * @param {Float32Array} query
 * @param {Array<{id: string, vec: Float32Array, [key: string]: any}>} candidates
 * @param {number} k
 * @returns {Array<{id: string, score: number, [key: string]: any}>}
 */
function findRelevant(query, candidates, k = 5) {
  const scored = candidates.map(c => ({
    ...c,
    score: cosineSimilarity(query, c.vec)
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

module.exports = {
  DIMS, MODEL,
  generateEmbedding, toBuffer, fromBuffer,
  cosineSimilarity, findRelevant
};
```

- [ ] **Step 4: Run tests — pass**

Run: `npm test -- tests/memory/embeddings.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/memory/embeddings.js tests/memory/embeddings.test.js
git commit -m "feat(memory): embedding engine with cosine similarity and BLOB serialization"
```

### Task 5: `src/memory/vector-engine.js` — write-time embedding & query-time retrieval

**Files:**
- Create: `src/memory/vector-engine.js`
- Create: `tests/memory/vector-engine.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/memory/vector-engine.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-ve-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../../src/database');
const ve = require('../../src/memory/vector-engine');
const emb = require('../../src/memory/embeddings');

// Fake embedder: maps a few keywords to deterministic 4-dim vectors for
// easy top-k assertions. Overrides DIMS via monkey-patch.
const fakeEmbeddings = {
  'rust is fast': new Float32Array([1, 0, 0, 0]),
  'go is pragmatic': new Float32Array([0, 1, 0, 0]),
  'python is flexible': new Float32Array([0, 0, 1, 0]),
  'query: systems languages': new Float32Array([0.9, 0.4, 0, 0])
};
const fakeClient = {
  embeddings: {
    create: async ({ input }) => {
      const vec = fakeEmbeddings[input];
      if (!vec) throw new Error(`no fake for: ${input}`);
      return { data: [{ embedding: Array.from(vec) }] };
    }
  }
};

test('vector-engine — store & retrieve mirror entries by similarity', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });

  ve._setClient(fakeClient); // test hook

  await ve.storeMirrorEntry({
    category: 'preferences',
    content: 'rust is fast',
    confidence: 0.9,
    source_type: 'conversation',
    source_id: 'm1'
  });
  await ve.storeMirrorEntry({
    category: 'preferences',
    content: 'go is pragmatic',
    confidence: 0.8,
    source_type: 'conversation',
    source_id: 'm2'
  });
  await ve.storeMirrorEntry({
    category: 'preferences',
    content: 'python is flexible',
    confidence: 0.7,
    source_type: 'conversation',
    source_id: 'm3'
  });

  const results = await ve.searchMirror('query: systems languages', { topK: 2 });
  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].content, 'rust is fast');
  assert.strictEqual(results[1].content, 'go is pragmatic');
  assert.ok(results[0].score > results[1].score);
});

test('vector-engine — store & retrieve wiki entries by similarity', async () => {
  await ve.storeWikiEntry({
    topic: 'Rust',
    summary: 'rust is fast',
    source_ids: ['msg-a'],
    tags: ['language']
  });
  await ve.storeWikiEntry({
    topic: 'Go',
    summary: 'go is pragmatic',
    source_ids: ['msg-b'],
    tags: ['language']
  });

  const results = await ve.searchWiki('query: systems languages', { topK: 1 });
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].topic, 'Rust');
});
```

- [ ] **Step 2: Run test — fail**

Run: `npm test -- tests/memory/vector-engine.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement vector-engine**

Create `src/memory/vector-engine.js`:

```js
/**
 * MOTHERSHIP — Vector engine
 *
 * Bridges the embedding module and the database. Write-time: embed + store.
 * Query-time: embed + cosine search across stored vectors.
 */

const db = require('../database');
const emb = require('./embeddings');

let injectedClient = null;
function _setClient(client) { injectedClient = client; } // test hook

function clientOpts() {
  return injectedClient ? { client: injectedClient } : {};
}

async function storeMirrorEntry(entry) {
  const vec = await emb.generateEmbedding(entry.content, clientOpts());
  const id = db.addMirrorEntry({
    ...entry,
    embedding: emb.toBuffer(vec)
  });
  return id;
}

async function supersedeMirrorEntry(oldId, newEntry) {
  const vec = await emb.generateEmbedding(newEntry.content, clientOpts());
  return db.supersedeMirrorEntry(oldId, {
    ...newEntry,
    embedding: emb.toBuffer(vec)
  });
}

async function storeWikiEntry(entry) {
  const vec = await emb.generateEmbedding(`${entry.topic}: ${entry.summary}`, clientOpts());
  const id = db.addWikiEntry({
    ...entry,
    embedding: emb.toBuffer(vec)
  });
  return id;
}

async function updateWikiEntry(id, updates) {
  let embeddingBuf = null;
  if (updates.summary || updates.topic) {
    const text = `${updates.topic || ''}: ${updates.summary || ''}`.trim();
    const vec = await emb.generateEmbedding(text, clientOpts());
    embeddingBuf = emb.toBuffer(vec);
  }
  db.updateWikiEntry(id, { ...updates, embedding: embeddingBuf });
}

async function searchMirror(query, { topK = 5, category = null } = {}) {
  const qVec = await emb.generateEmbedding(query, clientOpts());
  const rows = db.getMirrorEntries({ category, activeOnly: true, limit: 5000 });
  const candidates = rows
    .filter(r => r.embedding)
    .map(r => ({ ...r, vec: emb.fromBuffer(r.embedding) }));
  return emb.findRelevant(qVec, candidates, topK);
}

async function searchWiki(query, { topK = 5 } = {}) {
  const qVec = await emb.generateEmbedding(query, clientOpts());
  const rows = db.getAllWikiEntries();
  const candidates = rows
    .filter(r => r.embedding)
    .map(r => ({ ...r, vec: emb.fromBuffer(r.embedding) }));
  return emb.findRelevant(qVec, candidates, topK);
}

module.exports = {
  storeMirrorEntry, supersedeMirrorEntry,
  storeWikiEntry, updateWikiEntry,
  searchMirror, searchWiki,
  _setClient
};
```

- [ ] **Step 4: Run tests — pass**

Run: `npm test -- tests/memory/vector-engine.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/memory/vector-engine.js tests/memory/vector-engine.test.js
git commit -m "feat(memory): vector-engine — write/read with embedding pipeline"
```

---

## Phase 3 — Core intelligence

### Task 6: `src/memory/retriever.js` — unified context retrieval

**Files:**
- Create: `src/memory/retriever.js`
- Create: `tests/memory/retriever.test.js`

- [ ] **Step 1: Write failing test**

Create `tests/memory/retriever.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-ret-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../../src/database');
const ve = require('../../src/memory/vector-engine');
const retriever = require('../../src/memory/retriever');

const fakeEmb = {
  'thinks in systems': new Float32Array([1, 0, 0]),
  'likes first principles': new Float32Array([0.9, 0.1, 0]),
  'rag is retrieval augmented generation': new Float32Array([0, 1, 0]),
  'how do i build a rag pipeline': new Float32Array([0.1, 0.95, 0])
};
const fakeClient = {
  embeddings: {
    create: async ({ input }) => ({ data: [{ embedding: Array.from(fakeEmb[input] || new Float32Array([0, 0, 0])) }] })
  }
};

test('retriever — returns block with mirror + wiki sections', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });

  ve._setClient(fakeClient);

  await ve.storeMirrorEntry({
    category: 'mental_models', content: 'thinks in systems',
    confidence: 0.9, source_type: 'conversation', source_id: 'x'
  });
  await ve.storeMirrorEntry({
    category: 'mental_models', content: 'likes first principles',
    confidence: 0.85, source_type: 'conversation', source_id: 'y'
  });
  await ve.storeWikiEntry({
    topic: 'RAG',
    summary: 'rag is retrieval augmented generation',
    source_ids: ['z'], tags: ['ai']
  });

  const block = await retriever.buildContextBlock('how do i build a rag pipeline', { mirrorTopK: 2, wikiTopK: 1 });

  assert.ok(block.includes('## Mirror'));
  assert.ok(block.includes('## Wiki'));
  assert.ok(block.includes('thinks in systems') || block.includes('likes first principles'));
  assert.ok(block.includes('RAG'));
});
```

- [ ] **Step 2: Run — fail**

Run: `npm test -- tests/memory/retriever.test.js`
Expected: FAIL

- [ ] **Step 3: Implement retriever**

Create `src/memory/retriever.js`:

```js
/**
 * MOTHERSHIP — Retrieval orchestrator
 *
 * Single entry point for "give me the top-k most relevant mirror + wiki
 * entries for this query" and format them into a system-prompt block.
 */

const ve = require('./vector-engine');

async function retrieve(query, { mirrorTopK = 5, wikiTopK = 5 } = {}) {
  const [mirror, wiki] = await Promise.all([
    ve.searchMirror(query, { topK: mirrorTopK }),
    ve.searchWiki(query, { topK: wikiTopK })
  ]);
  return { mirror, wiki };
}

function formatMirrorSection(entries) {
  if (!entries.length) return '';
  const byCat = new Map();
  for (const e of entries) {
    if (!byCat.has(e.category)) byCat.set(e.category, []);
    byCat.get(e.category).push(e);
  }
  const lines = ['## Mirror — what I know about Yoel (most relevant to this turn)'];
  for (const [cat, list] of byCat) {
    lines.push(`### ${cat}`);
    for (const e of list) {
      lines.push(`- (${e.confidence.toFixed(2)}) ${e.content}`);
    }
  }
  return lines.join('\n');
}

function formatWikiSection(entries) {
  if (!entries.length) return '';
  const lines = ['## Wiki — knowledge Mothership has synthesized (most relevant to this turn)'];
  for (const e of entries) {
    lines.push(`### ${e.topic}`);
    lines.push(e.summary);
  }
  return lines.join('\n');
}

async function buildContextBlock(query, opts = {}) {
  const { mirror, wiki } = await retrieve(query, opts);
  return [formatMirrorSection(mirror), formatWikiSection(wiki)].filter(Boolean).join('\n\n');
}

module.exports = { retrieve, buildContextBlock, formatMirrorSection, formatWikiSection };
```

- [ ] **Step 4: Run — pass**

Run: `npm test -- tests/memory/retriever.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory/retriever.js tests/memory/retriever.test.js
git commit -m "feat(memory): retriever orchestrator for mirror+wiki context blocks"
```

### Task 7: `src/memory/synthesis-prompts.js` — prompt templates

**Files:**
- Create: `src/memory/synthesis-prompts.js`

Rationale: Keep prompts in one place so they can be versioned and diffed.

- [ ] **Step 1: Create the module (no test — pure string data)**

```js
/**
 * MOTHERSHIP — Synthesis prompt templates
 *
 * All Claude-directed synthesis prompts live here so Phase 5 (self-improvement)
 * can version and A/B them.
 */

const MIRROR_SYNTHESIS = ({ existing, turn }) => `
You are helping Mothership build and maintain its cognitive profile of Yoel.

Here are the currently-active mirror entries that might be relevant to the
interaction below. Each has a category, content, confidence, and ID:

${existing.length ? existing.map(e => `- [${e.id}] (${e.category}, conf=${e.confidence}) ${e.content}`).join('\n') : '(none)'}

Here is the latest interaction (Yoel → Mothership):

${turn}

Based ONLY on this interaction, decide whether any of the following should
happen, and output STRICT JSON matching this schema:

{
  "new_entries": [{"category": string, "content": string, "confidence": number}],
  "supersede": [{"old_id": string, "new_content": string, "new_confidence": number}],
  "contradictions": [{"entry_id": string, "note": string}]
}

Categories MUST be one of: mental_models, preferences, knowledge_levels, active_projects, decisions, patterns, contradictions, goals.

Rules:
- If the interaction reveals nothing meaningful about Yoel, return empty arrays.
- Confidence is 0.0-1.0; use <=0.5 for soft hints, >=0.8 for clear statements.
- Only supersede an existing entry if the new observation genuinely refines or contradicts it.
- Content should be a single declarative sentence about Yoel, not about the conversation.

Output ONLY the JSON object, no prose.`;

const WIKI_SYNTHESIS = ({ existingTopics, mirrorSnapshot, content }) => `
You are helping Mothership synthesize knowledge from content Yoel has ingested.

Yoel's profile (used to prioritize what matters):
${mirrorSnapshot}

Existing wiki topics (reuse these before creating new ones):
${existingTopics.length ? existingTopics.map(t => `- ${t}`).join('\n') : '(none yet)'}

New content to process:
${content}

Output STRICT JSON:

{
  "topics": [
    {
      "topic": string,           // reuse existing if close match
      "mode": "create" | "merge",
      "summary": string,         // full summary (replaces existing if merge)
      "tags": string[]
    }
  ]
}

Rules:
- Prefer merging into existing topics over creating new ones.
- Frame summaries through the lens of Yoel's profile — highlight what matters to him.
- 1-5 topics max per call.
- Output ONLY the JSON object.`;

const HEALTH_CONTRADICTIONS = ({ entries }) => `
Review the following mirror entries for contradictions, staleness, or merge
candidates. Output STRICT JSON:

{
  "contradictions": [{"entry_ids": string[], "note": string}],
  "merge_candidates": [{"entry_ids": string[], "suggested_content": string}]
}

Entries:
${entries.map(e => `- [${e.id}] (${e.category}, conf=${e.confidence}, ${e.updated_at}) ${e.content}`).join('\n')}

Output ONLY the JSON object.`;

const GAP_ANALYSIS = ({ mirror, wikiTopics }) => `
Based on Yoel's profile and current wiki state, identify knowledge gaps.

Profile:
${mirror}

Wiki topics:
${wikiTopics.join(', ') || '(none)'}

Output STRICT JSON:

{
  "knowledge_gaps": [{"gap": string, "why_it_matters": string}],
  "thin_mirror_categories": [{"category": string, "suggestion": string}]
}

Output ONLY the JSON object.`;

module.exports = { MIRROR_SYNTHESIS, WIKI_SYNTHESIS, HEALTH_CONTRADICTIONS, GAP_ANALYSIS };
```

- [ ] **Step 2: Commit**

```bash
git add src/memory/synthesis-prompts.js
git commit -m "feat(memory): synthesis prompt templates"
```

### Task 8: `src/quantum-mirror.js` — dynamic synthesis from conversations

**Files:**
- Create: `src/quantum-mirror.js`
- Create: `tests/quantum-mirror.test.js`

- [ ] **Step 1: Write failing test**

Create `tests/quantum-mirror.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-qm-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const ve = require('../src/memory/vector-engine');
const qm = require('../src/quantum-mirror');

const fakeEmbClient = {
  embeddings: { create: async () => ({ data: [{ embedding: new Array(3).fill(0.33) }] }) }
};

test('quantum-mirror — synthesizes new entries from a turn', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });
  ve._setClient(fakeEmbClient);

  const fakeAnthropic = {
    messages: {
      create: async () => ({
        content: [{
          type: 'text',
          text: JSON.stringify({
            new_entries: [
              { category: 'preferences', content: 'Prefers Rust for systems work', confidence: 0.85 }
            ],
            supersede: [],
            contradictions: []
          })
        }]
      })
    }
  };
  qm._setClient(fakeAnthropic);

  await qm.synthesizeFromTurn({
    userText: 'I want to build my next systems project in Rust',
    assistantText: 'Rust is a strong pick for that.',
    sourceId: 'turn-1'
  });

  const rows = db.getMirrorEntries({ category: 'preferences' });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].content, 'Prefers Rust for systems work');
});

test('quantum-mirror — handles supersede from synthesis', async () => {
  const fakeAnthropic = {
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: JSON.stringify({
          new_entries: [],
          supersede: [],
          contradictions: []
        }) }]
      })
    }
  };
  qm._setClient(fakeAnthropic);
  // Nothing should throw on empty synthesis
  await qm.synthesizeFromTurn({ userText: 'hi', assistantText: 'hi', sourceId: 't2' });
});
```

- [ ] **Step 2: Run — fail**

Run: `npm test -- tests/quantum-mirror.test.js`
Expected: FAIL

- [ ] **Step 3: Implement**

Create `src/quantum-mirror.js`:

```js
/**
 * MOTHERSHIP — Dynamic Quantum Mirror
 *
 * Replaces the static-JSON mirror. After each meaningful turn, asks Claude
 * to extract what was just learned about Yoel and writes rows into
 * mirror_entries via the vector engine.
 */

const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');
const ve = require('./memory/vector-engine');
const { MIRROR_SYNTHESIS } = require('./memory/synthesis-prompts');

const MODEL = process.env.SYNTHESIS_MODEL || 'claude-opus-4-6';
const MAX_TOKENS = 1200;

let client = null;
function _setClient(c) { client = c; } // test hook
function getClient() {
  if (client) return client;
  client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxRetries: 3,
    timeout: 120_000
  });
  return client;
}

function getExistingCandidates() {
  return db.getMirrorEntries({ activeOnly: true, limit: 200 })
    .map(r => ({ id: r.id, category: r.category, content: r.content, confidence: r.confidence }));
}

function parseJsonFromText(text) {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); }
  catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Synthesis returned non-JSON: ${trimmed.slice(0, 200)}`);
  }
}

async function synthesizeFromTurn({ userText, assistantText, sourceId }) {
  const turn = `USER: ${userText}\n\nMOTHERSHIP: ${assistantText}`;
  const existing = getExistingCandidates();
  const prompt = MIRROR_SYNTHESIS({ existing, turn });

  const c = getClient();
  const res = await c.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }]
  });
  const text = res.content.find(b => b.type === 'text')?.text || '{}';
  let parsed;
  try {
    parsed = parseJsonFromText(text);
  } catch (err) {
    db.log('warn', 'quantum-mirror', `synthesis parse failed: ${err.message}`, { text });
    return { created: 0, superseded: 0 };
  }

  let created = 0;
  for (const entry of parsed.new_entries || []) {
    try {
      await ve.storeMirrorEntry({
        category: entry.category,
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

  let superseded = 0;
  for (const s of parsed.supersede || []) {
    try {
      const old = db.getMirrorEntries({ activeOnly: true, limit: 10000 }).find(r => r.id === s.old_id);
      if (!old) continue;
      await ve.supersedeMirrorEntry(s.old_id, {
        category: old.category,
        content: s.new_content,
        confidence: s.new_confidence ?? old.confidence,
        source_type: 'conversation',
        source_id: sourceId
      });
      superseded++;
    } catch (err) {
      db.log('error', 'quantum-mirror', `supersede failed: ${err.message}`);
    }
  }

  db.log('info', 'quantum-mirror', `synthesis: +${created} new, ${superseded} superseded`);
  return { created, superseded };
}

module.exports = { synthesizeFromTurn, _setClient };
```

- [ ] **Step 4: Run — pass**

Run: `npm test -- tests/quantum-mirror.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/quantum-mirror.js tests/quantum-mirror.test.js
git commit -m "feat(mirror): dynamic synthesis from conversation turns"
```

### Task 9: `src/synthesizer.js` — wiki synthesis from ingested content

**Files:**
- Create: `src/synthesizer.js`
- Create: `tests/synthesizer.test.js`

- [ ] **Step 1: Write failing test**

Create `tests/synthesizer.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-syn-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const ve = require('../src/memory/vector-engine');
const syn = require('../src/synthesizer');

test('synthesizer — creates new wiki topic from content', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });
  ve._setClient({
    embeddings: { create: async () => ({ data: [{ embedding: new Array(3).fill(0.5) }] }) }
  });
  syn._setClient({
    messages: {
      create: async () => ({ content: [{ type: 'text', text: JSON.stringify({
        topics: [
          { topic: 'RAG architectures', mode: 'create',
            summary: 'Retrieval-augmented generation blends vector search with LLM generation.',
            tags: ['ai', 'architecture'] }
        ]
      }) }] })
    }
  });

  const result = await syn.synthesizeFromContent({
    content: 'Article about RAG pipelines...',
    sourceId: 'msg-1'
  });

  assert.strictEqual(result.created, 1);
  const rows = db.getWikiEntries({ topic: 'RAG architectures' });
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0].source_ids, ['msg-1']);
});

test('synthesizer — merges into existing topic', async () => {
  syn._setClient({
    messages: {
      create: async () => ({ content: [{ type: 'text', text: JSON.stringify({
        topics: [
          { topic: 'RAG architectures', mode: 'merge',
            summary: 'Updated summary with new insight about hybrid search.',
            tags: ['ai', 'architecture', 'hybrid-search'] }
        ]
      }) }] })
    }
  });

  const result = await syn.synthesizeFromContent({
    content: 'Another article with more detail...',
    sourceId: 'msg-2'
  });

  assert.strictEqual(result.merged, 1);
  const row = db.getWikiEntries({ topic: 'RAG architectures' })[0];
  assert.ok(row.summary.includes('hybrid search'));
  assert.deepStrictEqual(row.source_ids.sort(), ['msg-1', 'msg-2'].sort());
});
```

- [ ] **Step 2: Run — fail**

Run: `npm test -- tests/synthesizer.test.js`
Expected: FAIL

- [ ] **Step 3: Implement**

Create `src/synthesizer.js`:

```js
/**
 * MOTHERSHIP — Wiki Synthesizer
 *
 * After new content is ingested, ask Claude to distill it into wiki topics,
 * using the active mirror entries as a lens for what matters to Yoel.
 */

const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');
const ve = require('./memory/vector-engine');
const { WIKI_SYNTHESIS } = require('./memory/synthesis-prompts');

const MODEL = process.env.SYNTHESIS_MODEL || 'claude-opus-4-6';
const MAX_TOKENS = 1500;

let client = null;
function _setClient(c) { client = c; }
function getClient() {
  if (client) return client;
  client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 3, timeout: 120_000 });
  return client;
}

function parseJsonFromText(text) {
  try { return JSON.parse(text.trim()); }
  catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('non-JSON synthesis');
  }
}

function mirrorSnapshotForPrompt() {
  const rows = db.getMirrorEntries({ activeOnly: true, limit: 50 });
  if (!rows.length) return '(no profile yet)';
  const byCat = {};
  for (const r of rows) (byCat[r.category] ||= []).push(r.content);
  return Object.entries(byCat)
    .map(([k, v]) => `${k}: ${v.slice(0, 5).join('; ')}`)
    .join('\n');
}

async function synthesizeFromContent({ content, sourceId }) {
  const existingTopics = db.getAllWikiEntries().map(r => r.topic);
  const mirrorSnapshot = mirrorSnapshotForPrompt();
  const prompt = WIKI_SYNTHESIS({ existingTopics, mirrorSnapshot, content });

  const c = getClient();
  const res = await c.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }]
  });
  const text = res.content.find(b => b.type === 'text')?.text || '{}';

  let parsed;
  try { parsed = parseJsonFromText(text); }
  catch (err) {
    db.log('warn', 'synthesizer', `parse failed: ${err.message}`, { text });
    return { created: 0, merged: 0 };
  }

  let created = 0, merged = 0;
  for (const topic of parsed.topics || []) {
    const existing = db.getWikiEntries({ topic: topic.topic })[0];
    if (existing || topic.mode === 'merge') {
      const existingRow = existing || db.getWikiEntries({ topic: topic.topic })[0];
      if (!existingRow) {
        await ve.storeWikiEntry({
          topic: topic.topic,
          summary: topic.summary,
          source_ids: [sourceId],
          tags: topic.tags || []
        });
        created++;
        continue;
      }
      const mergedSources = Array.from(new Set([...(existingRow.source_ids || []), sourceId]));
      const mergedTags = Array.from(new Set([...(existingRow.tags || []), ...(topic.tags || [])]));
      await ve.updateWikiEntry(existingRow.id, {
        topic: topic.topic,
        summary: topic.summary,
        source_ids: mergedSources,
        tags: mergedTags
      });
      merged++;
    } else {
      await ve.storeWikiEntry({
        topic: topic.topic,
        summary: topic.summary,
        source_ids: [sourceId],
        tags: topic.tags || []
      });
      created++;
    }
  }

  db.log('info', 'synthesizer', `wiki synthesis: +${created} new, ${merged} merged`);
  return { created, merged };
}

module.exports = { synthesizeFromContent, _setClient };
```

- [ ] **Step 4: Run — pass**

Run: `npm test -- tests/synthesizer.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/synthesizer.js tests/synthesizer.test.js
git commit -m "feat(synthesis): wiki synthesizer with create/merge semantics"
```

---

## Phase 4 — Integration

### Task 10: Migrate legacy JSON mirror to `mirror_entries` rows

**Files:**
- Create: `src/migrate-legacy-mirror.js`
- Create: `tests/migrate-legacy-mirror.test.js`

- [ ] **Step 1: Write failing test**

```js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-mig-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const ve = require('../src/memory/vector-engine');
const migrate = require('../src/migrate-legacy-mirror');

test('migrate-legacy-mirror — converts JSON blob into rows', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });
  ve._setClient({
    embeddings: { create: async () => ({ data: [{ embedding: new Array(3).fill(0.1) }] }) }
  });

  db.setConfig('quantum_mirror', JSON.stringify({
    mental_models: [
      { name: 'First Principles', description: 'Break problems down to fundamentals.' }
    ],
    learning_style: {
      primary: 'visual-kinesthetic',
      preferences: [{ mode: 'By building', note: 'Learns by creating prototypes' }],
      avoid: ['Long lectures']
    },
    knowledge_graph: [
      { topic: 'AI / LLMs', level: 'advanced', notes: 'Deep practical knowledge' }
    ],
    resonance_log: []
  }));

  const count = await migrate.runIfNeeded();
  assert.ok(count > 0);

  const models = db.getMirrorEntries({ category: 'mental_models' });
  assert.ok(models.length >= 1);
  assert.ok(models[0].content.includes('First Principles'));
});

test('migrate-legacy-mirror — no-op if already migrated', async () => {
  const migrate = require('../src/migrate-legacy-mirror');
  const count = await migrate.runIfNeeded();
  assert.strictEqual(count, 0);
});
```

- [ ] **Step 2: Run — fail**

Run: `npm test -- tests/migrate-legacy-mirror.test.js`
Expected: FAIL

- [ ] **Step 3: Implement**

Create `src/migrate-legacy-mirror.js`:

```js
/**
 * MOTHERSHIP — One-time migration of legacy JSON mirror to mirror_entries rows.
 *
 * Runs on every boot; no-op if already done. Guarded by a config flag.
 */

const db = require('./database');
const ve = require('./memory/vector-engine');

const FLAG = 'mirror_migrated_to_rows';

async function runIfNeeded() {
  if (db.getConfig(FLAG) === '1') return 0;

  const raw = db.getConfig('quantum_mirror');
  if (!raw) {
    db.setConfig(FLAG, '1');
    return 0;
  }

  let legacy;
  try { legacy = JSON.parse(raw); }
  catch {
    db.log('warn', 'migrate-mirror', 'legacy JSON unparsable — skipping');
    db.setConfig(FLAG, '1');
    return 0;
  }

  let count = 0;
  for (const m of legacy.mental_models || []) {
    await ve.storeMirrorEntry({
      category: 'mental_models',
      content: `${m.name}: ${m.description}`,
      confidence: m.strength ?? 0.7,
      source_type: 'migration',
      source_id: `legacy:${m.id || m.name}`
    });
    count++;
  }
  if (legacy.learning_style) {
    const ls = legacy.learning_style;
    await ve.storeMirrorEntry({
      category: 'patterns',
      content: `Learning style is primarily ${ls.primary}.`,
      confidence: 0.7,
      source_type: 'migration',
      source_id: 'legacy:learning_style'
    });
    count++;
    for (const pref of ls.preferences || []) {
      await ve.storeMirrorEntry({
        category: 'preferences',
        content: `Prefers to learn ${pref.mode.toLowerCase()} — ${pref.note}`,
        confidence: pref.score ?? 0.7,
        source_type: 'migration',
        source_id: `legacy:pref:${pref.mode}`
      });
      count++;
    }
    for (const avoid of ls.avoid || []) {
      await ve.storeMirrorEntry({
        category: 'preferences',
        content: `Dislikes: ${avoid}`,
        confidence: 0.6,
        source_type: 'migration',
        source_id: `legacy:avoid:${avoid}`
      });
      count++;
    }
  }
  for (const k of legacy.knowledge_graph || []) {
    await ve.storeMirrorEntry({
      category: 'knowledge_levels',
      content: `${k.topic} — ${k.level}. ${k.notes || ''}`.trim(),
      confidence: 0.75,
      source_type: 'migration',
      source_id: `legacy:kg:${k.id || k.topic}`
    });
    count++;
  }

  db.setConfig(FLAG, '1');
  db.log('info', 'migrate-mirror', `migrated ${count} legacy entries to mirror_entries`);
  return count;
}

module.exports = { runIfNeeded };
```

- [ ] **Step 4: Run — pass**

Run: `npm test -- tests/migrate-legacy-mirror.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/migrate-legacy-mirror.js tests/migrate-legacy-mirror.test.js
git commit -m "feat(mirror): migrate legacy JSON mirror to rows on boot"
```

### Task 11: `src/conversation-hooks.js` — pre/post-response + post-ingestion

**Files:**
- Create: `src/conversation-hooks.js`
- Create: `tests/conversation-hooks.test.js`

- [ ] **Step 1: Write failing test**

```js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-hooks-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const ve = require('../src/memory/vector-engine');
const hooks = require('../src/conversation-hooks');
const qm = require('../src/quantum-mirror');
const syn = require('../src/synthesizer');

test('conversation-hooks — preResponse returns context block', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });
  ve._setClient({
    embeddings: { create: async () => ({ data: [{ embedding: new Array(3).fill(0.5) }] }) }
  });

  await ve.storeMirrorEntry({
    category: 'preferences', content: 'likes terse answers',
    confidence: 0.8, source_type: 'conversation', source_id: 'x'
  });

  const block = await hooks.preResponse('hi');
  assert.ok(block.includes('likes terse answers'));
});

test('conversation-hooks — postResponse triggers mirror synthesis', async () => {
  let called = false;
  qm._setClient({
    messages: { create: async () => { called = true; return {
      content: [{ type: 'text', text: JSON.stringify({ new_entries: [], supersede: [], contradictions: [] }) }]
    }; } }
  });
  await hooks.postResponse({ userText: 'hello', assistantText: 'hi', sourceId: 't1' });
  assert.ok(called);
});

test('conversation-hooks — postIngestion triggers wiki synthesis', async () => {
  let called = false;
  syn._setClient({
    messages: { create: async () => { called = true; return {
      content: [{ type: 'text', text: JSON.stringify({ topics: [] }) }]
    }; } }
  });
  await hooks.postIngestion({ content: 'long article text', sourceId: 'msg-1' });
  assert.ok(called);
});
```

- [ ] **Step 2: Run — fail**

Run: `npm test -- tests/conversation-hooks.test.js`
Expected: FAIL

- [ ] **Step 3: Implement**

Create `src/conversation-hooks.js`:

```js
/**
 * MOTHERSHIP — Conversation hooks
 *
 * Three integration points wired into the message pipeline:
 * 1. preResponse  → retriever builds the live context block
 * 2. postResponse → quantum-mirror synthesis from the turn
 * 3. postIngestion → wiki synthesis from newly ingested content
 *
 * Synthesis calls are fire-and-forget (awaited by caller if desired) but
 * ALWAYS catch errors so a synthesis failure never breaks a user reply.
 */

const retriever = require('./memory/retriever');
const qm = require('./quantum-mirror');
const syn = require('./synthesizer');
const db = require('./database');

const MIRROR_TOPK = parseInt(process.env.MIRROR_TOPK || '5', 10);
const WIKI_TOPK = parseInt(process.env.WIKI_TOPK || '5', 10);
const MIN_TURN_LENGTH = parseInt(process.env.SYNTHESIS_MIN_CHARS || '40', 10);

async function preResponse(userText) {
  try {
    return await retriever.buildContextBlock(userText, {
      mirrorTopK: MIRROR_TOPK,
      wikiTopK: WIKI_TOPK
    });
  } catch (err) {
    db.log('error', 'hooks.preResponse', err.message);
    return '';
  }
}

async function postResponse({ userText, assistantText, sourceId }) {
  if (!userText || userText.length < MIN_TURN_LENGTH) return;
  try {
    await qm.synthesizeFromTurn({ userText, assistantText, sourceId });
  } catch (err) {
    db.log('error', 'hooks.postResponse', err.message);
  }
}

async function postIngestion({ content, sourceId }) {
  if (!content || content.length < MIN_TURN_LENGTH) return;
  try {
    await syn.synthesizeFromContent({ content, sourceId });
  } catch (err) {
    db.log('error', 'hooks.postIngestion', err.message);
  }
}

module.exports = { preResponse, postResponse, postIngestion };
```

- [ ] **Step 4: Run — pass**

Run: `npm test -- tests/conversation-hooks.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/conversation-hooks.js tests/conversation-hooks.test.js
git commit -m "feat(hooks): conversation hooks for retrieval and synthesis"
```

### Task 12: Refactor `src/conversation.js` to use the retriever

**Files:**
- Modify: `src/conversation.js`

- [ ] **Step 1: Swap static mirror injection for dynamic retrieval**

Replace `buildSystemPrompt()` and adjust `respond()`:

```js
const hooks = require('./conversation-hooks');
// remove: const mirror = require('./mirror');

function buildStaticSystemPrompt() {
  return `You are MOTHERSHIP — Yoel's personal AI operating system. You are not a generic assistant. You are a specific, persistent collaborator who is being built *with* Yoel, one conversation at a time.

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
}

async function respond(userInput, opts = {}) {
  const c = getClient();
  const staticPrompt = buildStaticSystemPrompt();
  const liveContext = await hooks.preResponse(userInput);
  const system = liveContext
    ? `${staticPrompt}\n\n# Live context (retrieved for this turn)\n${liveContext}`
    : staticPrompt;

  const history = buildHistory(userInput);

  const framedInput = opts.sourceHint
    ? `${opts.sourceHint}\n\n${userInput}`
    : userInput;

  const messages = [...history, { role: 'user', content: framedInput }];

  const response = await c.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages
  });

  const text = response.content.find(b => b.type === 'text')?.text?.trim() || '';
  logUsage(opts.contextKind || 'text', response.usage);
  return text;
}
```

- [ ] **Step 2: Smoke test — run server briefly**

Run: `npm test`
Expected: all existing tests still pass (static prompt refactor doesn't break anything).

- [ ] **Step 3: Commit**

```bash
git add src/conversation.js
git commit -m "refactor(conversation): use retriever for dynamic context injection"
```

### Task 13: Wire hooks into `src/telegram.js`

**Files:**
- Modify: `src/telegram.js`

- [ ] **Step 1: Import hooks and trigger after each reply + after each ingestion**

In `src/telegram.js`, add at top: `const hooks = require('./conversation-hooks');`

Inside `sendMothershipReply`, after the reply is persisted to DB, trigger post-response synthesis in a non-blocking way:

```js
async function sendMothershipReply(chatId, replyToId, text, baseMeta = {}) {
  if (!text) return;
  const replyId = db.addMessage(text, 'mothership', 'reply', { ...baseMeta, in_reply_to: replyToId });
  // Fire-and-forget synthesis (errors logged inside the hook)
  hooks.postResponse({
    userText: baseMeta._userText || '',
    assistantText: text,
    sourceId: replyId
  }).catch(() => {});
  // ... existing sendMessage loop
}
```

Thread the user text through so the hook can see it: update callers to pass `baseMeta: { ...baseMeta, _userText: msg.text }` (or the extracted content for links/media) when calling `sendMothershipReply`.

After each successful content ingestion (text with links, video, image), trigger `hooks.postIngestion` with the extracted `content` and the new message ID. Wire this at three sites:
1. Text-with-links branch: after `db.addMessage(...link-summary...)` → `hooks.postIngestion({ content: r.summary, sourceId: <returned id> }).catch(() => {})`
2. `processor.processImage` / `processor.processVideo` outputs: wrap with a post-ingestion call using the extracted description/transcript. Since `addMessage` is called inside `processor.js`, return the message id so telegram can pass it to the hook. Update `processor.js` to return `{ ..., messageId }`.

- [ ] **Step 2: Modify processor.js to return the message id**

Make `processImage` and `processVideo` capture `const id = db.addMessage(...)` and include `id` in the return value.

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: all pass.

- [ ] **Step 4: Manual smoke**

Start the server (`npm start`), send a Telegram message with meaningful content, confirm no errors in the logs and that a new row appears in `mirror_entries`:

```
SELECT category, content, confidence FROM mirror_entries ORDER BY created_at DESC LIMIT 5;
```

- [ ] **Step 5: Commit**

```bash
git add src/telegram.js src/processor.js
git commit -m "feat(telegram): wire post-response and post-ingestion synthesis hooks"
```

---

## Phase 5 — Output (Obsidian export & Telegram commands)

### Task 14: `src/exporters/obsidian.js` — markdown export with wikilinks

**Files:**
- Create: `src/exporters/obsidian.js`
- Create: `tests/exporters/obsidian.test.js`

- [ ] **Step 1: Write failing test**

```js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDb = path.join(__dirname, `.tmp-obs-${Date.now()}.db`);
const tmpVault = path.join(os.tmpdir(), `vault-${Date.now()}`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;
process.env.OBSIDIAN_VAULT_PATH = tmpVault;

const db = require('../../src/database');
const ve = require('../../src/memory/vector-engine');
const obsidian = require('../../src/exporters/obsidian');

test('obsidian exporter — writes mirror + wiki markdown with frontmatter', async (t) => {
  await db.init();
  t.after(() => {
    try { fs.unlinkSync(tmpDb); } catch {}
    try { fs.rmSync(tmpVault, { recursive: true, force: true }); } catch {}
  });
  ve._setClient({
    embeddings: { create: async () => ({ data: [{ embedding: new Array(3).fill(0.3) }] }) }
  });

  await ve.storeMirrorEntry({
    category: 'mental_models', content: 'Thinks in systems',
    confidence: 0.9, source_type: 'conversation', source_id: 'x'
  });
  await ve.storeWikiEntry({
    topic: 'RAG',
    summary: 'Retrieval augmented generation pairs vector search with LLMs.',
    source_ids: ['msg-a'], tags: ['ai', 'architecture']
  });

  const report = await obsidian.exportAll();

  const mirrorFile = path.join(tmpVault, 'Mirror', 'mental_models.md');
  const wikiFile = path.join(tmpVault, 'Wiki', 'RAG.md');
  const indexFile = path.join(tmpVault, '_index.md');

  assert.ok(fs.existsSync(mirrorFile));
  assert.ok(fs.existsSync(wikiFile));
  assert.ok(fs.existsSync(indexFile));

  const wikiContent = fs.readFileSync(wikiFile, 'utf8');
  assert.ok(wikiContent.startsWith('---'));
  assert.ok(wikiContent.includes('tags:'));
  assert.ok(wikiContent.includes('Retrieval augmented generation'));

  assert.ok(report.mirror >= 1);
  assert.ok(report.wiki >= 1);
});
```

- [ ] **Step 2: Run — fail**

Run: `npm test -- tests/exporters/obsidian.test.js`
Expected: FAIL

- [ ] **Step 3: Implement**

Create `src/exporters/obsidian.js`:

```js
/**
 * MOTHERSHIP — Obsidian exporter
 *
 * Writes Mirror/, Wiki/, and _reports/ as markdown files with YAML
 * frontmatter and [[wikilinks]] between semantically-similar entries.
 */

const fs = require('fs');
const path = require('path');
const db = require('../database');
const emb = require('../memory/embeddings');

const WIKILINK_SIM_THRESHOLD = parseFloat(process.env.WIKILINK_SIM_THRESHOLD || '0.75');

function vaultPath() {
  return process.env.OBSIDIAN_VAULT_PATH || null;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
}

function yamlFrontmatter(obj) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) {
      lines.push(`${k}: [${v.map(x => `"${x}"`).join(', ')}]`);
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

function findWikilinks(entry, allEntries) {
  if (!entry.embedding) return [];
  const qVec = emb.fromBuffer(entry.embedding);
  const others = allEntries
    .filter(e => e.id !== entry.id && e.embedding)
    .map(e => ({ ...e, vec: emb.fromBuffer(e.embedding) }));
  return emb.findRelevant(qVec, others, 10)
    .filter(r => r.score >= WIKILINK_SIM_THRESHOLD)
    .map(r => r.topic || `${r.category}/${r.id.slice(0, 6)}`);
}

function renderMirrorCategory(category, entries) {
  const header = yamlFrontmatter({
    type: 'mirror',
    category,
    entry_count: entries.length,
    updated: new Date().toISOString()
  });
  const body = entries.map(e => {
    return `## ${e.id.slice(0, 8)}\n- **Confidence:** ${e.confidence.toFixed(2)}\n- **Source:** ${e.source_type}${e.source_id ? ` (${e.source_id})` : ''}\n- **Updated:** ${e.updated_at}\n\n${e.content}\n`;
  }).join('\n---\n\n');
  return header + `# Mirror — ${category}\n\n${body}`;
}

function renderWikiTopic(entry, wikilinks) {
  const header = yamlFrontmatter({
    type: 'wiki',
    topic: entry.topic,
    tags: entry.tags,
    source_count: entry.source_ids.length,
    updated: entry.updated_at
  });
  const links = wikilinks.length
    ? `\n\n## Related\n${wikilinks.map(l => `- [[${l}]]`).join('\n')}`
    : '';
  const contradictions = entry.contradictions
    ? `\n\n> ⚠ **Contradictions flagged:** ${entry.contradictions}`
    : '';
  return header + `# ${entry.topic}\n\n${entry.summary}${links}${contradictions}`;
}

function renderIndex(mirrorCats, wikiEntries) {
  const lines = [
    yamlFrontmatter({ type: 'index', generated: new Date().toISOString() }),
    '# Mothership Index',
    '',
    '## Mirror',
    ...mirrorCats.map(c => `- [[Mirror/${c}]]`),
    '',
    '## Wiki',
    ...wikiEntries
      .slice()
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
      .map(e => `- [[Wiki/${sanitizeFilename(e.topic)}]] — ${e.tags.join(', ')}`)
  ];
  return lines.join('\n');
}

async function exportAll() {
  const vault = vaultPath();
  if (!vault) {
    db.log('warn', 'obsidian', 'OBSIDIAN_VAULT_PATH not set — skipping export');
    return { mirror: 0, wiki: 0, skipped: true };
  }

  const mirrorDir = path.join(vault, 'Mirror');
  const wikiDir = path.join(vault, 'Wiki');
  const reportsDir = path.join(vault, '_reports');
  ensureDir(mirrorDir);
  ensureDir(wikiDir);
  ensureDir(reportsDir);

  const allMirror = db.getMirrorEntries({ activeOnly: true, limit: 10000 });
  const byCat = new Map();
  for (const e of allMirror) {
    if (!byCat.has(e.category)) byCat.set(e.category, []);
    byCat.get(e.category).push(e);
  }
  let mirrorCount = 0;
  for (const [cat, list] of byCat) {
    const file = path.join(mirrorDir, `${sanitizeFilename(cat)}.md`);
    fs.writeFileSync(file, renderMirrorCategory(cat, list), 'utf8');
    mirrorCount += list.length;
  }

  const allWiki = db.getAllWikiEntries();
  let wikiCount = 0;
  for (const entry of allWiki) {
    const links = findWikilinks(entry, allWiki);
    const file = path.join(wikiDir, `${sanitizeFilename(entry.topic)}.md`);
    fs.writeFileSync(file, renderWikiTopic(entry, links), 'utf8');
    wikiCount++;
  }

  fs.writeFileSync(
    path.join(vault, '_index.md'),
    renderIndex(Array.from(byCat.keys()), allWiki),
    'utf8'
  );

  db.log('info', 'obsidian', `exported ${mirrorCount} mirror + ${wikiCount} wiki entries`);
  return { mirror: mirrorCount, wiki: wikiCount, skipped: false };
}

module.exports = { exportAll };
```

- [ ] **Step 4: Run — pass**

Run: `npm test -- tests/exporters/obsidian.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/exporters/obsidian.js tests/exporters/obsidian.test.js
git commit -m "feat(export): obsidian markdown exporter with wikilinks and frontmatter"
```

### Task 15: Telegram commands `/export`, `/mirror`, `/briefing`

**Files:**
- Modify: `src/telegram.js`
- Modify: `src/routes/api.js` (add REST equivalents)

- [ ] **Step 1: Add slash command handlers in telegram.js**

Inside `init()`, after the main `on('message')` handler, add a command dispatcher that runs BEFORE the rest of the handler logic. Add to the top of the `bot.on('message', ...)` callback:

```js
if (msg.text && msg.text.startsWith('/')) {
  const cmd = msg.text.trim().split(/\s+/)[0];
  const arg = msg.text.trim().slice(cmd.length).trim();

  if (cmd === '/export') {
    const obsidian = require('./exporters/obsidian');
    try {
      const r = await obsidian.exportAll();
      await bot.sendMessage(chatId,
        r.skipped
          ? '⚠ OBSIDIAN_VAULT_PATH not set.'
          : `✔ Exported ${r.mirror} mirror entries and ${r.wiki} wiki entries.`,
        { reply_to_message_id: msg.message_id });
    } catch (err) {
      await bot.sendMessage(chatId, `⚠ Export failed: ${err.message}`);
    }
    return;
  }

  if (cmd === '/mirror') {
    const rows = db.getMirrorEntries({ activeOnly: true, limit: 30 });
    const byCat = {};
    for (const r of rows) (byCat[r.category] ||= []).push(r);
    const lines = ['🪞 **Quantum Mirror (top 30 active)**'];
    for (const [cat, list] of Object.entries(byCat)) {
      lines.push(`\n*${cat}*`);
      for (const e of list.slice(0, 5)) {
        lines.push(`- (${e.confidence.toFixed(2)}) ${e.content}`);
      }
    }
    await bot.sendMessage(chatId, lines.join('\n').slice(0, 4000), { reply_to_message_id: msg.message_id });
    return;
  }

  if (cmd === '/briefing') {
    const retriever = require('./memory/retriever');
    const topic = arg || 'what should Yoel focus on today';
    try {
      const block = await retriever.buildContextBlock(topic, { mirrorTopK: 5, wikiTopK: 5 });
      await bot.sendMessage(chatId, block.slice(0, 4000) || '(nothing relevant found)', { reply_to_message_id: msg.message_id });
    } catch (err) {
      await bot.sendMessage(chatId, `⚠ Briefing failed: ${err.message}`);
    }
    return;
  }

  if (cmd === '/healthcheck') {
    const hc = require('./health-check');
    try {
      const r = await hc.runNow();
      await bot.sendMessage(chatId,
        `🩺 Health check: ${r.contradictions} contradictions, ${r.decayed} decayed, ${r.gaps} gaps.`,
        { reply_to_message_id: msg.message_id });
    } catch (err) {
      await bot.sendMessage(chatId, `⚠ Health check failed: ${err.message}`);
    }
    return;
  }
}
```

- [ ] **Step 2: Add REST equivalents in `src/routes/api.js`**

```js
const obsidian = require('../exporters/obsidian');
const retriever = require('../memory/retriever');

router.post('/export', async (req, res) => {
  try { res.json(await obsidian.exportAll()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/mirror/entries', (req, res) => {
  const { category, limit } = req.query;
  res.json(db.getMirrorEntries({
    category: category || null,
    activeOnly: true,
    limit: parseInt(limit) || 100
  }));
});

router.get('/wiki/entries', (req, res) => {
  res.json(db.getAllWikiEntries());
});

router.post('/briefing', async (req, res) => {
  const { topic } = req.body;
  try { res.json({ block: await retriever.buildContextBlock(topic || 'briefing') }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 3: Smoke test**

Start server, send `/mirror` on Telegram, confirm the mirror entries are printed. Send `/export`, confirm the vault is written. Hit `GET /api/mirror/entries` from the dashboard.

- [ ] **Step 4: Commit**

```bash
git add src/telegram.js src/routes/api.js
git commit -m "feat(commands): /export /mirror /briefing /healthcheck + REST equivalents"
```

---

## Phase 6 — Maintenance (health-check)

### Task 16: `src/health-check.js` — contradiction scan, decay, gap analysis

**Files:**
- Create: `src/health-check.js`
- Create: `tests/health-check.test.js`

- [ ] **Step 1: Write failing test**

```js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-hc-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const ve = require('../src/memory/vector-engine');
const hc = require('../src/health-check');

test('health-check — decays confidence of stale entries', async (t) => {
  await db.init();
  t.after(() => { try { fs.unlinkSync(tmpDb); } catch {} });
  ve._setClient({
    embeddings: { create: async () => ({ data: [{ embedding: new Array(3).fill(0.1) }] }) }
  });

  const id = await ve.storeMirrorEntry({
    category: 'preferences', content: 'ancient belief',
    confidence: 0.8, source_type: 'migration', source_id: 'x'
  });
  // Force updated_at to 60 days ago
  db._raw()?.run?.(`UPDATE mirror_entries SET updated_at = datetime('now', '-60 days') WHERE id = ?`, [id]);

  hc._setClient({
    messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify({
      contradictions: [], merge_candidates: []
    }) }] }) }
  });

  const r = await hc.runNow();
  assert.ok(r.decayed >= 1);
  const row = db.getMirrorEntries({ activeOnly: true }).find(x => x.id === id);
  assert.ok(row.confidence < 0.8);
});
```

Note: the test uses `db._raw()` to reach into sql.js directly. Add this helper export to `database.js`: `function _raw() { return db; }`. Keep it underscored to flag it as test-only.

- [ ] **Step 2: Run — fail**

Run: `npm test -- tests/health-check.test.js`
Expected: FAIL

- [ ] **Step 3: Implement**

Create `src/health-check.js`:

```js
/**
 * MOTHERSHIP — Weekly health check
 *
 * Three passes:
 * 1. Contradiction scan  (Claude)
 * 2. Confidence decay    (deterministic)
 * 3. Gap analysis        (Claude)
 *
 * Writes _reports/health_YYYY-MM-DD.md to the Obsidian vault and returns
 * a summary usable by Telegram notifications.
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const db = require('./database');
const { HEALTH_CONTRADICTIONS, GAP_ANALYSIS } = require('./memory/synthesis-prompts');

const MODEL = process.env.SYNTHESIS_MODEL || 'claude-opus-4-6';
const DECAY_AFTER_DAYS = parseInt(process.env.DECAY_AFTER_DAYS || '30', 10);
const DECAY_STEP = parseFloat(process.env.DECAY_STEP || '0.1');
const MIN_CONFIDENCE = parseFloat(process.env.MIN_CONFIDENCE || '0.2');

let client = null;
function _setClient(c) { client = c; }
function getClient() {
  if (client) return client;
  client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 3, timeout: 120_000 });
  return client;
}

function daysSince(iso) {
  return (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24);
}

function parseJsonFromText(text) {
  try { return JSON.parse(text.trim()); }
  catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    return null;
  }
}

async function decayStale() {
  const rows = db.getMirrorEntries({ activeOnly: true, limit: 10000 });
  let decayed = 0;
  for (const r of rows) {
    if (daysSince(r.updated_at) >= DECAY_AFTER_DAYS) {
      const next = Math.max(MIN_CONFIDENCE, r.confidence - DECAY_STEP);
      if (next < r.confidence) {
        db.updateMirrorEntryConfidence(r.id, next);
        decayed++;
      }
    }
  }
  return decayed;
}

async function scanContradictions() {
  const rows = db.getMirrorEntries({ activeOnly: true, limit: 200 });
  if (rows.length < 2) return [];
  const c = getClient();
  const res = await c.messages.create({
    model: MODEL,
    max_tokens: 1500,
    messages: [{ role: 'user', content: HEALTH_CONTRADICTIONS({ entries: rows }) }]
  });
  const text = res.content.find(b => b.type === 'text')?.text || '{}';
  const parsed = parseJsonFromText(text) || { contradictions: [] };
  return parsed.contradictions || [];
}

async function gapAnalysis() {
  const rows = db.getMirrorEntries({ activeOnly: true, limit: 200 });
  const wiki = db.getAllWikiEntries().map(w => w.topic);
  const snapshot = rows.map(r => `- [${r.category}] ${r.content}`).join('\n');
  const c = getClient();
  const res = await c.messages.create({
    model: MODEL,
    max_tokens: 1200,
    messages: [{ role: 'user', content: GAP_ANALYSIS({ mirror: snapshot, wikiTopics: wiki }) }]
  });
  const text = res.content.find(b => b.type === 'text')?.text || '{}';
  return parseJsonFromText(text) || { knowledge_gaps: [], thin_mirror_categories: [] };
}

function writeReport(summary) {
  const vault = process.env.OBSIDIAN_VAULT_PATH;
  if (!vault) return null;
  const dir = path.join(vault, '_reports');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filename = `health_${new Date().toISOString().slice(0, 10)}.md`;
  const file = path.join(dir, filename);
  const body = [
    '---',
    `type: health_report`,
    `generated: ${new Date().toISOString()}`,
    '---',
    `# Health Report — ${new Date().toISOString().slice(0, 10)}`,
    '',
    `## Summary`,
    `- Contradictions: ${summary.contradictions}`,
    `- Decayed entries: ${summary.decayed}`,
    `- Knowledge gaps: ${summary.gaps}`,
    '',
    `## Contradictions`,
    ...(summary.contradictionDetail || []).map(c => `- ${c.note} (entries: ${c.entry_ids.join(', ')})`),
    '',
    `## Knowledge gaps`,
    ...(summary.gapDetail?.knowledge_gaps || []).map(g => `- ${g.gap} — ${g.why_it_matters}`),
    '',
    `## Thin mirror categories`,
    ...(summary.gapDetail?.thin_mirror_categories || []).map(t => `- ${t.category}: ${t.suggestion}`)
  ].join('\n');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

async function runNow() {
  const decayed = await decayStale();
  let contradictions = [];
  let gapDetail = { knowledge_gaps: [], thin_mirror_categories: [] };

  try { contradictions = await scanContradictions(); }
  catch (err) { db.log('warn', 'healthcheck', `contradiction scan failed: ${err.message}`); }

  try { gapDetail = await gapAnalysis(); }
  catch (err) { db.log('warn', 'healthcheck', `gap analysis failed: ${err.message}`); }

  const summary = {
    decayed,
    contradictions: contradictions.length,
    contradictionDetail: contradictions,
    gaps: gapDetail.knowledge_gaps?.length || 0,
    gapDetail
  };
  const reportFile = writeReport(summary);
  db.log('info', 'healthcheck', `run complete: ${decayed} decayed, ${contradictions.length} contradictions, ${summary.gaps} gaps`, { reportFile });
  return summary;
}

let intervalHandle = null;
function start() {
  const hours = parseFloat(process.env.HEALTH_CHECK_INTERVAL_HOURS || '168'); // weekly
  const ms = hours * 60 * 60 * 1000;
  intervalHandle = setInterval(() => {
    runNow().catch(err => db.log('error', 'healthcheck', `scheduled run failed: ${err.message}`));
  }, ms);
  db.log('info', 'healthcheck', `scheduled every ${hours}h`);
}
function stop() { if (intervalHandle) clearInterval(intervalHandle); intervalHandle = null; }

module.exports = { runNow, start, stop, _setClient };
```

- [ ] **Step 4: Add `db._raw()` helper**

In `src/database.js`, add to exports:

```js
function _raw() { return db; }
```

And export it: `_raw`.

- [ ] **Step 5: Run — pass**

Run: `npm test -- tests/health-check.test.js`
Expected: PASS

- [ ] **Step 6: Wire into server.js boot**

Add to `server.js` boot sequence, after the other initializers:

```js
const migrate = require('./src/migrate-legacy-mirror');
const healthcheck = require('./src/health-check');

// Inside boot(), after db.init():
await migrate.runIfNeeded();

// Near the end of boot(), before app.listen:
healthcheck.start();
```

- [ ] **Step 7: Update `.env.example`**

Add:

```
OPENAI_API_KEY=
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMS=1536
OBSIDIAN_VAULT_PATH=
HEALTH_CHECK_INTERVAL_HOURS=168
DECAY_AFTER_DAYS=30
DECAY_STEP=0.1
MIN_CONFIDENCE=0.2
MIRROR_TOPK=5
WIKI_TOPK=5
SYNTHESIS_MIN_CHARS=40
WIKILINK_SIM_THRESHOLD=0.75
```

- [ ] **Step 8: Final full test run**

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 9: Commit**

```bash
git add src/health-check.js tests/health-check.test.js src/database.js server.js .env.example
git commit -m "feat(healthcheck): weekly scan, decay, gap analysis + boot wiring"
```

---

## Self-Review Checklist (run after plan complete)

**Spec coverage:**
- Layer 1 dynamic mirror → Tasks 2, 8, 10, 11
- Layer 2 wiki synthesizer → Tasks 3, 9, 11
- Layer 3 vector engine → Tasks 4, 5
- Layer 4 retriever → Task 6
- Layer 5 obsidian exporter → Task 14
- Layer 6 health check → Task 16
- Layer 7 conversation integration → Tasks 11, 12, 13
- Post-conversation synthesis → Task 11 + 13 (wiring)
- `/export` / `/mirror` / `/briefing` / `/healthcheck` commands → Task 15
- Confidence decay → Task 16
- Gap analysis → Task 16

**Type consistency:**
- `mirror_entries` schema matches across `database.js`, `quantum-mirror.js`, `retriever.js`, `obsidian.js`, `health-check.js`. ✔
- `wiki_entries` `source_ids`/`tags` consistently treated as arrays post-fetch. ✔
- `embedding` always stored as `Buffer`, read back as `Float32Array` via `emb.fromBuffer`. ✔
- Synthesis client hook name `_setClient` used identically in `quantum-mirror.js`, `synthesizer.js`, `health-check.js`, `vector-engine.js`. ✔

**Ordering check:**
- Phase 1 (tables) → Phase 2 (embeddings use tables) → Phase 3 (synthesis uses embeddings + tables) → Phase 4 (hooks wire synthesis into pipeline + conversation refactor + migration runs on boot) → Phase 5 (export + telegram commands use everything) → Phase 6 (health check uses everything).

No placeholders, no TBDs. Every step has real code.
