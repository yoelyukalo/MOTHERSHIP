# Satellite Model & Registry — Design

**Status:** draft · awaiting user review
**Date:** 2026-04-13
**Owner:** Yoel
**Phase:** 6 · sub-project #1 of 7
**Predecessor:** none
**Successors:** #2 Multi-user auth, #3 Dashboard multi-tenancy, #4 Per-satellite Telegram bot runners, #5 Control plane, #6 Staff sub-agent framework, #7 Provision first real satellites

---

## 1. Overview

Mothership's Phase 6 introduces **satellites** — externally-owned subsystems that Mothership provisions, observes, and pushes updates into, while keeping each satellite's data fully sovereign and portable. A satellite represents one unit of external business logic: one title service, one dealership, one dental office, one dev team.

This sub-project (#1) builds only the **foundation**: the registry table, the folder convention, the kind loader, the directive inbox, the draft-capture table, and the visibility invariants. It ships zero UI, zero bot routing, zero auth, and zero staff sub-agent support. Those are deliberate follow-on sub-projects.

The design is driven by one overriding constraint: **a satellite must be sellable or transferable as a self-contained unit, without entangling it with Mothership's private data.**

---

## 2. Non-goals for #1

Explicitly out of scope. Listed here so the spec stays tight and we don't feature-creep.

- **Multi-user auth.** No users, no passwords, no sessions. Deferred to #2.
- **Dashboard UI.** No satellite switcher, no login screen, no satellite admin views. Deferred to #3.
- **Per-satellite Telegram bot routing.** `src/telegram.js` stays as-is. One bot, one target. Deferred to #4.
- **Cross-satellite queries and briefings.** The control plane is #5. In #1 we only build the data primitives it will sit on.
- **Staff sub-agents.** The `agents/` subfolder is reserved in the satellite layout, but the runtime and data model for staff-built bots is deferred to #6.
- **Provisioning real satellites.** ABC Auto Titles and any other real business goes in #7, once #1–#5 are shipped.
- **Embedded satellites at runtime.** The `kind='embedded'` tier exists in the registry schema as a reserved value, but #1 implements only the standalone loader. Embedded is not provisioned in #1.
- **Directive kinds beyond `config.set`.** `prompt.update`, `schema.migrate`, and `data.seed` are specified at the protocol level but only `config.set` is implemented end-to-end in #1, as proof of the pattern.

---

## 3. Vocabulary

| Term | Meaning |
|---|---|
| **Satellite** | An externally-owned subsystem that Mothership knows about. Has a slug, a name, a kind, a visibility level, and a status. |
| **Kind** | A vertical template shared across satellites of the same type. Lives in `src/satellite-kinds/<kind>/`. Examples: `title-service`, `dental`, `dealership`. |
| **Embedded satellite** | Reserved tier. A satellite that exists as a `satellite_id` tag on rows inside the Mothership core DB. Not implemented in #1. |
| **Standalone satellite** | A satellite whose data lives in its own folder at `data/satellites/<slug>/`, with its own SQLite DB. The default tier and the only one implemented in #1. |
| **Visibility** | What Mothership is allowed to see of a standalone satellite's data. One of `full`, `limited`, `none`. |
| **Sovereignty** | The hard rule: Mothership never writes directly to a standalone satellite's DB. Writes flow through the directive inbox, which the satellite itself applies. |
| **Directive** | A JSON file Mothership drops into a satellite's inbox, requesting a config change, prompt update, schema migration, or seed data insertion. The satellite decides whether to apply it. |
| **Draft** | A row in the Mothership core `satellite_drafts` table representing a satellite that is being discussed or planned but doesn't exist yet. Claude Code reads drafts to build satellites. |
| **Brief** | The synthesized markdown summary of a draft, composed from linked discussion turns. Claude Code reads this as the primary build instructions. |

---

## 4. Architecture overview

### 4.1 Repo layout

```
src/
  satellite-kinds/              ← shared code per vertical (git-tracked)
    title-service/
      index.js                  ← kind module entry point
      schema.sql                ← default tables for new instances
      default-prompts/          ← initial prompts shipped with the kind
        system.md
      README.md                 ← how to use this kind
    dental/
      ...
    dealership/
      ...
  satellites/                   ← satellite runtime glue
    registry.js                 ← CRUD on the satellites table
    loader.js                   ← boot-time kind+instance loader
    directives.js               ← file-inbox consumer loop
    drafts.js                   ← satellite_drafts CRUD
    sovereignty.js              ← enforcement: read-only guard on standalone DBs

data/
  mothership.db                 ← Mothership core DB (existing)
  satellites/                   ← per-instance data + local config (gitignored)
    abc-auto-titles/
      db.sqlite                 ← satellite's own DB
      config.json               ← { "kind": "title-service", "name": "...", "visibility": "full", ... }
      .secrets                  ← bot tokens, API keys (chmod 600, gitignored)
      custom.js                 ← optional per-instance handler override
      agents/                   ← reserved for staff sub-bots (#6)
      directives/
        pending/                ← Mothership writes JSON here
        applied/                ← satellite moves applied directives here
        rejected/               ← satellite moves failed directives here
```

### 4.2 Boot sequence

On `server.js` start:

1. Mothership core DB initializes (existing behavior, unchanged).
2. `src/satellites/loader.js` reads the `satellites` table, filters to `status='active'` and `kind != 'embedded'`.
3. For each active standalone satellite:
   - Resolve the kind module: `require('./satellite-kinds/<kind>')`. If the module is missing, log a warning, mark the satellite `status='broken'` in the registry, and continue.
   - Open a `sql.js` database handle on `data/satellites/<slug>/db.sqlite`. If the DB file is missing, apply `kind/schema.sql` to a fresh DB.
   - If `data/satellites/<slug>/custom.js` exists, require it and merge its exports over the kind's defaults.
   - Start the satellite's directive consumer on `data/satellites/<slug>/directives/pending/` using chokidar.
   - Register the satellite handle in an in-memory map: `satellites.get(slug) → { kind, db, config, handlers, dispose }`.
4. Mothership starts Express and Telegram as before.

One satellite's failed boot does not block the others. Failures land in `db.log('error', 'satellites.loader', ...)` and the satellite is marked broken.

### 4.3 The sovereignty invariant

**The hard rule:** no code in the Mothership runtime is allowed to execute a write statement against a standalone satellite's DB handle, *except* the satellite's own kind/custom module code running inside a directive handler or lifecycle hook.

This is enforced by `src/satellites/sovereignty.js`, which wraps every satellite DB handle before it enters the runtime map. The wrapper intercepts `run`, `prepare`, and `exec` calls:

- `SELECT` statements pass through if visibility permits (see §10).
- Any `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ALTER`, `DROP` throws `SovereigntyViolation`. This is what every Mothership module sees when it reads from the in-memory satellites map.

The trust boundary is crucial and worth naming explicitly:

- **Public handle** (wrapped, read-only, visibility-gated) — what every Mothership module gets when it calls `satellites.get(slug).db`. Used for observability, cross-satellite queries, the control plane later in #5.
- **Writable handle** (raw, never wrapped) — lives inside a closure held by `loader.js`. The loader creates the raw handle at boot, wraps it for public consumption, and retains the raw reference internally. The only code path that receives the raw handle is the **directive consumer loop** and **lifecycle hooks** (`onCreate`, `onBoot`, `onArchive`) — both of which invoke satellite-authored code (the kind module or `custom.js`) with the raw handle as an argument. The raw handle is never stored on the satellites map and never exposed through the public API.

The effect: Mothership code outside `loader.js` and `directives.js` cannot obtain a writable handle by any means. Writes only happen when the satellite's own authored code runs in response to a directive or lifecycle event. `directives.js` is trusted infrastructure — it is the one module that bridges Mothership to the satellite's writable context, and it does not write to the DB itself. It only passes the raw handle through to the satellite's directive handler and then discards the reference.

This enforces the sovereignty rule at the module boundary, not via runtime reflection or introspection. Reviewing `loader.js` and `directives.js` is sufficient to audit the whole invariant.

---

## 5. Data model

### 5.1 Mothership core: `satellites` table

New table in `data/mothership.db`.

```sql
CREATE TABLE IF NOT EXISTS satellites (
  id TEXT PRIMARY KEY,                    -- uuid
  slug TEXT NOT NULL UNIQUE,              -- 'abc-auto-titles'
  name TEXT NOT NULL,                     -- 'ABC Auto Titles'
  kind TEXT NOT NULL,                     -- 'title-service' | 'dental' | ... | 'embedded'
  db_path TEXT,                           -- 'data/satellites/abc-auto-titles/db.sqlite' (null for embedded)
  owner TEXT NOT NULL DEFAULT 'mothership', -- 'mothership' | 'client'
  visibility TEXT NOT NULL DEFAULT 'full',  -- 'full' | 'limited' | 'none'
  status TEXT NOT NULL DEFAULT 'active',    -- 'active' | 'archived' | 'broken' | 'transferred'
  config_json TEXT,                       -- satellite-wide config snapshot, for read-only reference
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  transferred_at DATETIME,                -- set when status becomes 'transferred'
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_satellites_kind ON satellites(kind);
CREATE INDEX IF NOT EXISTS idx_satellites_status ON satellites(status);
```

### 5.2 Mothership core: `satellite_drafts` table

New table in `data/mothership.db`.

```sql
CREATE TABLE IF NOT EXISTS satellite_drafts (
  id TEXT PRIMARY KEY,                    -- uuid
  slug TEXT NOT NULL UNIQUE,              -- 'dentist-sugarland'
  name TEXT NOT NULL,                     -- 'Dr. Nguyen Dental — Sugarland'
  kind TEXT,                              -- tentative kind, may be null during discussion
  status TEXT NOT NULL DEFAULT 'discussing', -- 'discussing' | 'planned' | 'building' | 'created' | 'abandoned'
  brief_md TEXT,                          -- synthesized brief, regenerated from linked turns
  brief_updated_at DATETIME,              -- when brief_md was last regenerated
  created_satellite_id TEXT,              -- FK to satellites.id once created
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_satellite_id) REFERENCES satellites(id)
);

CREATE INDEX IF NOT EXISTS idx_drafts_status ON satellite_drafts(status);
```

### 5.3 Linking conversation turns to drafts

Existing `messages` table is unchanged. Draft linkage is stored inside `metadata_json` under the key `draft_slug`:

```json
{ "draft_slug": "dentist-sugarland", "via": "dashboard-chat" }
```

No schema migration to `messages`. Draft-linked turns are found by:

```sql
SELECT * FROM messages
WHERE json_extract(metadata, '$.draft_slug') = ?
ORDER BY created_at ASC
```

### 5.4 Per-satellite DB: baseline schema

Every standalone satellite DB inherits a **baseline schema** regardless of kind. The baseline is applied by `loader.js` before the kind's `schema.sql` runs.

```sql
-- baseline tables, applied to every new standalone satellite

CREATE TABLE IF NOT EXISTS satellite_meta (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS satellite_messages (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,          -- 'telegram' | 'dashboard' | 'api' | 'agent:<name>' | ...
  direction TEXT NOT NULL,       -- 'in' | 'out'
  content TEXT NOT NULL,
  metadata_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS satellite_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS satellite_directives_history (
  id TEXT PRIMARY KEY,           -- matches the directive file name
  kind TEXT NOT NULL,            -- 'config.set' | 'prompt.update' | ...
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,          -- 'applied' | 'rejected'
  error TEXT,
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

The kind's `schema.sql` adds domain tables on top. For `kind=title-service` that might be `customers`, `title_orders`, `dmv_submissions`, etc. These are defined per-kind and out of scope here.

---

## 6. Kind module interface

Every file under `src/satellite-kinds/<kind>/index.js` exports a module conforming to:

```javascript
module.exports = {
  // Metadata
  kind: 'title-service',
  displayName: 'Title Service',
  version: '1.0.0',
  description: 'Licensed auto title service — DMV paperwork, VIN verification, lien processing.',

  // Schema the kind adds on top of the baseline. Read from schema.sql at boot.
  // Auto-populated by the loader; the module does not need to export it manually.
  // schema: '<sql string>',

  // Default config applied to new instances of this kind.
  defaultConfig: {
    business_hours: { open: '09:00', close: '17:00', timezone: 'America/Chicago' },
    require_id_verification: true,
    // ...kind-specific defaults
  },

  // Directive handlers. Called by the directive consumer when a matching directive
  // arrives in the pending/ folder. Return { status: 'applied' } or throw.
  //
  // The `db` argument is the RAW WRITABLE HANDLE for this satellite. It bypasses
  // the sovereignty wrapper and is only passed to code authored inside this kind
  // module or the instance's custom.js. See §4.3 for why this is safe.
  directiveHandlers: {
    'config.set': async ({ payload, db, config, logger }) => {
      // payload: { key, value }
      // db: the writable handle for THIS satellite
      // config: the satellite's current config snapshot (mutable; see onConfigChange)
      // logger: scoped logger that writes to satellite_logs
      db.run('INSERT OR REPLACE INTO satellite_meta (key, value) VALUES (?, ?)',
             [payload.key, JSON.stringify(payload.value)]);
      return { status: 'applied' };
    },
    // 'prompt.update', 'schema.migrate', 'data.seed' implemented later
  },

  // Lifecycle hooks. All receive the raw writable handle, same trust rules as directive handlers.
  onCreate:  async ({ db, config, logger }) => { /* seed reference data, first-run setup */ },
  onBoot:    async ({ db, config, logger }) => { /* runs on every Mothership boot */ },
  onArchive: async ({ db, config, logger }) => { /* runs when satellite is archived */ },

  // Handlers for inbound events (reserved for Phase 4 — bot runners)
  handlers: {
    // onTelegramMessage, onWebhook, etc. — stubs in #1, implemented in #4
  }
};
```

A satellite instance at `data/satellites/<slug>/custom.js` can export the same shape, and its fields are **merged over** the kind's defaults (shallow merge on top-level keys; directive handlers and lifecycle hooks are replaced, not concatenated).

### 6.1 Why merge, not inherit

Classical inheritance adds complexity we don't need. A shallow merge is: if the instance's `custom.js` exports a `directiveHandlers.config.set`, it wins; if it doesn't, the kind's version wins. No `super` calls, no chain. If an instance needs more complex behavior, it can `require()` the kind module itself and compose.

---

## 7. Satellite lifecycle

### 7.1 Create

`POST /api/satellites`
```json
{
  "slug": "abc-auto-titles",
  "name": "ABC Auto Titles",
  "kind": "title-service",
  "visibility": "full",
  "owner": "mothership",
  "from_draft_slug": "abc-auto-titles-draft",   // optional
  "config": { "business_hours": { "open": "08:00" } }  // optional overrides on the kind default
}
```

Mothership:

1. Validates slug format (`^[a-z0-9][a-z0-9-]{2,63}$`) and kind existence.
2. Creates `data/satellites/<slug>/` directory tree (including `directives/pending/`, `applied/`, `rejected/`, `agents/`).
3. Writes `config.json` with kind-default config shallow-merged with provided overrides.
4. Creates empty `db.sqlite`.
5. Applies baseline schema (§5.4).
6. Applies kind's `schema.sql`.
7. Runs `kind.onCreate({ db, config, logger })`.
8. Inserts row into `satellites` table with status `active`.
9. If `from_draft_slug` is provided, sets the draft's `status='created'` and `created_satellite_id=<new id>`.
10. Loads the satellite into the in-memory map via `loader.register(slug)` (same code path as boot-time load).
11. Returns `{ id, slug, status: 'active' }`.

Failures between steps 2 and 10 are rolled back: the folder is removed, the registry row is deleted. A half-created satellite is never left behind.

### 7.2 Boot / load

Covered in §4.2. Idempotent — can be called on a single slug via `loader.register(slug)` after a hot create.

### 7.3 Apply a directive

Covered in §8 below.

### 7.4 Archive

`POST /api/satellites/:slug/archive` — sets `status='archived'`. The satellite is unloaded from the in-memory map, its bot (when #4 ships) stops, and its DB file stays on disk. Reversible via `POST /api/satellites/:slug/unarchive`.

### 7.5 Transfer (sell / hand off)

`POST /api/satellites/:slug/transfer` — sets `status='transferred'`, `transferred_at=NOW()`, and optionally changes `visibility='none'` and `owner='client'`. The satellite is unloaded but its folder stays intact. The user is instructed on how to hand the folder off (zip, ship, restore in the buyer's Mothership fork). The folder is NOT automatically deleted — that's a manual `rm` the user performs after the handoff is confirmed.

### 7.6 Delete

Deliberately no `DELETE /api/satellites/:slug`. Destructive. Deletion is a manual operation: archive the satellite, delete the row, `rm -rf` the folder. We add API-level delete in a later sub-project with a confirmation flow.

---

## 8. Directive inbox protocol

### 8.1 File format

Directives are JSON files in `data/satellites/<slug>/directives/pending/`. File name:
```
<ISO-timestamp>-<kind>-<short-uuid>.json
```
e.g.
```
2026-04-13T15-32-09Z-config.set-8c4a.json
```

File contents:
```json
{
  "id": "8c4a3e1a-b2f5-4e0c-9a7d-1e2f3b4c5d6e",
  "kind": "config.set",
  "issued_at": "2026-04-13T15:32:09.123Z",
  "issued_by": "mothership:dashboard",
  "payload": {
    "key": "business_hours.open",
    "value": "08:00"
  }
}
```

Fields:
- `id` — uuid, used as the row id in `satellite_directives_history`.
- `kind` — one of the declared directive kinds.
- `issued_at` — ISO-8601 UTC timestamp.
- `issued_by` — free-form, typically `mothership:<surface>` (`mothership:dashboard`, `mothership:telegram`, `mothership:automation`, etc.). Used for audit.
- `payload` — shape depends on `kind`.

### 8.2 Consumer loop

`src/satellites/directives.js` exports a `start(slug, { db, handlers, logger })` function. Called by the loader after a satellite is registered. It:

1. Opens a chokidar watcher on `data/satellites/<slug>/directives/pending/`.
2. On `add` event: reads the file, parses JSON, validates required fields.
3. Looks up `handlers[directive.kind]`. If missing, moves the file to `rejected/` with `_error.txt` sibling containing `unknown directive kind`.
4. If present, calls `handler({ payload, db, config, logger })` inside a try/catch.
5. On success: writes a row to `satellite_directives_history` with `status='applied'`, moves the file to `applied/`.
6. On thrown error: writes history row with `status='rejected'` and the error message, moves the file to `rejected/` with `_error.txt` sibling.

The consumer also does a **startup sweep** of `pending/` on boot, in case the process crashed mid-directive.

### 8.3 Initial directive kind: `config.set`

Only `config.set` is wired end-to-end in #1, as proof of the pattern.

**Payload:**
```json
{ "key": "some.dotted.key", "value": <any JSON-serializable value> }
```

**Handler behavior:** upsert `satellite_meta` row keyed by `key`, value is `JSON.stringify(value)`. Also updates the in-memory config snapshot and triggers the satellite's `onConfigChange` hook if defined.

**Reserved for later sub-projects:**
- `prompt.update` — replace/version a system prompt file in `data/satellites/<slug>/prompts/` (adds prompt versioning table). Schema defined but handler deferred.
- `schema.migrate` — apply a DDL statement to the satellite's DB, gated by a version check. Deferred.
- `data.seed` — upsert reference data rows from a supplied JSON array. Deferred.

---

## 9. Draft capture & the Claude Code bridge

### 9.1 Creating a draft

`POST /api/satellites/drafts`
```json
{ "slug": "dentist-sugarland", "name": "Dr. Nguyen Dental — Sugarland", "kind": "dental" }
```
`kind` may be omitted while the idea is still fuzzy.

### 9.2 Linking conversation turns

Two ways to link a turn to a draft:

**(a) Dashboard selector.** The dashboard chat bar (already built) gets a small draft picker next to it. When a draft is selected, `POST /api/chat` body includes `draft_slug`. The server stores it under `metadata.draft_slug` when writing both the user row and the mothership reply row. *UI work deferred to #3, but the API field is wired in #1.*

**(b) Telegram command prefix.** `/draft <slug> <message text>` routes the message under that draft. Implemented as a slash command in `src/telegram.js` (small addition to the existing slash-command block).

No LLM-based auto-detection. Linking is always explicit.

### 9.3 The brief endpoint

`GET /api/satellites/drafts/:slug` returns:
```json
{
  "draft": { "id": "...", "slug": "dentist-sugarland", "name": "...", "kind": "dental", "status": "discussing", "brief_md": "...", "brief_updated_at": "...", "created_at": "..." },
  "messages": [
    { "id": "...", "source": "telegram", "content": "...", "created_at": "..." },
    { "id": "...", "source": "mothership", "content": "...", "created_at": "..." }
  ]
}
```

Claude Code calls this endpoint, receives the full conversation + the latest brief, and uses it as build context.

### 9.4 Regenerating the brief

`POST /api/satellites/drafts/:slug/regenerate-brief` — sends the linked turns through `conversation.respond()` with a special system prompt that asks for a structured brief (goal, users, kinds of data, operational constraints, open questions). The result is stored in `brief_md` and `brief_updated_at` is bumped.

Brief regeneration is manual (the user asks for it) rather than automatic on every new turn — prevents wasting tokens every time Yoel types something about a draft. Auto-regeneration can be added later as a cron.

### 9.5 From draft to real satellite

Covered in §7.1 step 9 — when a draft transitions to a real satellite via `from_draft_slug`, the draft row is updated in place. The draft row is never deleted; it remains as a historical record of how the satellite was conceived.

---

## 10. Visibility and read-gating

Recall the three tiers from §3: `full` / `limited` / `none`.

The `sovereignty.js` wrapper (§4.3) reads the satellite's `visibility` field and gates reads:

- **`full`** — all reads pass through. Mothership code can `SELECT` from any table in the satellite's DB. Cross-satellite synthesis by Quantum Mirror / control plane is enabled but not implemented in #1 — #1 only builds the read-allowed primitive. Actually reading across satellites from the Mirror is #5.
- **`limited`** — reads only against `satellite_logs`, `satellite_meta`, and `satellite_directives_history`. All other tables throw `VisibilityViolation`. Mothership sees that the satellite exists and whether it's healthy, but not its customer data or message content.
- **`none`** — reads throw `VisibilityViolation` unconditionally. Mothership can confirm the satellite is loaded and its `status`, but has no read access to any table. The satellite is effectively a black box.

Writes are independently blocked by the sovereignty rule (§4.3) regardless of visibility.

### 10.1 Visibility changes

`POST /api/satellites/:slug/visibility`
```json
{ "visibility": "limited" }
```
Updates the registry and the in-memory wrapper. Takes effect immediately for new queries.

---

## 11. Mirror convention for satellite-building

No code changes to Quantum Mirror in #1. Instead, a convention:

Any `mirror_entries`, mental model, or resonance log entry tagged `category='satellite-building'` is the "how Yoel builds satellites" dataset. The existing Quantum Mirror synthesizer already picks up new categories via its standard flow — no change needed to process them.

The convention is documented in this spec and in the satellite module READMEs. Going forward, when Yoel discusses a draft or creates a satellite, resonance entries generated from those turns are tagged `satellite-building` by the `conversation.respond()` path when `draft_slug` is present in the metadata. That's the only code touch in #1 for Mirror: one tag applied at one place.

The payoff: over time, the Mirror accumulates patterns — which kinds of businesses Yoel struggles to spec, which directive shapes keep failing, what language he uses when he's confident vs unsure about a draft — and the synthesizer surfaces those patterns to help with future satellites. This is emergent behavior of the existing system, not new code.

---

## 12. API surface added by #1

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/satellites` | Create a satellite (see §7.1) |
| `GET` | `/api/satellites` | List satellites (filterable by status, kind, visibility) |
| `GET` | `/api/satellites/:slug` | Get satellite registry details (not its data — that's gated by visibility) |
| `POST` | `/api/satellites/:slug/archive` | Archive |
| `POST` | `/api/satellites/:slug/unarchive` | Un-archive |
| `POST` | `/api/satellites/:slug/transfer` | Mark transferred |
| `POST` | `/api/satellites/:slug/visibility` | Change visibility |
| `POST` | `/api/satellites/:slug/directives` | Issue a directive (writes JSON into `pending/`) |
| `GET` | `/api/satellites/:slug/directives` | List directive history |
| `POST` | `/api/satellites/drafts` | Create a draft |
| `GET` | `/api/satellites/drafts` | List drafts |
| `GET` | `/api/satellites/drafts/:slug` | Get draft + linked messages + brief (Claude Code's entry point) |
| `POST` | `/api/satellites/drafts/:slug/regenerate-brief` | Regenerate brief from linked turns |
| `POST` | `/api/satellites/drafts/:slug/status` | Change draft status |

All endpoints are unauthenticated in #1 — localhost access only. Auth comes in #2.

---

## 13. File & module manifest

New files created by #1:

```
src/satellites/
  registry.js          — CRUD on the satellites table, slug validation
  loader.js            — boot-time kind+instance loader, in-memory map, register/unregister
  directives.js        — chokidar consumer loop, directive issuance helpers
  drafts.js            — satellite_drafts CRUD, brief regeneration, message-linking query
  sovereignty.js       — DB handle wrapper enforcing no-write + visibility read gating
  kinds.js             — kind module resolver and merge logic with custom.js
  index.js             — public module surface imported by server.js

src/satellite-kinds/
  README.md            — how to author a new kind (just docs for now, no real kinds implemented)

src/routes/
  api.js               — extended with the endpoints from §12

data/satellites/
  .gitkeep             — folder exists but is empty
  README.md            — explains that instance folders are gitignored per-instance
```

Modified files:
- `src/database.js` — add `satellites` and `satellite_drafts` table creation to the init block
- `server.js` — call `satellites.init()` during boot, after the core DB is ready
- `src/routes/api.js` — mount the new endpoints

Unchanged:
- `src/telegram.js` (no routing changes; only the `/draft` slash command is a minor addition in a later step)
- `src/conversation.js`
- `src/mirror.js` and `src/quantum-mirror.js`

---

## 14. Error handling & failure modes

| Failure | Behavior |
|---|---|
| Kind module missing at boot | Log error, mark satellite `status='broken'`, continue booting other satellites |
| Satellite DB file missing | Recreate from baseline + kind schema (treat as fresh create) |
| Directive JSON malformed | Move to `rejected/` with `_error.txt` sibling, write history row |
| Directive handler throws | Move to `rejected/`, history row captures error message |
| Write attempted via the sovereignty wrapper | Throw `SovereigntyViolation`, log, fail the caller loudly |
| Read attempted on a visibility-restricted table | Throw `VisibilityViolation`, same handling |
| Slug collision on create | 409, no side effects |
| `POST /api/satellites` rollback needed | Remove the satellite folder (recursively) and the registry row; leave `satellite_drafts` unchanged |
| Chokidar watcher dies | Consumer loop logs and re-opens the watcher after a backoff |

All errors that bypass a request-response cycle land in `db.log('error', 'satellites.*', ...)` and appear in the System Log tab.

---

## 15. Testing strategy (for the implementation plan)

The implementation plan (written by the writing-plans skill next) will include:

- Unit tests for slug validation, kind resolution, shallow-merge of custom.js, and the sovereignty wrapper's throw-on-write behavior.
- Integration test: create a dummy `kind=test-kind` under `src/satellite-kinds/`, create an instance via the API, write a `config.set` directive, assert it lands in `applied/` and that `satellite_meta` has the new value.
- Integration test: create a draft, post a chat turn with `draft_slug`, call the brief endpoint, assert the message is linked.
- Integration test: archive → unarchive round trip.
- Integration test: transfer, then assert subsequent reads return empty / the wrapper throws.

Tests live in `tests/satellites/` and use Node's built-in `test` module (the repo already has `"test": "node --test"` in package.json).

---

## 16. Open questions deliberately deferred

These are questions whose answers don't affect the #1 schema or folder layout, so deferring them is safe.

1. **How does staff-built sub-agent code live inside `agents/`?** Answered in #6.
2. **Does each satellite get its own Telegram bot token, or does Mothership multi-tenant a single bot?** Answered in #4.
3. **Will `kind=embedded` ever be fully implemented, or will it be dropped?** Answered if/when someone wants a lightweight satellite tier.
4. **Is Claude Code reading `/api/satellites/drafts/:slug` the right interface, or should we ship an MCP server that exposes drafts as MCP resources?** Deferred. REST is fine for now; MCP can be added as a thin wrapper later.
5. **Prompt versioning for `prompt.update` directives — single current + history, or a tree of variants?** Answered when `prompt.update` is actually implemented (post-#1).

---

## 17. Success criteria

#1 is complete when all of the following are true:

- [ ] `satellites` and `satellite_drafts` tables exist in the Mothership core DB.
- [ ] Creating a satellite via `POST /api/satellites` produces a valid folder, a bootable DB, and an in-memory handle.
- [ ] Boot-time loader successfully registers all active satellites; broken satellites are marked and logged without crashing Mothership.
- [ ] A `config.set` directive written to `pending/` is applied and moves to `applied/`, with a row in `satellite_directives_history`.
- [ ] Attempting an `INSERT` against a satellite's DB handle from Mothership code throws `SovereigntyViolation`.
- [ ] Attempting a `SELECT` on a `limited`-visibility satellite's non-metadata table throws `VisibilityViolation`.
- [ ] A draft can be created, chat turns can be linked via `draft_slug`, and `GET /api/satellites/drafts/:slug` returns the linked turns.
- [ ] A draft can be promoted to a real satellite via `from_draft_slug` in the create call; the draft's `status` becomes `'created'` and `created_satellite_id` is set.
- [ ] Integration tests in §15 pass.
- [ ] No UI is shipped. No auth is shipped. No bot routing is shipped.

---

## 18. What this unblocks

Once #1 is shipped, these sub-projects become buildable because they have primitives to sit on:

- **#2 Multi-user auth** can add a `satellite_memberships` join table against the existing `satellites` table.
- **#3 Dashboard multi-tenancy** can render a satellite switcher from `GET /api/satellites` and route state-changes via the existing endpoints.
- **#4 Per-satellite Telegram bot runners** can read each satellite's `.secrets` file for a bot token and use the loaded `handlers.onTelegramMessage` from the kind module.
- **#5 Control plane** can implement cross-satellite briefings by iterating `GET /api/satellites` and reading each one through the visibility-gated wrapper.
- **#6 Staff sub-agent framework** can design the `agents/` subfolder protocol without needing schema changes.
- **#7 Provision real satellites** can run `POST /api/satellites` against the real kinds once #2–#5 are in place.
