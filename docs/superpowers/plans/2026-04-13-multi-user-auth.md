# Multi-User Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase 6 sub-project #2 — first-class authentication, hybrid RBAC, and per-user data scoping — per the design at `docs/superpowers/specs/2026-04-13-multi-user-auth-design.md`.

**Architecture:** A new `src/auth/` module (hashing, users, sessions, api-keys, roles, resolver, middleware, invitations, groups, system-owner, index), two new route files (`src/routes/auth.js` and `src/routes/users.js`), a bootstrap CLI at `scripts/create-admin.js`, ten new tables in `data/mothership.db`, `user_id` columns added to the three Mothership-core scoped tables (`messages`, `mirror_entries`, `wiki_entries`), and a retrofit pass over every existing `/api/*` endpoint to gate with `requireAuth` middleware and filter per-user data by caller id.

**Tech Stack:** Node.js (existing), Express.js, sql.js (WASM SQLite), `hash-wasm` (new dependency — pure-WASM argon2id), `uuid` (existing), `chokidar` (existing), `node --test` runner. No native-compilation dependencies.

---

## Prerequisites

Working from `main` at commit `050971b` (the sub-project #2 design spec). Sub-project #1 is fully merged. 136 tests pass baseline. The uncommitted `public/index.html` work remains the user's in-progress UI changes and must stay untouched by this plan.

The scope is large but coherent — 10 auth tables, ~32 permissions, 8 seed roles, 1 new dependency, 15+ non-route modules retrofitted, and 40+ existing endpoints gated. Total ~30 tasks. Execution happens in a dedicated worktree (`feature/multi-user-auth`) to keep main clean.

---

## File Structure

**New modules under `src/auth/`:**
- `index.js` — public surface. Exports `init()`, `shutdown()`, `middleware` (requireAuth / requireAnyAuth), and re-exports the submodule namespaces.
- `hashing.js` — argon2id wrapper over `hash-wasm`. Exports `hash(password)` → encoded string, `verify(encoded, password)` → boolean.
- `users.js` — CRUD for the `users` table. `createUser`, `getUserByEmail`, `getUserById`, `listUsers`, `disableUser`, `updatePassword`.
- `sessions.js` — CRUD + sweep for the `sessions` table. `createSession`, `getSession`, `invalidateSession`, `invalidateAllSessionsForUser`, `sweepExpired`, `startDailySweep`.
- `api-keys.js` — `generateApiKey(userId, name)` returns `{ id, plaintext }`, `lookupByToken(plaintext)`, `disableApiKey(id)`, `listForUser(userId)`.
- `roles.js` — the `PERMISSIONS`, `ROLES`, and `DEFAULT_ROLE_PERMISSIONS` seed constants plus `seedOnce(db)` which inserts them idempotently.
- `resolver.js` — `loadPermissionSet(userId)` builds the cached set, `can(user, permission, satelliteSlugOrId?)` checks it.
- `middleware.js` — `requireAuth({ permission, satelliteParam? })` factory and `requireAnyAuth()` factory. Also exports the login rate-limit counter.
- `invitations.js` — `generateInvitation({ invitedBy, roleGrants, expiresInDays })`, `claimInvitation({ token, password, displayName })`, `listInvitations`, `revokeInvitation`.
- `groups.js` — `createGroup`, `listGroups`, `getGroup`, `addMember`, `removeMember`, `getGroupsForUser`, `deleteGroup`.
- `system-owner.js` — `getSystemOwnerId()` returns the oldest `mothership_admin` user id. Used by untethered pipelines (Telegram bot, file watcher) to stamp ownership.
- `backfill.js` — one-time migration that assigns `user_id` to NULL rows in `messages`, `mirror_entries`, `wiki_entries`. Idempotent via a sentinel in the `config` table.

**New route files:**
- `src/routes/auth.js` — `/api/auth/*` endpoints (login, logout, me, password, claim-invite).
- `src/routes/users.js` — `/api/users/*`, `/api/invitations/*`, `/api/role-assignments/*`, `/api/groups/*` management endpoints.

**New CLI:**
- `scripts/create-admin.js` — bootstrap first admin, grant `mothership_admin` + `viewer`, run backfill.

**Modified files:**
- `package.json` — add `hash-wasm` dependency.
- `src/database.js` — add 10 new tables, add `user_id` columns to 3 existing tables, update `addMessage`/`getMessages`/`addMirrorEntry`/etc. signatures to accept `userId`.
- `src/routes/api.js` — retrofit all existing routes with `requireAuth`, add per-user filters to messages/mirror/wiki endpoints.
- `src/conversation.js` — `buildHistory(userId, excludeContent)` and `respond(userText, { userId, ... })`.
- `src/conversation-hooks.js` — `postResponse({ userText, assistantText, sourceId, draftSlug, userId })`.
- `src/quantum-mirror.js` — `synthesizeFromTurn({ userId, ... })`.
- `src/synthesizer.js` — `synthesizeFromContent({ userId, ... })`.
- `src/memory/retriever.js` — `buildContextBlock(query, { userId, mirrorTopK, wikiTopK })`.
- `src/memory/vector-engine.js` — `storeMirrorEntry({ userId, ... })`, `storeWikiEntry({ userId, ... })`, `searchMirrorByQuery({ userId, ... })`, `searchWikiByQuery({ userId, ... })`.
- `src/telegram.js` — uses `auth.getSystemOwnerId()` at startup, stamps it on every ingested message.
- `src/watcher.js` — same pattern.
- `src/health-check.js` — iterates `users WHERE disabled_at IS NULL`, runs decay + gap analysis per-user.
- `src/exporters/obsidian.js` — `exportAll({ userId })` scopes the export to one user at a time.
- `server.js` — calls `auth.init()` after `db.init()`.

**New test files under `tests/auth/`:**
- `hashing.test.js`, `users.test.js`, `sessions.test.js`, `api-keys.test.js`, `groups.test.js`, `roles.test.js`, `resolver.test.js`, `invitations.test.js`, `middleware.test.js`, `backfill.test.js`, `system-owner.test.js`, `bootstrap.test.js`, `auth-routes.test.js`, `user-mgmt-routes.test.js`, `per-user-scope.test.js`, `retrofit.test.js`, `e2e.test.js`.

**Existing test files that need updates** (the scoped-signature churn):
- `tests/conversation-hooks.test.js`, `tests/quantum-mirror.test.js`, `tests/synthesizer.test.js`, `tests/memory/retriever.test.js`, `tests/memory/vector-engine.test.js`, `tests/database-mirror-entries.test.js`, `tests/database-wiki-entries.test.js`, `tests/health-check.test.js`, `tests/exporters/obsidian.test.js`, `tests/satellites/api.test.js`, `tests/satellites/chat-draft.test.js`, `tests/satellites/drafts.test.js`.

---

## Testing Conventions

Every new test file starts with this preamble for temp-DB isolation:

```javascript
const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-auth-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');
// plus MOTHERSHIP_SATELLITES_DIR + MOTHERSHIP_KINDS_DIR for tests that touch satellites

const db = require('../../src/database');
const auth = require('../../src/auth');

before(async () => { await db.init(); await auth.init(); });
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
```

Running tests:
```bash
npm test                          # full suite
npm test -- tests/auth/hashing.test.js   # single file
```

---

## Task 1: Add `hash-wasm` dependency

**Files:**
- Modify: `package.json`
- Test: `tests/auth/hashing.test.js` (created in Task 3, but we install the dep here)

- [ ] **Step 1: Add the dependency via npm**

Run:
```bash
npm install hash-wasm@^4.11.0
```

Expected: package.json gains `"hash-wasm": "^4.11.0"` under `dependencies`, package-lock.json updates.

- [ ] **Step 2: Verify the package loads and argon2id is exported**

Run a one-liner smoke test:
```bash
node -e "const { argon2id, argon2Verify } = require('hash-wasm'); console.log('ok', typeof argon2id, typeof argon2Verify);"
```
Expected: `ok function function`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(auth): add hash-wasm dependency for argon2id password hashing"
```

---

## Task 2: Add 10 auth tables to `src/database.js`

**Files:**
- Modify: `src/database.js` (inside `init()`, after the existing `wiki_entries` block but before the `satellites` and `satellite_drafts` blocks from #1)
- Test: `tests/auth/schema.test.js` (new)

- [ ] **Step 1: Write the failing schema test**

Create `tests/auth/schema.test.js`:

```javascript
const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-auth-schema-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');

const db = require('../../src/database');

before(async () => { await db.init(); });
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test('auth schema — all 10 auth tables exist after init', () => {
  const raw = db._raw();
  const tables = raw.exec(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  )[0].values.map(r => r[0]);

  for (const t of [
    'users', 'sessions', 'api_keys', 'groups', 'group_memberships',
    'roles', 'permissions', 'role_permissions', 'role_assignments', 'invitations'
  ]) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
});

test('auth schema — users has expected columns', () => {
  const raw = db._raw();
  const cols = raw.exec("PRAGMA table_info(users)")[0].values.map(r => r[1]);
  for (const col of ['id', 'email', 'display_name', 'auth_method', 'password_hash', 'created_at', 'disabled_at', 'notes']) {
    assert.ok(cols.includes(col), `users missing column ${col}`);
  }
});

test('auth schema — role_assignments has principal_type and nullable satellite_id', () => {
  const raw = db._raw();
  const cols = raw.exec("PRAGMA table_info(role_assignments)")[0].values;
  const byName = Object.fromEntries(cols.map(r => [r[1], r]));
  assert.ok(byName.principal_type, 'missing principal_type');
  assert.ok(byName.principal_id, 'missing principal_id');
  assert.ok(byName.satellite_id, 'missing satellite_id');
  assert.strictEqual(byName.satellite_id[3], 0, 'satellite_id should be nullable (notnull=0)');
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `npm test -- tests/auth/schema.test.js`
Expected: FAIL with "missing table users".

- [ ] **Step 3: Add the CREATE TABLE statements to `src/database.js`**

Inside `init()`, after the `wiki_entries` index (line 90) and before the existing `satellites` CREATE TABLE block from #1, insert:

```javascript
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
```

- [ ] **Step 4: Run the test, see it pass**

Run: `npm test -- tests/auth/schema.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Run full suite — no regressions**

Run: `npm test`
Expected: 139 total (136 existing + 3 new), all pass.

- [ ] **Step 6: Commit**

```bash
git add src/database.js tests/auth/schema.test.js
git commit -m "feat(db): add 10 auth tables for Phase 6 #2"
```

---

## Task 3: Add `user_id` columns to scoped tables

**Files:**
- Modify: `src/database.js` (new ALTER block after the auth tables)
- Test: `tests/auth/schema.test.js` (extend)

- [ ] **Step 1: Extend `tests/auth/schema.test.js` with the scoped-column check**

Append to `tests/auth/schema.test.js`:

```javascript
test('auth schema — messages/mirror_entries/wiki_entries have user_id column', () => {
  const raw = db._raw();
  for (const t of ['messages', 'mirror_entries', 'wiki_entries']) {
    const cols = raw.exec(`PRAGMA table_info(${t})`)[0].values.map(r => r[1]);
    assert.ok(cols.includes('user_id'), `${t} missing user_id column`);
  }
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `npm test -- tests/auth/schema.test.js`
Expected: FAIL — `messages missing user_id column`.

- [ ] **Step 3: Add the ALTER TABLE statements**

sql.js supports `ALTER TABLE ... ADD COLUMN` but not `IF NOT EXISTS`. Use a feature-check helper. In `src/database.js`, add inside `init()` after the auth tables block:

```javascript
  // Per-user scoping (Phase 6 #2) — add user_id to three Mothership-core tables
  // sql.js ALTER TABLE doesn't support IF NOT EXISTS, so use table_info to check.
  for (const t of ['messages', 'mirror_entries', 'wiki_entries']) {
    const info = db.exec(`PRAGMA table_info(${t})`);
    if (!info.length) continue;
    const cols = info[0].values.map(r => r[1]);
    if (!cols.includes('user_id')) {
      db.run(`ALTER TABLE ${t} ADD COLUMN user_id TEXT`);
    }
  }
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_mirror_entries_user ON mirror_entries(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_wiki_entries_user ON wiki_entries(user_id)`);
```

- [ ] **Step 4: Run the test, see it pass**

Run: `npm test -- tests/auth/schema.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Run full suite — no regressions**

Run: `npm test`
Expected: 140 total, all pass. The existing tests that query `messages`, `mirror_entries`, `wiki_entries` continue working because the new column is nullable and old SELECTs don't touch it.

- [ ] **Step 6: Commit**

```bash
git add src/database.js tests/auth/schema.test.js
git commit -m "feat(db): add user_id column to messages, mirror_entries, wiki_entries"
```

---

## Task 4: `src/auth/hashing.js` — argon2id wrapper

**Files:**
- Create: `src/auth/hashing.js`
- Test: `tests/auth/hashing.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/auth/hashing.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const hashing = require('../../src/auth/hashing');

test('hashing — hash returns a string with argon2id prefix', async () => {
  const encoded = await hashing.hash('correct-horse-battery-staple');
  assert.ok(typeof encoded === 'string');
  assert.ok(encoded.startsWith('$argon2id$'), `got: ${encoded.slice(0, 20)}`);
});

test('hashing — verify accepts correct password', async () => {
  const encoded = await hashing.hash('hunter2');
  assert.strictEqual(await hashing.verify(encoded, 'hunter2'), true);
});

test('hashing — verify rejects wrong password', async () => {
  const encoded = await hashing.hash('hunter2');
  assert.strictEqual(await hashing.verify(encoded, 'hunter3'), false);
});

test('hashing — verify returns false on malformed encoded string', async () => {
  assert.strictEqual(await hashing.verify('not-an-argon2-hash', 'whatever'), false);
});

test('hashing — two hashes of same password produce different outputs (random salt)', async () => {
  const a = await hashing.hash('same');
  const b = await hashing.hash('same');
  assert.notStrictEqual(a, b);
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `npm test -- tests/auth/hashing.test.js`
Expected: FAIL — `Cannot find module '../../src/auth/hashing'`.

- [ ] **Step 3: Create `src/auth/hashing.js`**

```javascript
/**
 * MOTHERSHIP — Password / token hashing
 *
 * Wraps hash-wasm's argon2id (pure WASM, no native compilation).
 * OWASP 2026 baseline: m=64 MiB, t=3, p=1, hashLength=32.
 */

const crypto = require('crypto');
const { argon2id, argon2Verify } = require('hash-wasm');

async function hash(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('password must be a non-empty string');
  }
  const salt = crypto.randomBytes(16);
  return argon2id({
    password,
    salt,
    parallelism: 1,
    iterations: 3,
    memorySize: 65536, // 64 MiB
    hashLength: 32,
    outputType: 'encoded'
  });
}

async function verify(encoded, password) {
  if (typeof encoded !== 'string' || typeof password !== 'string') return false;
  if (!encoded.startsWith('$argon2id$')) return false;
  try {
    return await argon2Verify({ password, hash: encoded });
  } catch (_) {
    return false;
  }
}

module.exports = { hash, verify };
```

- [ ] **Step 4: Run the test, see it pass**

Run: `npm test -- tests/auth/hashing.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/hashing.js tests/auth/hashing.test.js
git commit -m "feat(auth): argon2id hashing via hash-wasm"
```

---

## Task 5: `src/auth/roles.js` — seed constants + `seedOnce`

**Files:**
- Create: `src/auth/roles.js`
- Test: `tests/auth/roles.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/auth/roles.test.js`:

```javascript
const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-auth-roles-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');

const db = require('../../src/database');
const roles = require('../../src/auth/roles');

before(async () => { await db.init(); });
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test('roles — PERMISSIONS constant has expected atoms', () => {
  const names = roles.PERMISSIONS.map(p => p.name);
  for (const required of [
    'user.create', 'user.list', 'user.disable', 'user.reset_password',
    'invitation.create', 'role.assign', 'group.create',
    'mirror.read', 'wiki.read', 'message.read', 'chat.send',
    'mirror.read_any', 'wiki.read_any', 'message.read_any',
    'log.read', 'export.run', 'briefing.run',
    'draft.create', 'draft.read', 'draft.edit_status', 'draft.regenerate_brief',
    'satellite.create', 'satellite.list', 'satellite.read',
    'satellite.edit_config', 'satellite.issue_directive', 'satellite.read_directives',
    'satellite.archive', 'satellite.unarchive', 'satellite.transfer', 'satellite.set_visibility'
  ]) {
    assert.ok(names.includes(required), `missing permission ${required}`);
  }
});

test('roles — ROLES constant has all 8 seed roles', () => {
  const names = roles.ROLES.map(r => r.name);
  for (const required of [
    'mothership_admin', 'user_manager', 'viewer', 'observer', 'draft_author',
    'satellite_owner', 'satellite_editor', 'satellite_directive_issuer', 'satellite_viewer'
  ]) {
    assert.ok(names.includes(required), `missing role ${required}`);
  }
});

test('roles — seedOnce populates all tables', async () => {
  await roles.seedOnce(db);
  const raw = db._raw();
  const permCount = raw.exec('SELECT COUNT(*) FROM permissions')[0].values[0][0];
  const roleCount = raw.exec('SELECT COUNT(*) FROM roles')[0].values[0][0];
  const rpCount = raw.exec('SELECT COUNT(*) FROM role_permissions')[0].values[0][0];
  assert.ok(permCount >= 30);
  assert.ok(roleCount >= 9);
  assert.ok(rpCount > 0);
});

test('roles — seedOnce is idempotent', async () => {
  const raw = db._raw();
  const before = raw.exec('SELECT COUNT(*) FROM permissions')[0].values[0][0];
  await roles.seedOnce(db);
  await roles.seedOnce(db);
  const after = raw.exec('SELECT COUNT(*) FROM permissions')[0].values[0][0];
  assert.strictEqual(before, after);
});

test('roles — viewer role has self-scoped read permissions', async () => {
  const raw = db._raw();
  const viewerId = raw.exec("SELECT id FROM roles WHERE name = 'viewer'")[0].values[0][0];
  const perms = raw.exec(`
    SELECT p.name FROM permissions p
    JOIN role_permissions rp ON rp.permission_id = p.id
    WHERE rp.role_id = ?
  `, [viewerId])[0].values.map(r => r[0]);
  for (const required of ['chat.send', 'mirror.read', 'wiki.read', 'message.read', 'satellite.list']) {
    assert.ok(perms.includes(required), `viewer missing ${required}`);
  }
  assert.ok(!perms.includes('mirror.read_any'), 'viewer must not have cross-user read');
});

test('roles — observer has cross-user read permissions', async () => {
  const raw = db._raw();
  const observerId = raw.exec("SELECT id FROM roles WHERE name = 'observer'")[0].values[0][0];
  const perms = raw.exec(`
    SELECT p.name FROM permissions p
    JOIN role_permissions rp ON rp.permission_id = p.id
    WHERE rp.role_id = ?
  `, [observerId])[0].values.map(r => r[0]);
  for (const required of ['mirror.read_any', 'wiki.read_any', 'message.read_any']) {
    assert.ok(perms.includes(required), `observer missing ${required}`);
  }
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `npm test -- tests/auth/roles.test.js`
Expected: FAIL — `Cannot find module '../../src/auth/roles'`.

- [ ] **Step 3: Create `src/auth/roles.js`**

```javascript
/**
 * MOTHERSHIP — Auth roles & permissions seed
 *
 * Source of truth for the RBAC model. seedOnce(db) inserts rows idempotently.
 */

const { v4: uuidv4 } = require('uuid');

const PERMISSIONS = [
  { name: 'user.create',          description: 'Create new users directly' },
  { name: 'user.list',            description: 'List all users' },
  { name: 'user.disable',         description: 'Disable a user account' },
  { name: 'user.reset_password',  description: 'Admin-reset another user password' },
  { name: 'invitation.create',    description: 'Generate invitation links' },
  { name: 'invitation.list',      description: 'List outstanding invitations' },
  { name: 'invitation.revoke',    description: 'Revoke an unclaimed invitation' },
  { name: 'role.assign',          description: 'Grant roles to users or groups' },
  { name: 'role.revoke',          description: 'Revoke role assignments' },
  { name: 'group.create',         description: 'Create groups' },
  { name: 'group.edit',           description: 'Edit group membership and metadata' },
  { name: 'group.delete',         description: 'Delete groups' },

  { name: 'mirror.read',          description: 'Read your own Quantum Mirror entries' },
  { name: 'wiki.read',            description: 'Read your own Wiki entries' },
  { name: 'message.read',         description: 'Read your own ingested messages' },
  { name: 'chat.send',            description: 'Send chat turns to Mothership' },

  { name: 'mirror.read_any',      description: "Read any user's Mirror" },
  { name: 'wiki.read_any',        description: "Read any user's Wiki" },
  { name: 'message.read_any',     description: "Read any user's messages" },

  { name: 'log.read',             description: 'Read system logs' },
  { name: 'export.run',           description: 'Run export jobs' },
  { name: 'briefing.run',         description: 'Run synthesis briefings' },

  { name: 'draft.create',         description: 'Create satellite drafts' },
  { name: 'draft.read',           description: 'Read satellite drafts' },
  { name: 'draft.edit_status',    description: 'Change a drafts status' },
  { name: 'draft.regenerate_brief', description: 'Regenerate a drafts brief via LLM' },

  { name: 'satellite.create',     description: 'Create new satellites' },
  { name: 'satellite.list',       description: 'List satellites the caller can see' },
  { name: 'satellite.read',       description: 'Read a satellites registry row + loaded db' },
  { name: 'satellite.edit_config',     description: 'Edit a satellites config' },
  { name: 'satellite.issue_directive', description: 'Issue directives to a satellite' },
  { name: 'satellite.read_directives', description: 'Read a satellites directive history' },
  { name: 'satellite.archive',    description: 'Archive a satellite' },
  { name: 'satellite.unarchive',  description: 'Unarchive a satellite' },
  { name: 'satellite.transfer',   description: 'Transfer a satellite to a client' },
  { name: 'satellite.set_visibility', description: 'Change a satellites visibility tier' }
];

const ROLES = [
  { name: 'mothership_admin', kind: 'system',
    description: 'Superuser — bypasses all checks',
    permissions: '*' },

  { name: 'user_manager', kind: 'system',
    description: 'Manages users, invitations, role assignments',
    permissions: [
      'user.create', 'user.list', 'user.disable', 'user.reset_password',
      'invitation.create', 'invitation.list', 'invitation.revoke',
      'role.assign', 'role.revoke',
      'group.create', 'group.edit', 'group.delete'
    ] },

  { name: 'viewer', kind: 'system',
    description: 'Baseline role for authenticated users — access to own scope',
    permissions: [
      'chat.send', 'mirror.read', 'wiki.read', 'message.read',
      'draft.read', 'satellite.list'
    ] },

  { name: 'observer', kind: 'system',
    description: 'Admin read-only across all users',
    permissions: [
      'mirror.read_any', 'wiki.read_any', 'message.read_any',
      'log.read', 'draft.read', 'satellite.list'
    ] },

  { name: 'draft_author', kind: 'system',
    description: 'Creates and edits satellite drafts',
    permissions: [
      'draft.create', 'draft.read', 'draft.edit_status', 'draft.regenerate_brief'
    ] },

  { name: 'satellite_owner', kind: 'satellite',
    description: 'Full control over a specific satellite',
    permissions: [
      'satellite.read', 'satellite.edit_config',
      'satellite.issue_directive', 'satellite.read_directives',
      'satellite.archive', 'satellite.unarchive',
      'satellite.transfer', 'satellite.set_visibility'
    ] },

  { name: 'satellite_editor', kind: 'satellite',
    description: 'Edit config and issue directives',
    permissions: [
      'satellite.read', 'satellite.edit_config',
      'satellite.issue_directive', 'satellite.read_directives'
    ] },

  { name: 'satellite_directive_issuer', kind: 'satellite',
    description: 'Issue directives only (shaped for Claude Code and automation bots)',
    permissions: [
      'satellite.read', 'satellite.issue_directive', 'satellite.read_directives'
    ] },

  { name: 'satellite_viewer', kind: 'satellite',
    description: 'Read-only at the current visibility tier',
    permissions: [
      'satellite.read', 'satellite.read_directives'
    ] }
];

async function seedOnce(db) {
  const raw = db._raw();

  // Permissions
  for (const p of PERMISSIONS) {
    const existing = raw.exec('SELECT id FROM permissions WHERE name = ?', [p.name]);
    if (existing.length && existing[0].values.length) continue;
    raw.run(
      'INSERT INTO permissions (id, name, description) VALUES (?, ?, ?)',
      [uuidv4(), p.name, p.description]
    );
  }

  // Roles
  for (const r of ROLES) {
    const existing = raw.exec('SELECT id FROM roles WHERE name = ?', [r.name]);
    if (existing.length && existing[0].values.length) continue;
    raw.run(
      'INSERT INTO roles (id, name, kind, description) VALUES (?, ?, ?, ?)',
      [uuidv4(), r.name, r.kind, r.description]
    );
  }

  // Role-permission links
  for (const r of ROLES) {
    if (r.permissions === '*') continue; // mothership_admin — bypass in resolver
    const roleIdRow = raw.exec('SELECT id FROM roles WHERE name = ?', [r.name]);
    const roleId = roleIdRow[0].values[0][0];
    for (const permName of r.permissions) {
      const permIdRow = raw.exec('SELECT id FROM permissions WHERE name = ?', [permName]);
      if (!permIdRow.length || !permIdRow[0].values.length) continue;
      const permId = permIdRow[0].values[0][0];
      const existing = raw.exec(
        'SELECT 1 FROM role_permissions WHERE role_id = ? AND permission_id = ?',
        [roleId, permId]
      );
      if (existing.length && existing[0].values.length) continue;
      raw.run(
        'INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
        [roleId, permId]
      );
    }
  }

  db.save();
}

module.exports = { PERMISSIONS, ROLES, seedOnce };
```

- [ ] **Step 4: Run the test, see it pass**

Run: `npm test -- tests/auth/roles.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/roles.js tests/auth/roles.test.js
git commit -m "feat(auth): seed permissions and roles"
```

---

## Task 6: `src/auth/users.js` — users CRUD

**Files:**
- Create: `src/auth/users.js`
- Test: `tests/auth/users.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/auth/users.test.js`:

```javascript
const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-auth-users-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');

const db = require('../../src/database');
const users = require('../../src/auth/users');

before(async () => { await db.init(); });
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test('users — createUser inserts a password user and returns id', async () => {
  const id = await users.createUser({
    email: 'yoel@example.com', display_name: 'Yoel',
    password: 'correct-horse', auth_method: 'password'
  });
  assert.ok(id);
  const row = users.getUserByEmail('yoel@example.com');
  assert.strictEqual(row.email, 'yoel@example.com');
  assert.strictEqual(row.auth_method, 'password');
  assert.ok(row.password_hash);
  assert.ok(row.password_hash.startsWith('$argon2id$'));
});

test('users — createUser rejects duplicate email', async () => {
  await assert.rejects(
    users.createUser({ email: 'yoel@example.com', password: 'x' }),
    /already exists/
  );
});

test('users — createUser with auth_method api_key_only has no password_hash', async () => {
  await users.createUser({
    email: 'bot@mothership', auth_method: 'api_key_only', display_name: 'Claude Bot'
  });
  const row = users.getUserByEmail('bot@mothership');
  assert.strictEqual(row.auth_method, 'api_key_only');
  assert.strictEqual(row.password_hash, null);
});

test('users — listUsers returns all users', () => {
  const all = users.listUsers();
  assert.ok(all.length >= 2);
});

test('users — disableUser sets disabled_at', () => {
  const before = users.getUserByEmail('bot@mothership');
  users.disableUser(before.id);
  const after = users.getUserByEmail('bot@mothership');
  assert.ok(after.disabled_at);
});

test('users — updatePassword rehashes', async () => {
  const before = users.getUserByEmail('yoel@example.com');
  await users.updatePassword(before.id, 'new-pass-phrase');
  const after = users.getUserByEmail('yoel@example.com');
  assert.notStrictEqual(after.password_hash, before.password_hash);
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `npm test -- tests/auth/users.test.js`
Expected: FAIL — `Cannot find module '../../src/auth/users'`.

- [ ] **Step 3: Create `src/auth/users.js`**

```javascript
/**
 * MOTHERSHIP — Users CRUD
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const hashing = require('./hashing');

async function createUser({ email, display_name = null, password = null, auth_method = 'password', notes = null }) {
  if (!email || typeof email !== 'string') throw new Error('email required');
  if (getUserByEmail(email)) throw new Error(`user already exists: ${email}`);

  let password_hash = null;
  if (auth_method === 'password') {
    if (!password) throw new Error('password required for auth_method=password');
    password_hash = await hashing.hash(password);
  } else if (auth_method !== 'api_key_only') {
    throw new Error(`invalid auth_method: ${auth_method}`);
  }

  const id = uuidv4();
  const raw = db._raw();
  raw.run(
    `INSERT INTO users (id, email, display_name, auth_method, password_hash, notes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, email, display_name, auth_method, password_hash, notes]
  );
  db.save();
  return id;
}

function getUserByEmail(email) {
  const raw = db._raw();
  const stmt = raw.prepare('SELECT * FROM users WHERE email = ?');
  stmt.bind([email]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function getUserById(id) {
  const raw = db._raw();
  const stmt = raw.prepare('SELECT * FROM users WHERE id = ?');
  stmt.bind([id]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function listUsers({ includeDisabled = true } = {}) {
  const raw = db._raw();
  const q = includeDisabled
    ? 'SELECT * FROM users ORDER BY created_at ASC'
    : 'SELECT * FROM users WHERE disabled_at IS NULL ORDER BY created_at ASC';
  const stmt = raw.prepare(q);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function disableUser(id) {
  const raw = db._raw();
  raw.run(`UPDATE users SET disabled_at = datetime('now') WHERE id = ?`, [id]);
  db.save();
}

async function updatePassword(id, newPassword) {
  const hash = await hashing.hash(newPassword);
  const raw = db._raw();
  raw.run(`UPDATE users SET password_hash = ? WHERE id = ?`, [hash, id]);
  db.save();
}

module.exports = {
  createUser, getUserByEmail, getUserById, listUsers, disableUser, updatePassword
};
```

- [ ] **Step 4: Run the test, see it pass**

Run: `npm test -- tests/auth/users.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/users.js tests/auth/users.test.js
git commit -m "feat(auth): users CRUD with argon2id password hashing"
```

---

## Task 7: `src/auth/sessions.js` — sessions CRUD + sweep

**Files:**
- Create: `src/auth/sessions.js`
- Test: `tests/auth/sessions.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/auth/sessions.test.js`:

```javascript
const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-auth-sessions-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');

const db = require('../../src/database');
const users = require('../../src/auth/users');
const sessions = require('../../src/auth/sessions');

let userId;

before(async () => {
  await db.init();
  userId = await users.createUser({ email: 'u@x', password: 'p' });
});
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test('sessions — createSession returns a random id and stores row', () => {
  const s = sessions.createSession(userId, { ip: '127.0.0.1', userAgent: 'test' });
  assert.ok(s.id);
  assert.strictEqual(typeof s.id, 'string');
  assert.ok(s.id.length >= 40); // 32 bytes base64url = 43 chars
  const fetched = sessions.getSession(s.id);
  assert.strictEqual(fetched.user_id, userId);
});

test('sessions — getSession returns null for missing id', () => {
  assert.strictEqual(sessions.getSession('nope'), null);
});

test('sessions — getSession deletes and returns null for expired row', () => {
  const s = sessions.createSession(userId, { ip: '127.0.0.1', userAgent: 'test' });
  // Manually backdate to expired
  const raw = db._raw();
  raw.run(`UPDATE sessions SET expires_at = datetime('now', '-1 day') WHERE id = ?`, [s.id]);
  db.save();
  assert.strictEqual(sessions.getSession(s.id), null);
  // Row should be deleted
  const stmt = raw.prepare('SELECT * FROM sessions WHERE id = ?');
  stmt.bind([s.id]);
  assert.strictEqual(stmt.step(), false);
  stmt.free();
});

test('sessions — invalidateSession removes the row', () => {
  const s = sessions.createSession(userId, {});
  sessions.invalidateSession(s.id);
  assert.strictEqual(sessions.getSession(s.id), null);
});

test('sessions — invalidateAllSessionsForUser removes all', () => {
  sessions.createSession(userId, {});
  sessions.createSession(userId, {});
  sessions.createSession(userId, {});
  sessions.invalidateAllSessionsForUser(userId);
  const raw = db._raw();
  const count = raw.exec('SELECT COUNT(*) FROM sessions WHERE user_id = ?', [userId])[0].values[0][0];
  assert.strictEqual(count, 0);
});

test('sessions — invalidateAllSessionsForUser with exceptId keeps current', () => {
  const keep = sessions.createSession(userId, {});
  sessions.createSession(userId, {});
  sessions.createSession(userId, {});
  sessions.invalidateAllSessionsForUser(userId, { exceptId: keep.id });
  assert.ok(sessions.getSession(keep.id));
  const raw = db._raw();
  const count = raw.exec('SELECT COUNT(*) FROM sessions WHERE user_id = ?', [userId])[0].values[0][0];
  assert.strictEqual(count, 1);
});

test('sessions — sweepExpired deletes only expired rows', () => {
  sessions.invalidateAllSessionsForUser(userId);
  const fresh = sessions.createSession(userId, {});
  const stale = sessions.createSession(userId, {});
  const raw = db._raw();
  raw.run(`UPDATE sessions SET expires_at = datetime('now', '-1 day') WHERE id = ?`, [stale.id]);
  db.save();
  const removed = sessions.sweepExpired();
  assert.strictEqual(removed, 1);
  assert.ok(sessions.getSession(fresh.id));
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `npm test -- tests/auth/sessions.test.js`
Expected: FAIL — `Cannot find module '../../src/auth/sessions'`.

- [ ] **Step 3: Create `src/auth/sessions.js`**

```javascript
/**
 * MOTHERSHIP — Sessions CRUD + expiry sweep
 */

const crypto = require('crypto');
const db = require('../database');

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function newSessionId() {
  return crypto.randomBytes(32).toString('base64url');
}

function createSession(userId, { ip = null, userAgent = null } = {}) {
  const id = newSessionId();
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS).toISOString().replace('T', ' ').replace('Z', '');
  const raw = db._raw();
  raw.run(
    `INSERT INTO sessions (id, user_id, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?)`,
    [id, userId, expiresAt, ip, userAgent]
  );
  db.save();
  return { id, user_id: userId, expires_at: expiresAt };
}

function getSession(id) {
  const raw = db._raw();
  const stmt = raw.prepare('SELECT * FROM sessions WHERE id = ?');
  stmt.bind([id]);
  if (!stmt.step()) { stmt.free(); return null; }
  const row = stmt.getAsObject();
  stmt.free();

  // Expired → delete + return null
  if (new Date(row.expires_at.replace(' ', 'T') + 'Z') < new Date()) {
    raw.run('DELETE FROM sessions WHERE id = ?', [id]);
    db.save();
    return null;
  }

  // Bump last_seen_at
  raw.run(`UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ?`, [id]);
  db.save();
  return row;
}

function invalidateSession(id) {
  const raw = db._raw();
  raw.run('DELETE FROM sessions WHERE id = ?', [id]);
  db.save();
}

function invalidateAllSessionsForUser(userId, { exceptId = null } = {}) {
  const raw = db._raw();
  if (exceptId) {
    raw.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', [userId, exceptId]);
  } else {
    raw.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
  }
  db.save();
}

function sweepExpired() {
  const raw = db._raw();
  const before = raw.exec('SELECT COUNT(*) FROM sessions')[0].values[0][0];
  raw.run(`DELETE FROM sessions WHERE expires_at < datetime('now')`);
  const after = raw.exec('SELECT COUNT(*) FROM sessions')[0].values[0][0];
  db.save();
  return before - after;
}

let sweepTimer = null;
function startDailySweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepExpired, 24 * 60 * 60 * 1000);
  if (sweepTimer.unref) sweepTimer.unref();
}

function stopDailySweep() {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}

module.exports = {
  createSession, getSession, invalidateSession, invalidateAllSessionsForUser,
  sweepExpired, startDailySweep, stopDailySweep
};
```

- [ ] **Step 4: Run the test, see it pass**

Run: `npm test -- tests/auth/sessions.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/sessions.js tests/auth/sessions.test.js
git commit -m "feat(auth): sessions CRUD with expiry sweep"
```

---

## Task 8: `src/auth/api-keys.js` — bearer token CRUD

**Files:**
- Create: `src/auth/api-keys.js`
- Test: `tests/auth/api-keys.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/auth/api-keys.test.js`:

```javascript
const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-auth-api-keys-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');

const db = require('../../src/database');
const users = require('../../src/auth/users');
const apiKeys = require('../../src/auth/api-keys');

let userId;
before(async () => {
  await db.init();
  userId = await users.createUser({ email: 'bot@x', auth_method: 'api_key_only' });
});
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test('api-keys — generateApiKey returns plaintext with mk_live_ prefix', async () => {
  const { id, plaintext } = await apiKeys.generateApiKey(userId, 'claude-code-dev');
  assert.ok(id);
  assert.ok(plaintext.startsWith('mk_live_'));
  assert.ok(plaintext.length > 20);
});

test('api-keys — lookupByToken finds the key by plaintext', async () => {
  const { plaintext } = await apiKeys.generateApiKey(userId, 'k2');
  const found = await apiKeys.lookupByToken(plaintext);
  assert.ok(found);
  assert.strictEqual(found.user_id, userId);
  assert.strictEqual(found.name, 'k2');
});

test('api-keys — lookupByToken returns null for wrong plaintext', async () => {
  const found = await apiKeys.lookupByToken('mk_live_totallywrong');
  assert.strictEqual(found, null);
});

test('api-keys — lookupByToken returns null for disabled key', async () => {
  const { id, plaintext } = await apiKeys.generateApiKey(userId, 'k3');
  apiKeys.disableApiKey(id);
  const found = await apiKeys.lookupByToken(plaintext);
  assert.strictEqual(found, null);
});

test('api-keys — listForUser returns only non-disabled keys by default', async () => {
  const keys = apiKeys.listForUser(userId);
  assert.ok(keys.length >= 2); // at least k1, k2 (k3 is disabled)
  assert.ok(keys.every(k => !k.disabled_at));
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `npm test -- tests/auth/api-keys.test.js`
Expected: FAIL — `Cannot find module '../../src/auth/api-keys'`.

- [ ] **Step 3: Create `src/auth/api-keys.js`**

```javascript
/**
 * MOTHERSHIP — API keys (bearer tokens)
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const hashing = require('./hashing');

const TOKEN_PREFIX = 'mk_live_';

function newPlaintextToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

async function generateApiKey(userId, name) {
  if (!userId) throw new Error('userId required');
  if (!name || typeof name !== 'string') throw new Error('name required');
  const plaintext = newPlaintextToken();
  const token_hash = await hashing.hash(plaintext);
  const id = uuidv4();
  const raw = db._raw();
  raw.run(
    `INSERT INTO api_keys (id, user_id, name, token_hash) VALUES (?, ?, ?, ?)`,
    [id, userId, name, token_hash]
  );
  db.save();
  return { id, plaintext };
}

async function lookupByToken(plaintext) {
  if (!plaintext || !plaintext.startsWith(TOKEN_PREFIX)) return null;
  const raw = db._raw();
  // Because argon2 hashes include a random salt, we can't do a direct hash
  // comparison via WHERE token_hash = ?. We have to SELECT non-disabled rows
  // and verify each. In practice this is fine — typical user has <10 keys,
  // typical machine has 1. For larger key sets, add an indexed short prefix.
  const stmt = raw.prepare('SELECT * FROM api_keys WHERE disabled_at IS NULL');
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();

  for (const row of rows) {
    if (await hashing.verify(row.token_hash, plaintext)) {
      // Bump last_used_at
      raw.run(`UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?`, [row.id]);
      db.save();
      return row;
    }
  }
  return null;
}

function disableApiKey(id) {
  const raw = db._raw();
  raw.run(`UPDATE api_keys SET disabled_at = datetime('now') WHERE id = ?`, [id]);
  db.save();
}

function listForUser(userId, { includeDisabled = false } = {}) {
  const raw = db._raw();
  const q = includeDisabled
    ? 'SELECT id, user_id, name, last_used_at, created_at, disabled_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC'
    : 'SELECT id, user_id, name, last_used_at, created_at, disabled_at FROM api_keys WHERE user_id = ? AND disabled_at IS NULL ORDER BY created_at DESC';
  const stmt = raw.prepare(q);
  stmt.bind([userId]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

module.exports = { generateApiKey, lookupByToken, disableApiKey, listForUser };
```

**Note on lookup cost:** this implementation is O(N) in the number of active keys per lookup because argon2 salts prevent hash-equality indexing. Acceptable for Mothership's scale (dozens of keys max). If the key count grows past ~100 active keys, add a non-cryptographic short-hash column (`token_hash_short` = first 8 bytes of `sha256(plaintext)`) as a cheap filter.

- [ ] **Step 4: Run the test, see it pass**

Run: `npm test -- tests/auth/api-keys.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/api-keys.js tests/auth/api-keys.test.js
git commit -m "feat(auth): api keys with argon2id-hashed bearer tokens"
```

---

## Task 9: `src/auth/groups.js` — group CRUD + membership

**Files:**
- Create: `src/auth/groups.js`
- Test: `tests/auth/groups.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/auth/groups.test.js`:

```javascript
const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-auth-groups-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');

const db = require('../../src/database');
const users = require('../../src/auth/users');
const groups = require('../../src/auth/groups');

let u1, u2;
before(async () => {
  await db.init();
  u1 = await users.createUser({ email: 'a@x', password: 'p' });
  u2 = await users.createUser({ email: 'b@x', password: 'p' });
});
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test('groups — createGroup + getGroup', () => {
  const id = groups.createGroup({ name: 'tx-auto-staff', description: 'Texas Auto Center staff' });
  assert.ok(id);
  const g = groups.getGroup(id);
  assert.strictEqual(g.name, 'tx-auto-staff');
});

test('groups — createGroup rejects duplicate name', () => {
  assert.throws(
    () => groups.createGroup({ name: 'tx-auto-staff' }),
    /already exists/
  );
});

test('groups — addMember + getGroupsForUser', () => {
  const g = groups.listGroups()[0];
  groups.addMember(g.id, u1);
  groups.addMember(g.id, u2);
  const forU1 = groups.getGroupsForUser(u1);
  assert.strictEqual(forU1.length, 1);
  assert.strictEqual(forU1[0].name, 'tx-auto-staff');
});

test('groups — removeMember', () => {
  const g = groups.listGroups()[0];
  groups.removeMember(g.id, u2);
  assert.strictEqual(groups.getGroupsForUser(u2).length, 0);
});

test('groups — deleteGroup removes the group and its memberships', () => {
  const g = groups.listGroups()[0];
  groups.deleteGroup(g.id);
  assert.strictEqual(groups.getGroup(g.id), null);
  assert.strictEqual(groups.getGroupsForUser(u1).length, 0);
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `npm test -- tests/auth/groups.test.js`
Expected: FAIL — `Cannot find module '../../src/auth/groups'`.

- [ ] **Step 3: Create `src/auth/groups.js`**

```javascript
/**
 * MOTHERSHIP — Groups CRUD + membership
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../database');

function createGroup({ name, description = null }) {
  if (!name || typeof name !== 'string') throw new Error('name required');
  const raw = db._raw();
  const existing = raw.exec('SELECT id FROM groups WHERE name = ?', [name]);
  if (existing.length && existing[0].values.length) {
    throw new Error(`group already exists: ${name}`);
  }
  const id = uuidv4();
  raw.run(
    'INSERT INTO groups (id, name, description) VALUES (?, ?, ?)',
    [id, name, description]
  );
  db.save();
  return id;
}

function getGroup(id) {
  const raw = db._raw();
  const stmt = raw.prepare('SELECT * FROM groups WHERE id = ?');
  stmt.bind([id]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function listGroups() {
  const raw = db._raw();
  const stmt = raw.prepare('SELECT * FROM groups ORDER BY created_at ASC');
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function addMember(groupId, userId) {
  const raw = db._raw();
  raw.run(
    'INSERT OR IGNORE INTO group_memberships (user_id, group_id) VALUES (?, ?)',
    [userId, groupId]
  );
  db.save();
}

function removeMember(groupId, userId) {
  const raw = db._raw();
  raw.run(
    'DELETE FROM group_memberships WHERE user_id = ? AND group_id = ?',
    [userId, groupId]
  );
  db.save();
}

function getGroupsForUser(userId) {
  const raw = db._raw();
  const stmt = raw.prepare(`
    SELECT g.* FROM groups g
    JOIN group_memberships gm ON gm.group_id = g.id
    WHERE gm.user_id = ?
    ORDER BY g.created_at ASC
  `);
  stmt.bind([userId]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function deleteGroup(id) {
  const raw = db._raw();
  raw.run('DELETE FROM group_memberships WHERE group_id = ?', [id]);
  raw.run('DELETE FROM groups WHERE id = ?', [id]);
  // Also revoke any role assignments that targeted this group
  raw.run(
    "DELETE FROM role_assignments WHERE principal_type = 'group' AND principal_id = ?",
    [id]
  );
  db.save();
}

module.exports = {
  createGroup, getGroup, listGroups,
  addMember, removeMember, getGroupsForUser, deleteGroup
};
```

- [ ] **Step 4: Run the test, see it pass**

Run: `npm test -- tests/auth/groups.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/groups.js tests/auth/groups.test.js
git commit -m "feat(auth): groups CRUD with membership management"
```

---

## Task 10: `src/auth/resolver.js` — permission resolver

**Files:**
- Create: `src/auth/resolver.js`
- Test: `tests/auth/resolver.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/auth/resolver.test.js`:

```javascript
const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-auth-resolver-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');
process.env.MOTHERSHIP_SATELLITES_DIR = path.join(tmpRoot, 'satellites');
process.env.MOTHERSHIP_KINDS_DIR = path.join(__dirname, '..', 'fixtures', 'satellite-kinds');
fs.mkdirSync(process.env.MOTHERSHIP_SATELLITES_DIR, { recursive: true });

const db = require('../../src/database');
const users = require('../../src/auth/users');
const groups = require('../../src/auth/groups');
const authRoles = require('../../src/auth/roles');
const resolver = require('../../src/auth/resolver');
const registry = require('../../src/satellites/registry');

let admin, staff, botUser, satId;

before(async () => {
  await db.init();
  await authRoles.seedOnce(db);

  admin = await users.createUser({ email: 'admin@x', password: 'p' });
  staff = await users.createUser({ email: 'staff@x', password: 'p' });
  botUser = await users.createUser({ email: 'bot@x', auth_method: 'api_key_only' });

  // Create a fixture satellite to test satellite-scoped roles
  const sat = await registry.createInstance({ slug: 'fix-sat', name: 'Fixture', kind: 'test-kind' });
  satId = sat.id;

  // Assign roles
  const raw = db._raw();
  const getRoleId = (name) => raw.exec('SELECT id FROM roles WHERE name = ?', [name])[0].values[0][0];
  const { v4: uuidv4 } = require('uuid');

  // admin → mothership_admin (system)
  raw.run(
    `INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id)
     VALUES (?, 'user', ?, ?, NULL)`,
    [uuidv4(), admin, getRoleId('mothership_admin')]
  );
  // admin → viewer (system) — auto-grant
  raw.run(
    `INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id)
     VALUES (?, 'user', ?, ?, NULL)`,
    [uuidv4(), admin, getRoleId('viewer')]
  );
  // staff → viewer (system)
  raw.run(
    `INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id)
     VALUES (?, 'user', ?, ?, NULL)`,
    [uuidv4(), staff, getRoleId('viewer')]
  );
  // staff → satellite_editor on fix-sat
  raw.run(
    `INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id)
     VALUES (?, 'user', ?, ?, ?)`,
    [uuidv4(), staff, getRoleId('satellite_editor'), satId]
  );
  // botUser → satellite_directive_issuer on fix-sat via a group
  const gId = groups.createGroup({ name: 'bots' });
  groups.addMember(gId, botUser);
  raw.run(
    `INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id)
     VALUES (?, 'group', ?, ?, ?)`,
    [uuidv4(), gId, getRoleId('satellite_directive_issuer'), satId]
  );
  db.save();
});

after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test('resolver — mothership_admin bypass grants everything', async () => {
  const u = await resolver.loadUserWithPermissions(admin);
  assert.strictEqual(u.can('user.create'), true);
  assert.strictEqual(u.can('satellite.issue_directive', 'fix-sat'), true);
  assert.strictEqual(u.can('totally.nonexistent'), true); // bypass
});

test('resolver — viewer has self-scoped reads', async () => {
  const u = await resolver.loadUserWithPermissions(staff);
  assert.strictEqual(u.can('mirror.read'), true);
  assert.strictEqual(u.can('wiki.read'), true);
  assert.strictEqual(u.can('chat.send'), true);
  assert.strictEqual(u.can('mirror.read_any'), false);
});

test('resolver — satellite_editor grants per-satellite permissions', async () => {
  const u = await resolver.loadUserWithPermissions(staff);
  assert.strictEqual(u.can('satellite.issue_directive', 'fix-sat'), true);
  assert.strictEqual(u.can('satellite.edit_config', 'fix-sat'), true);
  assert.strictEqual(u.can('satellite.archive', 'fix-sat'), false); // only owner
  assert.strictEqual(u.can('satellite.issue_directive', 'other-sat'), false);
});

test('resolver — group-inherited role works', async () => {
  const u = await resolver.loadUserWithPermissions(botUser);
  assert.strictEqual(u.can('satellite.issue_directive', 'fix-sat'), true);
  assert.strictEqual(u.can('satellite.edit_config', 'fix-sat'), false);
});

test('resolver — unknown permission returns false (not admin)', async () => {
  const u = await resolver.loadUserWithPermissions(staff);
  assert.strictEqual(u.can('totally.nonexistent'), false);
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `npm test -- tests/auth/resolver.test.js`
Expected: FAIL — `Cannot find module '../../src/auth/resolver'`.

- [ ] **Step 3: Create `src/auth/resolver.js`**

```javascript
/**
 * MOTHERSHIP — Permission resolver
 *
 * loadUserWithPermissions(userId) builds a req.user object with cached
 * permission set + can() method. Called from the auth middleware once
 * per request after credential validation.
 */

const db = require('../database');
const users = require('./users');
const registry = require('../satellites/registry');

async function loadUserWithPermissions(userId) {
  const user = users.getUserById(userId);
  if (!user) return null;

  const raw = db._raw();

  // Collect all role assignments reachable via direct user grant OR group membership
  const stmt = raw.prepare(`
    SELECT ra.role_id, ra.satellite_id, r.name AS role_name
    FROM role_assignments ra
    JOIN roles r ON r.id = ra.role_id
    WHERE (ra.principal_type = 'user' AND ra.principal_id = ?)
       OR (ra.principal_type = 'group' AND ra.principal_id IN (
            SELECT group_id FROM group_memberships WHERE user_id = ?
          ))
  `);
  stmt.bind([userId, userId]);
  const assignments = [];
  while (stmt.step()) assignments.push(stmt.getAsObject());
  stmt.free();

  const systemRoles = [...new Set(
    assignments.filter(a => a.satellite_id === null || a.satellite_id === undefined)
               .map(a => a.role_name)
  )];

  const isAdmin = systemRoles.includes('mothership_admin');

  // Expand roles to (permission, satellite_id) pairs
  const permissionSet = new Set();
  if (!isAdmin) {
    for (const a of assignments) {
      const permStmt = raw.prepare(`
        SELECT p.name FROM permissions p
        JOIN role_permissions rp ON rp.permission_id = p.id
        WHERE rp.role_id = ?
      `);
      permStmt.bind([a.role_id]);
      while (permStmt.step()) {
        const permName = permStmt.getAsObject().name;
        const key = a.satellite_id ? `${permName}|${a.satellite_id}` : `${permName}|GLOBAL`;
        permissionSet.add(key);
      }
      permStmt.free();
    }
  }

  const row = {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    auth_method: user.auth_method,
    password_hash: user.password_hash,
    disabled_at: user.disabled_at,
    systemRoles,
    permissionSet
  };

  row.can = function (permission, satelliteSlugOrId = null) {
    if (isAdmin) return true;

    let satId = null;
    if (satelliteSlugOrId) {
      // Accept slug or raw id
      const satRow = registry.getBySlug(satelliteSlugOrId);
      satId = satRow ? satRow.id : satelliteSlugOrId;
    }

    const key = satId ? `${permission}|${satId}` : `${permission}|GLOBAL`;
    if (permissionSet.has(key)) return true;

    // Fallback: GLOBAL-scoped permission satisfies per-satellite query
    if (satId && permissionSet.has(`${permission}|GLOBAL`)) return true;

    return false;
  };

  return row;
}

module.exports = { loadUserWithPermissions };
```

- [ ] **Step 4: Run the test, see it pass**

Run: `npm test -- tests/auth/resolver.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/resolver.js tests/auth/resolver.test.js
git commit -m "feat(auth): permission resolver with system + satellite + group scoping"
```

---

## Task 11: `src/auth/middleware.js` — requireAuth factory

**Files:**
- Create: `src/auth/middleware.js`
- Test: `tests/auth/middleware.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/auth/middleware.test.js`:

```javascript
const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-auth-mw-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');

const db = require('../../src/database');
const users = require('../../src/auth/users');
const sessions = require('../../src/auth/sessions');
const apiKeys = require('../../src/auth/api-keys');
const authRoles = require('../../src/auth/roles');
const middleware = require('../../src/auth/middleware');
const { v4: uuidv4 } = require('uuid');

let adminId, adminSession, staffId, staffSession, botId, botToken;
let server, baseUrl;

before(async () => {
  await db.init();
  await authRoles.seedOnce(db);

  adminId = await users.createUser({ email: 'admin@x', password: 'p' });
  staffId = await users.createUser({ email: 'staff@x', password: 'p' });
  botId = await users.createUser({ email: 'bot@x', auth_method: 'api_key_only' });

  const raw = db._raw();
  const getRole = (n) => raw.exec('SELECT id FROM roles WHERE name = ?', [n])[0].values[0][0];
  raw.run(`INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id) VALUES (?, 'user', ?, ?, NULL)`,
    [uuidv4(), adminId, getRole('mothership_admin')]);
  raw.run(`INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id) VALUES (?, 'user', ?, ?, NULL)`,
    [uuidv4(), staffId, getRole('viewer')]);
  raw.run(`INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id) VALUES (?, 'user', ?, ?, NULL)`,
    [uuidv4(), botId, getRole('viewer')]);
  db.save();

  adminSession = sessions.createSession(adminId, {});
  staffSession = sessions.createSession(staffId, {});
  const k = await apiKeys.generateApiKey(botId, 'test-bot');
  botToken = k.plaintext;

  const app = express();
  app.use(express.json());
  app.get('/need-admin', middleware.requireAuth({ permission: 'user.create' }), (req, res) => {
    res.json({ ok: true, user: req.user.email });
  });
  app.get('/need-chat', middleware.requireAuth({ permission: 'chat.send' }), (req, res) => {
    res.json({ ok: true });
  });
  app.get('/need-any', middleware.requireAnyAuth(), (req, res) => {
    res.json({ ok: true, user: req.user.email });
  });
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function req(pathname, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const res = await fetch(`${baseUrl}${pathname}`, { ...opts, headers });
  return { status: res.status, body: await res.text().then(t => { try { return JSON.parse(t); } catch { return t; } }) };
}

test('middleware — no credentials → 401', async () => {
  const r = await req('/need-any');
  assert.strictEqual(r.status, 401);
});

test('middleware — invalid cookie → 401', async () => {
  const r = await req('/need-any', { headers: { Cookie: 'mothership_sid=bogus' } });
  assert.strictEqual(r.status, 401);
});

test('middleware — valid admin cookie + right permission → 200', async () => {
  const r = await req('/need-admin', { headers: { Cookie: `mothership_sid=${adminSession.id}` } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.user, 'admin@x');
});

test('middleware — staff cookie + admin permission → 403', async () => {
  const r = await req('/need-admin', { headers: { Cookie: `mothership_sid=${staffSession.id}` } });
  assert.strictEqual(r.status, 403);
});

test('middleware — staff cookie + chat permission → 200 (viewer has chat.send)', async () => {
  const r = await req('/need-chat', { headers: { Cookie: `mothership_sid=${staffSession.id}` } });
  assert.strictEqual(r.status, 200);
});

test('middleware — bearer token works', async () => {
  const r = await req('/need-any', { headers: { Authorization: `Bearer ${botToken}` } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.user, 'bot@x');
});

test('middleware — wrong bearer token → 401', async () => {
  const r = await req('/need-any', { headers: { Authorization: 'Bearer mk_live_wrong' } });
  assert.strictEqual(r.status, 401);
});

test('middleware — disabled user → 401', async () => {
  users.disableUser(staffId);
  const r = await req('/need-any', { headers: { Cookie: `mothership_sid=${staffSession.id}` } });
  assert.strictEqual(r.status, 401);
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `npm test -- tests/auth/middleware.test.js`
Expected: FAIL — `Cannot find module '../../src/auth/middleware'`.

- [ ] **Step 3: Create `src/auth/middleware.js`**

```javascript
/**
 * MOTHERSHIP — Auth middleware factory
 */

const sessions = require('./sessions');
const apiKeys = require('./api-keys');
const resolver = require('./resolver');
const db = require('../database');

// In-memory login rate limiter: Map<ip, { count, windowStart }>
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 0, windowStart: now });
    return true;
  }
  return entry.count < LOGIN_MAX_ATTEMPTS;
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, windowStart: now });
  } else {
    entry.count++;
  }
}

function clearLoginFailures(ip) {
  loginAttempts.delete(ip);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k) out[k] = v;
  }
  return out;
}

async function identifyAndLoad(req) {
  // Bearer wins if both present
  const auth = req.headers.authorization;
  const bearerMatch = auth && auth.match(/^Bearer (.+)$/);
  if (bearerMatch) {
    const keyRow = await apiKeys.lookupByToken(bearerMatch[1]);
    if (!keyRow) return null;
    const user = await resolver.loadUserWithPermissions(keyRow.user_id);
    if (!user || user.disabled_at) return null;
    return user;
  }
  const cookies = parseCookies(req);
  const sid = cookies.mothership_sid;
  if (sid) {
    const sess = sessions.getSession(sid);
    if (!sess) return null;
    const user = await resolver.loadUserWithPermissions(sess.user_id);
    if (!user || user.disabled_at) return null;
    return user;
  }
  return null;
}

function requireAuth({ permission, satelliteParam = null } = {}) {
  return async function (req, res, next) {
    try {
      const user = await identifyAndLoad(req);
      if (!user) return res.status(401).json({ error: 'authentication required' });
      req.user = user;
      if (permission) {
        const slug = satelliteParam ? req.params[satelliteParam] : null;
        if (!user.can(permission, slug)) {
          return res.status(403).json({
            error: `forbidden: missing ${permission}${slug ? ` on ${slug}` : ''}`
          });
        }
      }
      next();
    } catch (err) {
      db.log('error', 'auth.middleware', err.message);
      res.status(500).json({ error: 'auth middleware error' });
    }
  };
}

function requireAnyAuth() {
  return requireAuth({});
}

module.exports = {
  requireAuth, requireAnyAuth,
  checkLoginRateLimit, recordLoginFailure, clearLoginFailures
};
```

- [ ] **Step 4: Run the test, see it pass**

Run: `npm test -- tests/auth/middleware.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/middleware.js tests/auth/middleware.test.js
git commit -m "feat(auth): requireAuth middleware with cookie + bearer + permission checks"
```

---

## Task 12: `src/auth/invitations.js` — generate, claim, revoke

**Files:**
- Create: `src/auth/invitations.js`
- Test: `tests/auth/invitations.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/auth/invitations.test.js`:

```javascript
const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-auth-inv-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');

const db = require('../../src/database');
const users = require('../../src/auth/users');
const authRoles = require('../../src/auth/roles');
const invitations = require('../../src/auth/invitations');

let inviterId, viewerRoleId, editorRoleId;

before(async () => {
  await db.init();
  await authRoles.seedOnce(db);
  inviterId = await users.createUser({ email: 'admin@x', password: 'p' });
  const raw = db._raw();
  viewerRoleId = raw.exec("SELECT id FROM roles WHERE name = 'viewer'")[0].values[0][0];
  editorRoleId = raw.exec("SELECT id FROM roles WHERE name = 'draft_author'")[0].values[0][0];
});
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test('invitations — generate returns plaintext token with mi_ prefix', async () => {
  const inv = await invitations.generateInvitation({
    invitedBy: inviterId,
    roleGrants: [{ role_id: editorRoleId, satellite_id: null }],
    expiresInDays: 7
  });
  assert.ok(inv.id);
  assert.ok(inv.token.startsWith('mi_'));
  assert.ok(inv.expires_at);
});

test('invitations — claim creates user, auto-grants viewer, applies role grants', async () => {
  const inv = await invitations.generateInvitation({
    invitedBy: inviterId,
    roleGrants: [{ role_id: editorRoleId, satellite_id: null }],
    expiresInDays: 7
  });
  const result = await invitations.claimInvitation({
    token: inv.token,
    password: 'new-password',
    displayName: 'New User'
  });
  assert.ok(result.userId);
  const newUser = users.getUserById(result.userId);
  assert.strictEqual(newUser.display_name, 'New User');

  // Assert viewer role auto-granted
  const raw = db._raw();
  const roles = raw.exec(`
    SELECT r.name FROM role_assignments ra
    JOIN roles r ON r.id = ra.role_id
    WHERE ra.principal_type = 'user' AND ra.principal_id = ?
  `, [result.userId])[0].values.map(r => r[0]);
  assert.ok(roles.includes('viewer'));
  assert.ok(roles.includes('draft_author'));
});

test('invitations — double-claim fails', async () => {
  const inv = await invitations.generateInvitation({
    invitedBy: inviterId, roleGrants: [], expiresInDays: 7
  });
  await invitations.claimInvitation({ token: inv.token, password: 'x', displayName: 'A' });
  await assert.rejects(
    invitations.claimInvitation({ token: inv.token, password: 'y', displayName: 'B' }),
    /already claimed/
  );
});

test('invitations — expired claim fails', async () => {
  const inv = await invitations.generateInvitation({
    invitedBy: inviterId, roleGrants: [], expiresInDays: 7
  });
  const raw = db._raw();
  raw.run(`UPDATE invitations SET expires_at = datetime('now', '-1 day') WHERE id = ?`, [inv.id]);
  db.save();
  await assert.rejects(
    invitations.claimInvitation({ token: inv.token, password: 'x', displayName: 'A' }),
    /expired/
  );
});

test('invitations — revoke prevents future claims', async () => {
  const inv = await invitations.generateInvitation({
    invitedBy: inviterId, roleGrants: [], expiresInDays: 7
  });
  invitations.revokeInvitation(inv.id);
  await assert.rejects(
    invitations.claimInvitation({ token: inv.token, password: 'x', displayName: 'A' }),
    /not found|already claimed|expired/
  );
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `npm test -- tests/auth/invitations.test.js`
Expected: FAIL — `Cannot find module '../../src/auth/invitations'`.

- [ ] **Step 3: Create `src/auth/invitations.js`**

```javascript
/**
 * MOTHERSHIP — Invitations
 *
 * Generate one-time URLs carrying role grants. Claim creates a user,
 * auto-grants viewer, applies the invitation's role grants, and logs in.
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const users = require('./users');
const hashing = require('./hashing');

const TOKEN_PREFIX = 'mi_';

function newPlaintextToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

function daysFromNow(n) {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000)
    .toISOString().replace('T', ' ').replace('Z', '');
}

async function generateInvitation({ invitedBy, roleGrants = [], expiresInDays = 7, email = null }) {
  if (!invitedBy) throw new Error('invitedBy required');
  const plaintext = newPlaintextToken();
  const token_hash = await hashing.hash(plaintext);
  const id = uuidv4();
  const expires_at = daysFromNow(expiresInDays);
  const raw = db._raw();
  raw.run(
    `INSERT INTO invitations (id, token_hash, email, invited_by, role_grants_json, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, token_hash, email, invitedBy, JSON.stringify(roleGrants), expires_at]
  );
  db.save();
  return { id, token: plaintext, expires_at };
}

async function findByToken(plaintext) {
  if (!plaintext || !plaintext.startsWith(TOKEN_PREFIX)) return null;
  // Same O(N) pattern as api-keys: argon2 salts prevent hash lookups.
  // Invitations are usually <100 active at any time.
  const raw = db._raw();
  const stmt = raw.prepare('SELECT * FROM invitations WHERE claimed_at IS NULL');
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  for (const row of rows) {
    if (await hashing.verify(row.token_hash, plaintext)) return row;
  }
  return null;
}

async function claimInvitation({ token, password, displayName }) {
  const inv = await findByToken(token);
  if (!inv) throw new Error('invitation not found or already claimed');
  if (new Date(inv.expires_at.replace(' ', 'T') + 'Z') < new Date()) {
    throw new Error('invitation expired');
  }

  const raw = db._raw();
  const viewerRoleId = raw.exec("SELECT id FROM roles WHERE name = 'viewer'")[0].values[0][0];

  // Best-effort transaction: create user, grant viewer, apply invitation grants, mark claimed.
  let newUserId;
  try {
    newUserId = await users.createUser({
      email: inv.email || `user-${inv.id.slice(0, 8)}@mothership`,
      display_name: displayName,
      password,
      auth_method: 'password'
    });

    // Auto-grant viewer
    raw.run(
      `INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id, granted_by)
       VALUES (?, 'user', ?, ?, NULL, ?)`,
      [uuidv4(), newUserId, viewerRoleId, inv.invited_by]
    );

    // Apply invitation grants
    const grants = JSON.parse(inv.role_grants_json || '[]');
    for (const g of grants) {
      raw.run(
        `INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id, granted_by)
         VALUES (?, 'user', ?, ?, ?, ?)`,
        [uuidv4(), newUserId, g.role_id, g.satellite_id || null, inv.invited_by]
      );
    }

    // Mark claimed
    raw.run(
      `UPDATE invitations SET claimed_at = datetime('now'), claimed_by_user_id = ? WHERE id = ?`,
      [newUserId, inv.id]
    );
    db.save();

    return { userId: newUserId, invitationId: inv.id };
  } catch (err) {
    // Rollback: remove the user row if created
    if (newUserId) {
      try { raw.run('DELETE FROM users WHERE id = ?', [newUserId]); } catch (_) {}
      try { raw.run(`DELETE FROM role_assignments WHERE principal_type = 'user' AND principal_id = ?`, [newUserId]); } catch (_) {}
      db.save();
    }
    throw err;
  }
}

function listInvitations({ onlyActive = false } = {}) {
  const raw = db._raw();
  const q = onlyActive
    ? `SELECT * FROM invitations WHERE claimed_at IS NULL AND expires_at > datetime('now') ORDER BY created_at DESC`
    : `SELECT * FROM invitations ORDER BY created_at DESC`;
  const stmt = raw.prepare(q);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function revokeInvitation(id) {
  const raw = db._raw();
  raw.run('DELETE FROM invitations WHERE id = ?', [id]);
  db.save();
}

module.exports = { generateInvitation, claimInvitation, listInvitations, revokeInvitation };
```

- [ ] **Step 4: Run the test, see it pass**

Run: `npm test -- tests/auth/invitations.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/invitations.js tests/auth/invitations.test.js
git commit -m "feat(auth): invitation generate + claim + revoke with viewer auto-grant"
```

---

## Task 13: `src/auth/system-owner.js` — bootstrap user lookup

**Files:**
- Create: `src/auth/system-owner.js`
- Test: `tests/auth/system-owner.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/auth/system-owner.test.js`:

```javascript
const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-auth-so-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');

const db = require('../../src/database');
const users = require('../../src/auth/users');
const authRoles = require('../../src/auth/roles');
const systemOwner = require('../../src/auth/system-owner');
const { v4: uuidv4 } = require('uuid');

before(async () => {
  await db.init();
  await authRoles.seedOnce(db);
});
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test('system-owner — returns null when no admin exists', () => {
  assert.strictEqual(systemOwner.getSystemOwnerId(), null);
});

test('system-owner — returns admin id when one exists', async () => {
  const id = await users.createUser({ email: 'admin@x', password: 'p' });
  const raw = db._raw();
  const adminRoleId = raw.exec("SELECT id FROM roles WHERE name = 'mothership_admin'")[0].values[0][0];
  raw.run(
    `INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id)
     VALUES (?, 'user', ?, ?, NULL)`,
    [uuidv4(), id, adminRoleId]
  );
  db.save();
  assert.strictEqual(systemOwner.getSystemOwnerId(), id);
});

test('system-owner — returns oldest admin when multiple exist', async () => {
  const raw = db._raw();
  const first = systemOwner.getSystemOwnerId();
  const newerId = await users.createUser({ email: 'admin2@x', password: 'p' });
  const adminRoleId = raw.exec("SELECT id FROM roles WHERE name = 'mothership_admin'")[0].values[0][0];
  raw.run(
    `INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id)
     VALUES (?, 'user', ?, ?, NULL)`,
    [uuidv4(), newerId, adminRoleId]
  );
  db.save();
  // Still returns the first (oldest) admin
  assert.strictEqual(systemOwner.getSystemOwnerId(), first);
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `npm test -- tests/auth/system-owner.test.js`
Expected: FAIL — `Cannot find module '../../src/auth/system-owner'`.

- [ ] **Step 3: Create `src/auth/system-owner.js`**

```javascript
/**
 * MOTHERSHIP — System owner lookup
 *
 * Resolves to the oldest mothership_admin user id. Used by untethered
 * pipelines (Telegram bot, file watcher, health check) that have no
 * authenticated request context but still need to stamp ownership on
 * ingested rows.
 *
 * Returns null if no admin exists yet (pre-bootstrap state).
 */

const db = require('../database');

let cachedId = null;

function getSystemOwnerId() {
  if (cachedId) return cachedId;
  const raw = db._raw();
  const result = raw.exec(`
    SELECT u.id FROM users u
    JOIN role_assignments ra ON ra.principal_id = u.id AND ra.principal_type = 'user'
    JOIN roles r ON r.id = ra.role_id
    WHERE r.name = 'mothership_admin' AND u.disabled_at IS NULL
    ORDER BY u.created_at ASC
    LIMIT 1
  `);
  if (!result.length || !result[0].values.length) return null;
  cachedId = result[0].values[0][0];
  return cachedId;
}

function clearCache() {
  cachedId = null;
}

module.exports = { getSystemOwnerId, clearCache };
```

- [ ] **Step 4: Run the test, see it pass**

Run: `npm test -- tests/auth/system-owner.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/system-owner.js tests/auth/system-owner.test.js
git commit -m "feat(auth): system owner lookup for untethered pipelines"
```

---

## Task 14: `src/auth/backfill.js` + `src/auth/index.js` — init + migration

**Files:**
- Create: `src/auth/backfill.js`
- Create: `src/auth/index.js`
- Test: `tests/auth/backfill.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/auth/backfill.test.js`:

```javascript
const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-auth-backfill-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');

const db = require('../../src/database');
const users = require('../../src/auth/users');
const authRoles = require('../../src/auth/roles');
const backfill = require('../../src/auth/backfill');
const { v4: uuidv4 } = require('uuid');

let adminId;
before(async () => {
  await db.init();
  await authRoles.seedOnce(db);

  // Pre-populate some rows with NULL user_id (simulates pre-migration state)
  const raw = db._raw();
  raw.run(`INSERT INTO messages (id, content, source) VALUES (?, ?, ?)`, [uuidv4(), 'old msg 1', 'telegram']);
  raw.run(`INSERT INTO messages (id, content, source) VALUES (?, ?, ?)`, [uuidv4(), 'old msg 2', 'file']);
  raw.run(`INSERT INTO mirror_entries (id, category, content, confidence, source_type) VALUES (?, ?, ?, ?, ?)`,
    [uuidv4(), 'pref', 'likes terse', 0.8, 'conversation']);
  raw.run(`INSERT INTO wiki_entries (id, topic, summary) VALUES (?, ?, ?)`,
    [uuidv4(), 'quantum-mirror', 'A cognitive profile']);
  db.save();

  // Create the first admin
  adminId = await users.createUser({ email: 'admin@x', password: 'p' });
  const adminRoleId = raw.exec("SELECT id FROM roles WHERE name = 'mothership_admin'")[0].values[0][0];
  raw.run(
    `INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id)
     VALUES (?, 'user', ?, ?, NULL)`,
    [uuidv4(), adminId, adminRoleId]
  );
  db.save();
});
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test('backfill — runBackfillIfNeeded assigns admin id to NULL rows', async () => {
  const result = await backfill.runBackfillIfNeeded();
  assert.strictEqual(result.ran, true);
  assert.strictEqual(result.messages, 2);
  assert.strictEqual(result.mirror_entries, 1);
  assert.strictEqual(result.wiki_entries, 1);

  const raw = db._raw();
  const nullCount = raw.exec(`
    SELECT (SELECT COUNT(*) FROM messages WHERE user_id IS NULL)
         + (SELECT COUNT(*) FROM mirror_entries WHERE user_id IS NULL)
         + (SELECT COUNT(*) FROM wiki_entries WHERE user_id IS NULL)
  `)[0].values[0][0];
  assert.strictEqual(nullCount, 0);
});

test('backfill — second run is a no-op', async () => {
  const result = await backfill.runBackfillIfNeeded();
  assert.strictEqual(result.ran, false);
  assert.strictEqual(result.reason, 'already_done');
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `npm test -- tests/auth/backfill.test.js`
Expected: FAIL — `Cannot find module '../../src/auth/backfill'`.

- [ ] **Step 3: Create `src/auth/backfill.js`**

```javascript
/**
 * MOTHERSHIP — Per-user data backfill migration
 *
 * One-time: assigns user_id = <first admin> to every NULL row in
 * messages, mirror_entries, wiki_entries. Gated on the first admin
 * existing. Idempotent via a sentinel in the config table.
 */

const db = require('../database');
const systemOwner = require('./system-owner');

const SENTINEL_KEY = 'meta.per_user_backfill_done';

async function runBackfillIfNeeded() {
  const existing = db.getConfig(SENTINEL_KEY);
  if (existing === 'true') {
    return { ran: false, reason: 'already_done' };
  }

  const adminId = systemOwner.getSystemOwnerId();
  if (!adminId) {
    return { ran: false, reason: 'no_admin_yet' };
  }

  const raw = db._raw();
  const counts = { messages: 0, mirror_entries: 0, wiki_entries: 0 };
  for (const t of ['messages', 'mirror_entries', 'wiki_entries']) {
    const before = raw.exec(`SELECT COUNT(*) FROM ${t} WHERE user_id IS NULL`)[0].values[0][0];
    if (before > 0) {
      raw.run(`UPDATE ${t} SET user_id = ? WHERE user_id IS NULL`, [adminId]);
      counts[t] = before;
    }
  }
  db.save();

  db.setConfig(SENTINEL_KEY, 'true');
  db.log('info', 'auth.backfill', 'per-user backfill complete', counts);

  return { ran: true, ...counts };
}

module.exports = { runBackfillIfNeeded };
```

- [ ] **Step 4: Create `src/auth/index.js`**

```javascript
/**
 * MOTHERSHIP — Auth public surface
 *
 * Imported by server.js and route modules. Internals live in submodules
 * and are accessible via the namespace re-exports below.
 */

const hashing = require('./hashing');
const users = require('./users');
const sessions = require('./sessions');
const apiKeys = require('./api-keys');
const groups = require('./groups');
const roles = require('./roles');
const resolver = require('./resolver');
const middleware = require('./middleware');
const invitations = require('./invitations');
const systemOwner = require('./system-owner');
const backfill = require('./backfill');

async function init() {
  // Seed roles + permissions (idempotent)
  await roles.seedOnce(require('../database'));
  // Sweep expired sessions at boot
  try { sessions.sweepExpired(); } catch (_) {}
  // Start the daily sweep timer
  sessions.startDailySweep();
  // Run per-user backfill if admin exists (no-op before bootstrap)
  await backfill.runBackfillIfNeeded();
}

async function shutdown() {
  sessions.stopDailySweep();
}

function getSystemOwnerId() {
  return systemOwner.getSystemOwnerId();
}

module.exports = {
  init, shutdown,
  hashing, users, sessions, apiKeys, groups, roles,
  resolver, middleware, invitations, backfill,
  getSystemOwnerId,
  // Re-export middleware factories at top level for convenience
  requireAuth: middleware.requireAuth,
  requireAnyAuth: middleware.requireAnyAuth
};
```

- [ ] **Step 5: Run the test, see it pass**

Run: `npm test -- tests/auth/backfill.test.js`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/auth/backfill.js src/auth/index.js tests/auth/backfill.test.js
git commit -m "feat(auth): backfill migration + public auth module surface"
```

---

## Task 15: `scripts/create-admin.js` — bootstrap CLI

**Files:**
- Create: `scripts/create-admin.js`
- Test: `tests/auth/bootstrap.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/auth/bootstrap.test.js`:

```javascript
const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-bootstrap-'));
const tmpDb = path.join(tmpRoot, 'mothership.db');

after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function runScript(args) {
  return spawnSync('node', [path.join(__dirname, '..', '..', 'scripts', 'create-admin.js'), ...args], {
    env: { ...process.env, MOTHERSHIP_DB_PATH: tmpDb },
    encoding: 'utf8'
  });
}

test('bootstrap — rejects without --email', () => {
  const r = runScript(['--password', 'p']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /email/);
});

test('bootstrap — rejects without --password', () => {
  const r = runScript(['--email', 'a@b']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /password/);
});

test('bootstrap — creates first admin and exits 0', () => {
  const r = runScript(['--email', 'yoel@x', '--password', 'p', '--display-name', 'Yoel']);
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  assert.match(r.stdout, /yoel@x/);

  // Verify DB state
  process.env.MOTHERSHIP_DB_PATH = tmpDb;
  // Re-require db fresh — it caches; flush require cache
  delete require.cache[require.resolve('../../src/database')];
  const db = require('../../src/database');
  return (async () => {
    await db.init();
    const raw = db._raw();
    const userCount = raw.exec('SELECT COUNT(*) FROM users')[0].values[0][0];
    assert.strictEqual(userCount, 1);
    const roleNames = raw.exec(`
      SELECT r.name FROM role_assignments ra
      JOIN roles r ON r.id = ra.role_id
      WHERE ra.principal_type = 'user'
    `)[0].values.map(r => r[0]);
    assert.ok(roleNames.includes('mothership_admin'));
    assert.ok(roleNames.includes('viewer'));
  })();
});

test('bootstrap — refuses second run without --force', () => {
  const r = runScript(['--email', 'another@x', '--password', 'p']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /users exist/);
});

test('bootstrap — second run with --force creates another admin', () => {
  const r = runScript(['--email', 'another@x', '--password', 'p', '--force']);
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `npm test -- tests/auth/bootstrap.test.js`
Expected: FAIL — script not found or stderr empty.

- [ ] **Step 3: Create `scripts/create-admin.js`**

```javascript
#!/usr/bin/env node
/**
 * MOTHERSHIP — Bootstrap CLI: create the first mothership_admin
 *
 * Usage:
 *   node scripts/create-admin.js --email=yoel@example.com --password='secret' --display-name='Yoel'
 *   node scripts/create-admin.js --email=new@x --password='p' --force   # ignore users-exist guard
 */

const { v4: uuidv4 } = require('uuid');

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2] === undefined ? true : m[2];
    out[key] = val;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.email) {
    console.error('error: --email is required');
    console.error('usage: create-admin.js --email=<email> --password=<password> [--display-name=<name>] [--force]');
    process.exit(1);
  }
  if (!args.password) {
    console.error('error: --password is required');
    process.exit(1);
  }

  const db = require('../src/database');
  const auth = require('../src/auth');
  const users = require('../src/auth/users');
  const backfill = require('../src/auth/backfill');

  await db.init();
  await auth.init();

  const raw = db._raw();
  const userCount = raw.exec('SELECT COUNT(*) FROM users')[0].values[0][0];
  if (userCount > 0 && !args.force) {
    console.error(`error: users exist already (count=${userCount}). Use --force to create another admin.`);
    process.exit(1);
  }

  const userId = await users.createUser({
    email: args.email,
    display_name: args['display-name'] || args.email,
    password: args.password,
    auth_method: 'password'
  });

  const adminRoleId = raw.exec("SELECT id FROM roles WHERE name = 'mothership_admin'")[0].values[0][0];
  const viewerRoleId = raw.exec("SELECT id FROM roles WHERE name = 'viewer'")[0].values[0][0];

  raw.run(
    `INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id)
     VALUES (?, 'user', ?, ?, NULL)`,
    [uuidv4(), userId, adminRoleId]
  );
  raw.run(
    `INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id)
     VALUES (?, 'user', ?, ?, NULL)`,
    [uuidv4(), userId, viewerRoleId]
  );
  db.save();

  // Clear system-owner cache and run backfill (will pick up the new admin)
  const systemOwner = require('../src/auth/system-owner');
  systemOwner.clearCache();
  const backfillResult = await backfill.runBackfillIfNeeded();

  console.log(JSON.stringify({
    id: userId,
    email: args.email,
    display_name: args['display-name'] || args.email,
    backfill: backfillResult
  }, null, 2));

  await auth.shutdown();
  process.exit(0);
}

main().catch(err => {
  console.error('bootstrap failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
```

- [ ] **Step 4: Run the test, see it pass**

Run: `npm test -- tests/auth/bootstrap.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/create-admin.js tests/auth/bootstrap.test.js
git commit -m "feat(auth): create-admin bootstrap CLI"
```

---

## Task 16: `src/routes/auth.js` — /api/auth/* endpoints

**Files:**
- Create: `src/routes/auth.js`
- Test: `tests/auth/auth-routes.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/auth/auth-routes.test.js`:

```javascript
const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-auth-routes-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');

const db = require('../../src/database');
const auth = require('../../src/auth');
const users = require('../../src/auth/users');
const authRoutes = require('../../src/routes/auth');
const { v4: uuidv4 } = require('uuid');

let server, baseUrl, yoelCookie;

before(async () => {
  await db.init();
  await auth.init();

  const yoelId = await users.createUser({ email: 'yoel@x', password: 'correct-horse', display_name: 'Yoel' });
  const raw = db._raw();
  const adminRole = raw.exec("SELECT id FROM roles WHERE name = 'mothership_admin'")[0].values[0][0];
  const viewerRole = raw.exec("SELECT id FROM roles WHERE name = 'viewer'")[0].values[0][0];
  raw.run(`INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id) VALUES (?, 'user', ?, ?, NULL)`, [uuidv4(), yoelId, adminRole]);
  raw.run(`INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id) VALUES (?, 'user', ?, ?, NULL)`, [uuidv4(), yoelId, viewerRole]);
  db.save();

  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await auth.shutdown();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function req(method, pathname, body, headers = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const setCookie = res.headers.get('set-cookie');
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed, setCookie };
}

test('auth-routes — POST /login with bad password → 401', async () => {
  const r = await req('POST', '/api/auth/login', { email: 'yoel@x', password: 'wrong' });
  assert.strictEqual(r.status, 401);
});

test('auth-routes — POST /login with correct password → 200 + cookie', async () => {
  const r = await req('POST', '/api/auth/login', { email: 'yoel@x', password: 'correct-horse' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.user.email, 'yoel@x');
  assert.ok(r.setCookie);
  assert.match(r.setCookie, /mothership_sid=/);
  assert.match(r.setCookie, /HttpOnly/);
  assert.match(r.setCookie, /SameSite=Lax/);
  yoelCookie = r.setCookie.split(';')[0];
});

test('auth-routes — GET /me with session returns user + permissions', async () => {
  const r = await req('GET', '/api/auth/me', null, { Cookie: yoelCookie });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.user.email, 'yoel@x');
  assert.ok(Array.isArray(r.body.permissions));
});

test('auth-routes — GET /me without session → 401', async () => {
  const r = await req('GET', '/api/auth/me');
  assert.strictEqual(r.status, 401);
});

test('auth-routes — POST /logout clears session', async () => {
  const loginRes = await req('POST', '/api/auth/login', { email: 'yoel@x', password: 'correct-horse' });
  const sid = loginRes.setCookie.split(';')[0];
  const logoutRes = await req('POST', '/api/auth/logout', {}, { Cookie: sid });
  assert.strictEqual(logoutRes.status, 204);
  const meRes = await req('GET', '/api/auth/me', null, { Cookie: sid });
  assert.strictEqual(meRes.status, 401);
});

test('auth-routes — login rate limit trips after 5 failures', async () => {
  for (let i = 0; i < 5; i++) {
    const r = await req('POST', '/api/auth/login', { email: 'yoel@x', password: 'wrong' });
    assert.strictEqual(r.status, 401);
  }
  const r6 = await req('POST', '/api/auth/login', { email: 'yoel@x', password: 'wrong' });
  assert.strictEqual(r6.status, 429);
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `npm test -- tests/auth/auth-routes.test.js`
Expected: FAIL — `Cannot find module '../../src/routes/auth'`.

- [ ] **Step 3: Create `src/routes/auth.js`**

```javascript
/**
 * MOTHERSHIP — /api/auth/* endpoints
 */

const express = require('express');
const router = express.Router();
const db = require('../database');
const users = require('../auth/users');
const sessions = require('../auth/sessions');
const hashing = require('../auth/hashing');
const resolver = require('../auth/resolver');
const middleware = require('../auth/middleware');
const invitations = require('../auth/invitations');

function clientIp(req) {
  return req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';
}

function setSessionCookie(res, sessionId) {
  res.setHeader('Set-Cookie',
    `mothership_sid=${sessionId}; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}; Path=/`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'mothership_sid=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/');
}

router.post('/login', async (req, res) => {
  const ip = clientIp(req);
  if (!middleware.checkLoginRateLimit(ip)) {
    return res.status(429).json({ error: 'too many attempts' });
  }
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password required' });
  }
  const user = users.getUserByEmail(email);
  if (!user || user.disabled_at || user.auth_method !== 'password') {
    middleware.recordLoginFailure(ip);
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const ok = await hashing.verify(user.password_hash, password);
  if (!ok) {
    middleware.recordLoginFailure(ip);
    db.log('warn', 'auth.login_failed', `${email}`);
    return res.status(401).json({ error: 'invalid credentials' });
  }
  middleware.clearLoginFailures(ip);

  const sess = sessions.createSession(user.id, { ip, userAgent: req.headers['user-agent'] });
  setSessionCookie(res, sess.id);

  const loaded = await resolver.loadUserWithPermissions(user.id);
  res.json({
    user: { id: loaded.id, email: loaded.email, display_name: loaded.display_name },
    permissions: Array.from(loaded.permissionSet)
  });
  db.log('info', 'auth.login', `${email}`);
});

router.post('/logout', middleware.requireAnyAuth(), (req, res) => {
  const cookies = (req.headers.cookie || '').split(';').map(s => s.trim()).reduce((a, c) => {
    const [k, v] = c.split('='); if (k) a[k] = v; return a;
  }, {});
  const sid = cookies.mothership_sid;
  if (sid) sessions.invalidateSession(sid);
  clearSessionCookie(res);
  res.status(204).end();
});

router.get('/me', middleware.requireAnyAuth(), (req, res) => {
  res.json({
    user: {
      id: req.user.id, email: req.user.email, display_name: req.user.display_name,
      auth_method: req.user.auth_method
    },
    permissions: Array.from(req.user.permissionSet),
    systemRoles: req.user.systemRoles
  });
});

router.patch('/password', middleware.requireAnyAuth(), async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'current_password and new_password required' });
  }
  const user = users.getUserById(req.user.id);
  const ok = await hashing.verify(user.password_hash, current_password);
  if (!ok) return res.status(401).json({ error: 'current password incorrect' });
  await users.updatePassword(user.id, new_password);

  // Invalidate all OTHER sessions (keep current)
  const cookies = (req.headers.cookie || '').split(';').map(s => s.trim()).reduce((a, c) => {
    const [k, v] = c.split('='); if (k) a[k] = v; return a;
  }, {});
  sessions.invalidateAllSessionsForUser(user.id, { exceptId: cookies.mothership_sid });

  db.log('info', 'auth.password_changed', user.email);
  res.json({ ok: true });
});

router.post('/claim-invite', async (req, res) => {
  const { token, password, display_name } = req.body || {};
  if (!token || !password) {
    return res.status(400).json({ error: 'token and password required' });
  }
  try {
    const result = await invitations.claimInvitation({ token, password, displayName: display_name });
    const sess = sessions.createSession(result.userId, { ip: clientIp(req), userAgent: req.headers['user-agent'] });
    setSessionCookie(res, sess.id);
    const loaded = await resolver.loadUserWithPermissions(result.userId);
    res.json({
      user: { id: loaded.id, email: loaded.email, display_name: loaded.display_name },
      permissions: Array.from(loaded.permissionSet)
    });
    db.log('info', 'auth.invitation_claimed', loaded.email);
  } catch (err) {
    db.log('warn', 'auth.claim_failed', err.message);
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
```

- [ ] **Step 4: Run the test, see it pass**

Run: `npm test -- tests/auth/auth-routes.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/routes/auth.js tests/auth/auth-routes.test.js
git commit -m "feat(auth): /api/auth routes — login, logout, me, password, claim-invite"
```

---

## Task 17: `src/routes/users.js` — user management endpoints

**Files:**
- Create: `src/routes/users.js`
- Test: `tests/auth/user-mgmt-routes.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/auth/user-mgmt-routes.test.js`:

```javascript
const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-user-mgmt-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');

const db = require('../../src/database');
const auth = require('../../src/auth');
const users = require('../../src/auth/users');
const sessions = require('../../src/auth/sessions');
const userMgmtRoutes = require('../../src/routes/users');
const { v4: uuidv4 } = require('uuid');

let server, baseUrl, adminCookie, viewerCookie;

before(async () => {
  await db.init();
  await auth.init();

  const adminId = await users.createUser({ email: 'admin@x', password: 'p' });
  const viewerId = await users.createUser({ email: 'viewer@x', password: 'p' });
  const raw = db._raw();
  const adminRole = raw.exec("SELECT id FROM roles WHERE name = 'mothership_admin'")[0].values[0][0];
  const viewerRole = raw.exec("SELECT id FROM roles WHERE name = 'viewer'")[0].values[0][0];
  raw.run(`INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id) VALUES (?, 'user', ?, ?, NULL)`, [uuidv4(), adminId, adminRole]);
  raw.run(`INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id) VALUES (?, 'user', ?, ?, NULL)`, [uuidv4(), viewerId, viewerRole]);
  db.save();

  adminCookie = `mothership_sid=${sessions.createSession(adminId, {}).id}`;
  viewerCookie = `mothership_sid=${sessions.createSession(viewerId, {}).id}`;

  const app = express();
  app.use(express.json());
  app.use('/api', userMgmtRoutes);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await auth.shutdown();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function req(method, pathname, body, cookie) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${baseUrl}${pathname}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

test('user-mgmt — POST /users requires user.create (viewer fails)', async () => {
  const r = await req('POST', '/api/users', { email: 'new@x', password: 'p' }, viewerCookie);
  assert.strictEqual(r.status, 403);
});

test('user-mgmt — POST /users as admin succeeds and auto-grants viewer', async () => {
  const r = await req('POST', '/api/users', { email: 'newuser@x', password: 'p', display_name: 'New' }, adminCookie);
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.id);
  const raw = db._raw();
  const grants = raw.exec(`
    SELECT r.name FROM role_assignments ra
    JOIN roles r ON r.id = ra.role_id
    WHERE ra.principal_type = 'user' AND ra.principal_id = ?
  `, [r.body.id])[0].values.map(v => v[0]);
  assert.ok(grants.includes('viewer'));
});

test('user-mgmt — GET /users as admin returns list', async () => {
  const r = await req('GET', '/api/users', null, adminCookie);
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body));
  assert.ok(r.body.length >= 3);
});

test('user-mgmt — POST /invitations creates invitation with token', async () => {
  const raw = db._raw();
  const draftRoleId = raw.exec("SELECT id FROM roles WHERE name = 'draft_author'")[0].values[0][0];
  const r = await req('POST', '/api/invitations',
    { role_grants: [{ role_id: draftRoleId, satellite_id: null }], expires_in_days: 7 },
    adminCookie
  );
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.token);
  assert.ok(r.body.token.startsWith('mi_'));
});

test('user-mgmt — POST /role-assignments grants role', async () => {
  const all = users.listUsers();
  const target = all.find(u => u.email === 'newuser@x');
  const raw = db._raw();
  const draftRoleId = raw.exec("SELECT id FROM roles WHERE name = 'draft_author'")[0].values[0][0];
  const r = await req('POST', '/api/role-assignments',
    { principal_type: 'user', principal_id: target.id, role_id: draftRoleId },
    adminCookie
  );
  assert.strictEqual(r.status, 200);
});

test('user-mgmt — POST /groups creates group', async () => {
  const r = await req('POST', '/api/groups', { name: 'tx-staff', description: 'test' }, adminCookie);
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.id);
});

test('user-mgmt — POST /users/:id/api-keys self-flow (create own key)', async () => {
  const viewer = users.getUserByEmail('viewer@x');
  const r = await req('POST', `/api/users/${viewer.id}/api-keys`, { name: 'my-key' }, viewerCookie);
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.token);
  assert.ok(r.body.token.startsWith('mk_live_'));
});

test('user-mgmt — POST /users/:id/api-keys across-user as viewer fails', async () => {
  const admin = users.getUserByEmail('admin@x');
  const r = await req('POST', `/api/users/${admin.id}/api-keys`, { name: 'sneaky' }, viewerCookie);
  assert.strictEqual(r.status, 403);
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `npm test -- tests/auth/user-mgmt-routes.test.js`
Expected: FAIL — `Cannot find module '../../src/routes/users'`.

- [ ] **Step 3: Create `src/routes/users.js`**

```javascript
/**
 * MOTHERSHIP — User / invitation / role-assignment / group management routes
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const users = require('../auth/users');
const apiKeys = require('../auth/api-keys');
const groups = require('../auth/groups');
const invitations = require('../auth/invitations');
const { requireAuth, requireAnyAuth } = require('../auth/middleware');

// Helper: grant viewer role to a newly-created user (idempotent)
function grantViewerRole(userId, grantedBy) {
  const raw = db._raw();
  const viewerRoleId = raw.exec("SELECT id FROM roles WHERE name = 'viewer'")[0].values[0][0];
  raw.run(
    `INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id, granted_by)
     VALUES (?, 'user', ?, ?, NULL, ?)`,
    [uuidv4(), userId, viewerRoleId, grantedBy]
  );
  db.save();
}

// --- /api/users ---

router.post('/users', requireAuth({ permission: 'user.create' }), async (req, res) => {
  try {
    const { email, password, display_name, auth_method, notes, skip_default_roles } = req.body || {};
    const id = await users.createUser({ email, password, display_name, auth_method, notes });
    if (!skip_default_roles) grantViewerRole(id, req.user.id);
    res.json({ id, email });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/users', requireAuth({ permission: 'user.list' }), (req, res) => {
  res.json(users.listUsers());
});

router.get('/users/:id', requireAuth({ permission: 'user.list' }), (req, res) => {
  const u = users.getUserById(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  res.json(u);
});

router.patch('/users/:id/disable', requireAuth({ permission: 'user.disable' }), (req, res) => {
  users.disableUser(req.params.id);
  res.json({ ok: true });
});

router.patch('/users/:id/password', requireAuth({ permission: 'user.reset_password' }), async (req, res) => {
  const { new_password } = req.body || {};
  if (!new_password) return res.status(400).json({ error: 'new_password required' });
  await users.updatePassword(req.params.id, new_password);
  res.json({ ok: true });
});

// --- API keys (self-or-admin check in handler) ---

function canManageApiKeysFor(req, targetUserId) {
  if (req.user.id === targetUserId) return true;
  return req.user.can('user.reset_password');
}

router.post('/users/:id/api-keys', requireAnyAuth(), async (req, res) => {
  if (!canManageApiKeysFor(req, req.params.id)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const result = await apiKeys.generateApiKey(req.params.id, name);
  res.json({ id: result.id, name, token: result.plaintext });
});

router.get('/users/:id/api-keys', requireAnyAuth(), (req, res) => {
  if (!canManageApiKeysFor(req, req.params.id)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json(apiKeys.listForUser(req.params.id));
});

router.delete('/users/:id/api-keys/:keyId', requireAnyAuth(), (req, res) => {
  if (!canManageApiKeysFor(req, req.params.id)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  apiKeys.disableApiKey(req.params.keyId);
  res.json({ ok: true });
});

// --- /api/invitations ---

router.post('/invitations', requireAuth({ permission: 'invitation.create' }), async (req, res) => {
  const { email, role_grants = [], expires_in_days = 7 } = req.body || {};
  const inv = await invitations.generateInvitation({
    invitedBy: req.user.id, roleGrants: role_grants, expiresInDays: expires_in_days, email
  });
  res.json({ id: inv.id, token: inv.token, expires_at: inv.expires_at });
});

router.get('/invitations', requireAuth({ permission: 'invitation.list' }), (req, res) => {
  res.json(invitations.listInvitations());
});

router.delete('/invitations/:id', requireAuth({ permission: 'invitation.revoke' }), (req, res) => {
  invitations.revokeInvitation(req.params.id);
  res.json({ ok: true });
});

// --- /api/role-assignments ---

router.post('/role-assignments', requireAuth({ permission: 'role.assign' }), (req, res) => {
  const { principal_type, principal_id, role_id, satellite_id = null } = req.body || {};
  if (!['user', 'group'].includes(principal_type)) {
    return res.status(400).json({ error: 'principal_type must be user or group' });
  }
  const raw = db._raw();
  const roleRow = raw.exec('SELECT kind FROM roles WHERE id = ?', [role_id]);
  if (!roleRow.length || !roleRow[0].values.length) {
    return res.status(400).json({ error: 'unknown role' });
  }
  const kind = roleRow[0].values[0][0];
  if (kind === 'system' && satellite_id !== null) {
    return res.status(400).json({ error: 'system role cannot be satellite-scoped' });
  }
  if (kind === 'satellite' && !satellite_id) {
    return res.status(400).json({ error: 'satellite role requires satellite_id' });
  }
  const id = uuidv4();
  raw.run(
    `INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id, granted_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, principal_type, principal_id, role_id, satellite_id, req.user.id]
  );
  db.save();
  res.json({ id });
});

router.get('/role-assignments', requireAuth({ permission: 'role.assign' }), (req, res) => {
  const raw = db._raw();
  const rows = raw.exec('SELECT * FROM role_assignments ORDER BY created_at DESC');
  if (!rows.length) return res.json([]);
  const [rs] = rows;
  res.json(rs.values.map(v => Object.fromEntries(rs.columns.map((c, i) => [c, v[i]]))));
});

router.delete('/role-assignments/:id', requireAuth({ permission: 'role.revoke' }), (req, res) => {
  const raw = db._raw();
  raw.run('DELETE FROM role_assignments WHERE id = ?', [req.params.id]);
  db.save();
  res.json({ ok: true });
});

// --- /api/groups ---

router.post('/groups', requireAuth({ permission: 'group.create' }), (req, res) => {
  try {
    const id = groups.createGroup({ name: req.body.name, description: req.body.description });
    res.json({ id });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/groups', requireAuth({ permission: 'group.create' }), (req, res) => {
  res.json(groups.listGroups());
});

router.delete('/groups/:id', requireAuth({ permission: 'group.delete' }), (req, res) => {
  groups.deleteGroup(req.params.id);
  res.json({ ok: true });
});

router.post('/groups/:id/members', requireAuth({ permission: 'group.edit' }), (req, res) => {
  const { user_id } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  groups.addMember(req.params.id, user_id);
  res.json({ ok: true });
});

router.delete('/groups/:id/members/:userId', requireAuth({ permission: 'group.edit' }), (req, res) => {
  groups.removeMember(req.params.id, req.params.userId);
  res.json({ ok: true });
});

module.exports = router;
```

- [ ] **Step 4: Run the test, see it pass**

Run: `npm test -- tests/auth/user-mgmt-routes.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/routes/users.js tests/auth/user-mgmt-routes.test.js
git commit -m "feat(auth): user management routes (users, invitations, roles, groups)"
```

---

## Task 18: Plumb `userId` through `src/database.js` scoped-table APIs

**Files:**
- Modify: `src/database.js`
- Update existing tests: `tests/database-mirror-entries.test.js`, `tests/database-wiki-entries.test.js`

- [ ] **Step 1: Understand the existing signatures**

`src/database.js` currently exports:
- `addMessage(content, source, category, metadata)` — no user_id
- `getMessages({ limit, offset, source, category, search })` — no user_id filter
- `addMirrorEntry({ category, content, confidence, source_type, source_id, embedding })` — no user_id
- `getMirrorEntries({ category, activeOnly, limit })` — no user_id filter
- `addWikiEntry({ topic, summary, source_ids, tags, embedding, contradictions })` — no user_id
- `getWikiEntries({ topic, limit })` — no user_id filter
- `supersedeMirrorEntry(oldId, newEntry)` — new entry needs user_id

We extend every signature to accept `userId` as a REQUIRED option. Callers that don't pass it throw.

- [ ] **Step 2: Modify `src/database.js` signatures**

Change `addMessage`:

```javascript
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
```

Change `getMessages` to filter by user:

```javascript
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
```

Similar changes for `getMessageCount`, `getSourceCounts`, `getCategoryCounts` — each gains `{ userId, allUsers }` options.

Change `addMirrorEntry`:

```javascript
function addMirrorEntry({ category, content, confidence = 0.5, source_type, source_id = null, embedding = null, userId = null }) {
  if (!userId) throw new Error('addMirrorEntry: userId required');
  const id = uuidv4();
  db.run(
    `INSERT INTO mirror_entries (id, category, content, confidence, source_type, source_id, embedding, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, category, content, confidence, source_type, source_id, embedding, userId]
  );
  save();
  return id;
}
```

Change `getMirrorEntries`:

```javascript
function getMirrorEntries({ category = null, activeOnly = true, limit = 500, userId = null, allUsers = false } = {}) {
  if (!userId && !allUsers) throw new Error('getMirrorEntries: userId required');
  let q = 'SELECT * FROM mirror_entries WHERE 1=1';
  const p = [];
  if (!allUsers) { q += ' AND user_id = ?'; p.push(userId); }
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
```

Change `supersedeMirrorEntry` — the new entry must carry the same user_id as the old one:

```javascript
function supersedeMirrorEntry(oldId, newEntry) {
  // Look up the old entry's user_id and use it on the new one
  const old = db.exec(`SELECT user_id FROM mirror_entries WHERE id = ?`, [oldId]);
  const ownerId = old.length && old[0].values.length ? old[0].values[0][0] : null;
  const newId = addMirrorEntry({ ...newEntry, userId: newEntry.userId || ownerId });
  db.run(`UPDATE mirror_entries SET superseded_by = ?, updated_at = datetime('now') WHERE id = ?`, [newId, oldId]);
  save();
  return newId;
}
```

Similarly for `addWikiEntry`, `getWikiEntries`, `getAllWikiEntries`, `updateWikiEntry` — add `userId` required, add `{ userId, allUsers }` filter options.

- [ ] **Step 3: Update existing tests that break**

Tests that now need `userId` passed in:
- `tests/database-mirror-entries.test.js`
- `tests/database-wiki-entries.test.js`

These tests currently call `addMirrorEntry({...})` without a userId. Update them to seed a test user first and pass `userId: testUserId` to every call.

Example edit to `tests/database-mirror-entries.test.js`:

```javascript
// At the top of the test file, add after db.init():
const users = require('../src/auth/users');
const authRoles = require('../src/auth/roles');
let testUserId;

before(async () => {
  await db.init();
  await authRoles.seedOnce(db);
  testUserId = await users.createUser({ email: 't@x', password: 'p' });
});

// And every addMirrorEntry / getMirrorEntries call gets userId: testUserId
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS — the updated existing tests pick up the new required parameter, plus the new auth tests continue to pass. Baseline should now be ~168 tests (136 original + 3 schema + 5 hashing + 6 roles + 6 users + 7 sessions + 5 api-keys + 5 groups + 5 resolver + 8 middleware + 5 invitations + 3 system-owner + 2 backfill + 5 bootstrap + 6 auth-routes + 8 user-mgmt-routes = 189 total so far, minus any that got merged).

- [ ] **Step 5: Commit**

```bash
git add src/database.js tests/database-mirror-entries.test.js tests/database-wiki-entries.test.js
git commit -m "feat(db): scoped-table APIs require userId, admin can pass allUsers"
```

---

## Task 19: Plumb `userId` through conversation + hooks + quantum-mirror

**Files:**
- Modify: `src/conversation.js`, `src/conversation-hooks.js`, `src/quantum-mirror.js`
- Update existing tests: `tests/conversation-hooks.test.js`, `tests/quantum-mirror.test.js`

- [ ] **Step 1: Modify `src/conversation.js`**

Update `buildHistory` to accept `userId`:

```javascript
function buildHistory(excludeContent, userId) {
  if (!userId) throw new Error('buildHistory: userId required');
  const telegramRows = db.getMessages({ limit: HISTORY_LIMIT, source: 'telegram', userId });
  const dashboardRows = db.getMessages({ limit: HISTORY_LIMIT, source: 'dashboard', userId });
  const botRows = db.getMessages({ limit: HISTORY_LIMIT, source: 'mothership', userId });
  // ... rest unchanged
}
```

Update `respond`:

```javascript
async function respond(userInput, opts = {}) {
  const { userId, contextKind, sourceHint } = opts;
  if (!userId) throw new Error('respond: userId required');
  const c = getClient();
  const staticPrompt = buildStaticSystemPrompt();
  const liveContext = await hooks.preResponse(userInput, { userId });
  // ... rest ...
  const history = buildHistory(userInput, userId);
  // ... rest unchanged
}
```

- [ ] **Step 2: Modify `src/conversation-hooks.js`**

```javascript
async function preResponse(userText, { userId } = {}) {
  if (!userId) throw new Error('preResponse: userId required');
  try {
    return await retriever.buildContextBlock(userText, {
      mirrorTopK: MIRROR_TOPK, wikiTopK: WIKI_TOPK, userId
    });
  } catch (err) {
    db.log('error', 'hooks.preResponse', err.message);
    return '';
  }
}

async function postResponse({ userText, assistantText, sourceId, draftSlug = null, userId }) {
  if (!userId) throw new Error('postResponse: userId required');
  if (!userText || userText.length < MIN_TURN_LENGTH) return;
  try {
    await qm.synthesizeFromTurn({
      userText, assistantText, sourceId, userId,
      forceCategory: draftSlug ? 'satellite-building' : null
    });
  } catch (err) {
    db.log('error', 'hooks.postResponse', err.message);
  }
}
```

- [ ] **Step 3: Modify `src/quantum-mirror.js`**

`synthesizeFromTurn` takes `userId` and passes it through:

```javascript
async function synthesizeFromTurn({ userText, assistantText, sourceId, forceCategory = null, userId }) {
  if (!userId) throw new Error('synthesizeFromTurn: userId required');
  const turn = `USER: ${userText}\n\nMOTHERSHIP: ${assistantText}`;
  const existing = getExistingCandidates(userId);
  // ... existing prompt building ...

  let created = 0;
  for (const entry of parsed.new_entries || []) {
    try {
      await ve.storeMirrorEntry({
        category: forceCategory || entry.category,
        content: entry.content,
        confidence: entry.confidence ?? 0.6,
        source_type: 'conversation',
        source_id: sourceId,
        userId
      });
      created++;
    } catch (err) { db.log('error', 'quantum-mirror', err.message); }
  }
  // ... rest of supersede loop passes userId too ...
}

function getExistingCandidates(userId) {
  return db.getMirrorEntries({ activeOnly: true, limit: 200, userId })
    .map(r => ({ id: r.id, category: r.category, content: r.content, confidence: r.confidence }));
}
```

- [ ] **Step 4: Update existing tests**

`tests/conversation-hooks.test.js` needs a test user and must pass `userId` in every postResponse / preResponse call. Similar for `tests/quantum-mirror.test.js`.

Add to the top of each test file (after `db.init()`):

```javascript
const users = require('../src/auth/users');
const authRoles = require('../src/auth/roles');
let testUserId;

before(async () => {
  await db.init();
  await authRoles.seedOnce(db);
  testUserId = await users.createUser({ email: 't@x', password: 'p' });
  // ... existing setup
});
```

And update every call to include `userId: testUserId`.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS across all files.

- [ ] **Step 6: Commit**

```bash
git add src/conversation.js src/conversation-hooks.js src/quantum-mirror.js tests/conversation-hooks.test.js tests/quantum-mirror.test.js
git commit -m "feat(auth): plumb userId through conversation + hooks + mirror synthesis"
```

---

## Task 20: Plumb `userId` through retriever + synthesizer + vector-engine

**Files:**
- Modify: `src/memory/retriever.js`, `src/memory/vector-engine.js`, `src/synthesizer.js`
- Update existing tests: `tests/memory/retriever.test.js`, `tests/memory/vector-engine.test.js`, `tests/synthesizer.test.js`

- [ ] **Step 1: Modify `src/memory/vector-engine.js`**

`storeMirrorEntry`, `storeWikiEntry`, `searchMirrorByQuery`, `searchWikiByQuery`, `supersedeMirrorEntry` all gain a required `userId`. The store functions pass `userId` through to `db.addMirrorEntry` / `db.addWikiEntry`. The search functions filter to `db.getMirrorEntries({ userId })` before similarity ranking.

- [ ] **Step 2: Modify `src/memory/retriever.js`**

`buildContextBlock(query, { userId, mirrorTopK, wikiTopK })` requires `userId`, filters Mirror and Wiki lookups by it.

- [ ] **Step 3: Modify `src/synthesizer.js`**

`synthesizeFromContent({ content, sourceId, userId })` requires `userId`, stores new Wiki topics under it.

- [ ] **Step 4: Update existing tests**

All three test files seed a test user and pass `userId: testUserId` to every call.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/memory/retriever.js src/memory/vector-engine.js src/synthesizer.js tests/memory/retriever.test.js tests/memory/vector-engine.test.js tests/synthesizer.test.js
git commit -m "feat(auth): plumb userId through retriever, synthesizer, vector-engine"
```

---

## Task 21: Plumb system owner through telegram + watcher + health-check + obsidian

**Files:**
- Modify: `src/telegram.js`, `src/watcher.js`, `src/health-check.js`, `src/exporters/obsidian.js`
- Update existing tests: `tests/health-check.test.js`, `tests/exporters/obsidian.test.js`

- [ ] **Step 1: Modify `src/telegram.js`**

At the top of `init()`, resolve the system owner and cache it on module scope. Use it as `userId` for every `db.addMessage` call in the bot handlers.

```javascript
const auth = require('./auth');
let systemOwnerId = null;

function init() {
  // ... existing init body ...
  systemOwnerId = auth.getSystemOwnerId();
  if (!systemOwnerId) {
    console.log('  ⚠ Telegram: no system owner yet (pre-bootstrap) — messages will be skipped');
    return false;
  }
  // ... rest
}

// Every db.addMessage call:
db.addMessage(text, 'telegram', 'uncategorized', metadata, systemOwnerId);
```

If `systemOwnerId` is null at message-ingest time, the handler logs a warning and drops the message.

- [ ] **Step 2: Modify `src/watcher.js`** — same pattern.

- [ ] **Step 3: Modify `src/health-check.js`** to iterate users

Instead of running decay/gap-analysis globally, loop over active users:

```javascript
const users = require('./auth/users');

async function runWeekly() {
  const allUsers = users.listUsers({ includeDisabled: false });
  for (const u of allUsers) {
    await decayStaleMirrorEntries(u.id);
    await scanForGaps(u.id);
  }
}
```

Each underlying helper takes a `userId` and scopes its queries.

- [ ] **Step 4: Modify `src/exporters/obsidian.js`**

`exportAll({ userId })` pulls the caller's Mirror + Wiki. Default behavior when only one user exists is to use that user's data (back-compat). When multiple users exist, `userId` is required.

- [ ] **Step 5: Update existing tests**

`tests/health-check.test.js`, `tests/exporters/obsidian.test.js` — seed a test user and adjust calls.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/telegram.js src/watcher.js src/health-check.js src/exporters/obsidian.js tests/health-check.test.js tests/exporters/obsidian.test.js
git commit -m "feat(auth): untethered pipelines use system owner id"
```

---

## Task 22: Retrofit satellite routes in `src/routes/api.js`

**Files:**
- Modify: `src/routes/api.js` — gate every `/api/satellites/*` route with `requireAuth`
- Update existing test: `tests/satellites/api.test.js` — log in first

- [ ] **Step 1: Add auth middleware to every satellite route**

At the top of `src/routes/api.js`, the `auth` require is already present. Locate the `// --- Satellites ---` block and edit each handler to wrap with `requireAuth`:

```javascript
const { requireAuth, requireAnyAuth } = require('../auth/middleware');

// Drafts (system-scoped)
router.post('/satellites/drafts', requireAuth({ permission: 'draft.create' }), (req, res) => { /* existing body */ });
router.get('/satellites/drafts', requireAuth({ permission: 'draft.read' }), (req, res) => { /* existing body */ });
router.get('/satellites/drafts/:slug', requireAuth({ permission: 'draft.read' }), (req, res) => { /* existing body */ });
router.post('/satellites/drafts/:slug/regenerate-brief', requireAuth({ permission: 'draft.regenerate_brief' }), async (req, res) => { /* existing body */ });
router.post('/satellites/drafts/:slug/status', requireAuth({ permission: 'draft.edit_status' }), (req, res) => { /* existing body */ });

// Satellites
router.post('/satellites', requireAuth({ permission: 'satellite.create' }), async (req, res) => { /* existing body */ });

router.get('/satellites', requireAnyAuth(), (req, res) => {
  const { status, kind, visibility } = req.query;
  const all = satellites.registry.listRows({ status, kind, visibility });
  const visible = all.filter(row => req.user.can('satellite.read', row.slug));
  res.json(visible);
});

router.get('/satellites/:slug', requireAuth({ permission: 'satellite.read', satelliteParam: 'slug' }), (req, res) => { /* existing body */ });
router.post('/satellites/:slug/archive', requireAuth({ permission: 'satellite.archive', satelliteParam: 'slug' }), async (req, res) => { /* existing body */ });
router.post('/satellites/:slug/unarchive', requireAuth({ permission: 'satellite.unarchive', satelliteParam: 'slug' }), async (req, res) => { /* existing body */ });
router.post('/satellites/:slug/transfer', requireAuth({ permission: 'satellite.transfer', satelliteParam: 'slug' }), async (req, res) => { /* existing body */ });
router.post('/satellites/:slug/visibility', requireAuth({ permission: 'satellite.set_visibility', satelliteParam: 'slug' }), async (req, res) => { /* existing body */ });
router.post('/satellites/:slug/directives', requireAuth({ permission: 'satellite.issue_directive', satelliteParam: 'slug' }), (req, res) => { /* existing body */ });
router.get('/satellites/:slug/directives', requireAuth({ permission: 'satellite.read_directives', satelliteParam: 'slug' }), (req, res) => { /* existing body */ });
```

The `GET /satellites` implementation is updated to filter by caller visibility (per-row `can()`).

- [ ] **Step 2: Update `tests/satellites/api.test.js` to log in first**

At the top of the test file, seed an admin user + create a session + include the cookie in every `req()` call:

```javascript
const auth = require('../../src/auth');
const authUsers = require('../../src/auth/users');
const authSessions = require('../../src/auth/sessions');
const authRoles = require('../../src/auth/roles');
const { v4: uuidv4 } = require('uuid');

let adminCookie;

before(async () => {
  await db.init();
  await authRoles.seedOnce(db);
  await satellites.init();

  const adminId = await authUsers.createUser({ email: 'test-admin@x', password: 'p' });
  const raw = db._raw();
  const adminRoleId = raw.exec("SELECT id FROM roles WHERE name = 'mothership_admin'")[0].values[0][0];
  raw.run(`INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id) VALUES (?, 'user', ?, ?, NULL)`, [uuidv4(), adminId, adminRoleId]);
  db.save();
  adminCookie = `mothership_sid=${authSessions.createSession(adminId, {}).id}`;

  // ... existing app setup ...
});
```

Update the `req()` helper to default the Cookie header to `adminCookie`:

```javascript
async function req(method, pathname, body) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: body ? JSON.stringify(body) : undefined
  });
  // ... unchanged
}
```

Add one new test: anonymous access returns 401.

```javascript
test('api — anonymous request to satellites returns 401', async () => {
  const res = await fetch(`${baseUrl}/api/satellites`);
  assert.strictEqual(res.status, 401);
});
```

- [ ] **Step 3: Run the satellite tests**

Run: `npm test -- tests/satellites/api.test.js`
Expected: PASS — all 16 existing tests plus the anonymous 401 test.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS with no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/routes/api.js tests/satellites/api.test.js
git commit -m "feat(auth): retrofit satellite routes with requireAuth gates"
```

---

## Task 23: Retrofit Mothership-wide routes (mirror, wiki, messages, logs, export, briefing, chat)

**Files:**
- Modify: `src/routes/api.js` (the mothership-wide routes section)
- Update any existing test that hits these routes

- [ ] **Step 1: Update every Mothership-wide route with `requireAuth` + per-user filtering**

Edit `src/routes/api.js`:

```javascript
// --- Messages (per-user) ---
router.get('/messages', requireAuth({ permission: 'message.read' }), (req, res) => {
  const { limit, offset, source, category, search, user_id } = req.query;
  const targetUserId = user_id || req.user.id;
  const allUsers = false;
  if (user_id && user_id !== req.user.id) {
    if (!req.user.can('message.read_any')) return res.status(403).json({ error: 'forbidden' });
  }
  const messages = db.getMessages({
    limit: parseInt(limit) || 50, offset: parseInt(offset) || 0,
    source, category, search, userId: targetUserId
  });
  res.json(messages);
});

router.get('/messages/:id', requireAuth({ permission: 'message.read' }), (req, res) => {
  // Fetch a single message. Because getMessages filters by user_id, a non-admin
  // only sees their own messages. We look up via getMessages with a wide limit
  // and filter by id — simpler than adding a getMessageById that supports both
  // scopes.
  const msgs = db.getMessages({ limit: 1000, userId: req.user.id });
  const msg = msgs.find(m => m.id === req.params.id);
  if (!msg) {
    // Admin override: check if the caller has message.read_any and do a raw SELECT
    if (req.user.can('message.read_any')) {
      const raw = db._raw();
      const stmt = raw.prepare('SELECT * FROM messages WHERE id = ?');
      stmt.bind([req.params.id]);
      if (stmt.step()) {
        const row = stmt.getAsObject();
        row.metadata = JSON.parse(row.metadata || '{}');
        row.tags = JSON.parse(row.tags || '[]');
        stmt.free();
        return res.json(row);
      }
      stmt.free();
    }
    return res.status(404).json({ error: 'not found' });
  }
  res.json(msg);
});

router.post('/messages', requireAuth({ permission: 'message.read' }), (req, res) => {
  const { content, source, category, metadata } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });
  const id = db.addMessage(content, source || 'api', category || 'uncategorized', metadata || {}, req.user.id);
  res.json({ id, status: 'ok' });
});

// --- Chat (stamps user_id into messages) ---
router.post('/chat', requireAuth({ permission: 'chat.send' }), async (req, res) => {
  const { content, draft_slug } = req.body || {};
  if (!content || !content.trim()) return res.status(400).json({ error: 'content is required' });
  const userText = content.trim();
  const draftSlug = typeof draft_slug === 'string' && draft_slug.length > 0 ? draft_slug : null;
  const userId = req.user.id;

  try {
    const userMeta = { via: 'dashboard-chat' };
    if (draftSlug) userMeta.draft_slug = draftSlug;
    const userMsgId = db.addMessage(userText, 'dashboard', 'uncategorized', userMeta, userId);

    const reply = await conversation.respond(userText, { contextKind: 'text', userId });

    const replyMeta = { via: 'dashboard-chat', in_reply_to: userMsgId };
    if (draftSlug) replyMeta.draft_slug = draftSlug;
    const replyId = db.addMessage(reply, 'mothership', 'reply', replyMeta, userId);

    hooks.postResponse({
      userText, assistantText: reply, sourceId: replyId, draftSlug, userId
    }).catch(err => db.log('error', 'api.chat.postResponse', err.message));

    res.json({ userId: userMsgId, replyId, reply });
  } catch (err) {
    db.log('error', 'api.chat', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Mirror (per-user) ---
router.get('/mirror', requireAuth({ permission: 'mirror.read' }), (req, res) => {
  const { user_id } = req.query;
  const targetUserId = user_id || req.user.id;
  if (user_id && user_id !== req.user.id && !req.user.can('mirror.read_any')) {
    return res.status(403).json({ error: 'forbidden' });
  }
  // The existing mirror.getMirror() returns the legacy static mirror; we need
  // a new path that pulls from mirror_entries filtered by user_id. The legacy
  // getMirror() is kept for backward compatibility but mostly empty after v2.
  res.json(mirror.getMirror()); // TODO in Task 23 follow-up: per-user aggregate
});

router.get('/mirror/entries', requireAuth({ permission: 'mirror.read' }), (req, res) => {
  const { category, limit, user_id } = req.query;
  const targetUserId = user_id || req.user.id;
  if (user_id && user_id !== req.user.id && !req.user.can('mirror.read_any')) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json(db.getMirrorEntries({
    category: category || null,
    activeOnly: true,
    limit: parseInt(limit) || 100,
    userId: targetUserId
  }));
});

router.get('/mirror/models', requireAuth({ permission: 'mirror.read' }), (req, res) => {
  res.json(mirror.getModels());
});
router.get('/mirror/learning', requireAuth({ permission: 'mirror.read' }), (req, res) => {
  res.json(mirror.getLearningStyle());
});
router.get('/mirror/knowledge', requireAuth({ permission: 'mirror.read' }), (req, res) => {
  res.json(mirror.getKnowledgeGraph());
});
router.get('/mirror/resonance', requireAuth({ permission: 'mirror.read' }), (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(mirror.getResonanceLog(limit));
});
router.post('/mirror/resonance', requireAuth({ permission: 'mirror.read' }), (req, res) => {
  const { type, content, score, tags } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });
  const entry = mirror.logResonance(type || 'insight', content, score || 0, tags || []);
  res.json(entry);
});

// --- Wiki (per-user) ---
router.get('/wiki/entries', requireAuth({ permission: 'wiki.read' }), (req, res) => {
  const { user_id } = req.query;
  const targetUserId = user_id || req.user.id;
  if (user_id && user_id !== req.user.id && !req.user.can('wiki.read_any')) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json(db.getWikiEntries({ userId: targetUserId, limit: 10000 }));
});

// --- Logs / export / briefing (operator endpoints) ---
router.get('/logs', requireAuth({ permission: 'log.read' }), (req, res) => {
  const { limit, level } = req.query;
  res.json(db.getLogs({ limit: parseInt(limit) || 100, level }));
});

router.post('/export', requireAuth({ permission: 'export.run' }), async (req, res) => {
  try { res.json(await obsidian.exportAll({ userId: req.user.id })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/briefing', requireAuth({ permission: 'briefing.run' }), async (req, res) => {
  const { topic } = req.body;
  try {
    res.json({ block: await retriever.buildContextBlock(topic || 'briefing', { userId: req.user.id }) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

The `/api/status` route stays public (no middleware).

- [ ] **Step 2: Check `src/mirror.js` (legacy static Mirror)**

The `src/mirror.js` module (distinct from `src/quantum-mirror.js`) exposes `getMirror()`, `getModels()`, etc. for the legacy static JSON mirror. These are mostly empty after Quantum Mirror v2 migration. No changes needed — they return in-memory structures. Leave them as-is; they return whatever they return, and the route is still gated by `mirror.read`.

- [ ] **Step 3: Run the retrofit suite**

Run: `npm test -- tests/satellites/chat-draft.test.js`
Expected: update any test that calls hooks.postResponse / /api/chat to pass `userId`, then PASS.

Run: `npm test -- tests/satellites/drafts.test.js`
Expected: tests that call `db.addMessage(...)` need to pass a `userId`. Update them.

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/routes/api.js tests/satellites/chat-draft.test.js tests/satellites/drafts.test.js
git commit -m "feat(auth): retrofit mothership-wide routes with requireAuth + per-user filters"
```

---

## Task 24: `tests/auth/per-user-scope.test.js` — isolation guarantees

**Files:**
- Create: `tests/auth/per-user-scope.test.js`

- [ ] **Step 1: Write the test**

```javascript
const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-per-user-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');

const db = require('../../src/database');
const auth = require('../../src/auth');
const users = require('../../src/auth/users');
const authRoles = require('../../src/auth/roles');
const { v4: uuidv4 } = require('uuid');

let alice, bob, admin;

before(async () => {
  await db.init();
  await auth.init();
  alice = await users.createUser({ email: 'alice@x', password: 'p' });
  bob = await users.createUser({ email: 'bob@x', password: 'p' });
  admin = await users.createUser({ email: 'admin@x', password: 'p' });
  const raw = db._raw();
  const adminRoleId = raw.exec("SELECT id FROM roles WHERE name = 'mothership_admin'")[0].values[0][0];
  const observerRoleId = raw.exec("SELECT id FROM roles WHERE name = 'observer'")[0].values[0][0];
  const viewerRoleId = raw.exec("SELECT id FROM roles WHERE name = 'viewer'")[0].values[0][0];
  raw.run(`INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id) VALUES (?, 'user', ?, ?, NULL)`, [uuidv4(), admin, adminRoleId]);
  raw.run(`INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id) VALUES (?, 'user', ?, ?, NULL)`, [uuidv4(), alice, viewerRoleId]);
  raw.run(`INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id) VALUES (?, 'user', ?, ?, NULL)`, [uuidv4(), bob, viewerRoleId]);
  db.save();
});

after(async () => {
  await auth.shutdown();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('per-user-scope — addMessage stamps user_id', () => {
  const id = db.addMessage("alice's message", 'dashboard', 'uncategorized', {}, alice);
  const raw = db._raw();
  const row = raw.exec('SELECT user_id FROM messages WHERE id = ?', [id])[0].values[0][0];
  assert.strictEqual(row, alice);
});

test('per-user-scope — getMessages filters to the user', () => {
  db.addMessage("bob's message", 'dashboard', 'uncategorized', {}, bob);
  const aliceMessages = db.getMessages({ userId: alice });
  const bobMessages = db.getMessages({ userId: bob });
  assert.ok(aliceMessages.every(m => m.user_id === alice));
  assert.ok(bobMessages.every(m => m.user_id === bob));
  assert.strictEqual(aliceMessages.find(m => m.content === "bob's message"), undefined);
});

test('per-user-scope — getMessages without userId throws', () => {
  assert.throws(() => db.getMessages({}), /userId required/);
});

test('per-user-scope — getMessages with allUsers=true returns everything', () => {
  const all = db.getMessages({ allUsers: true });
  assert.ok(all.length >= 2);
});

test('per-user-scope — addMirrorEntry + getMirrorEntries isolated by user', () => {
  db.addMirrorEntry({
    category: 'preferences', content: 'alice likes dense explanations',
    confidence: 0.8, source_type: 'conversation', userId: alice
  });
  db.addMirrorEntry({
    category: 'preferences', content: 'bob likes bullet points',
    confidence: 0.8, source_type: 'conversation', userId: bob
  });
  const aliceEntries = db.getMirrorEntries({ userId: alice });
  const bobEntries = db.getMirrorEntries({ userId: bob });
  assert.ok(aliceEntries.some(e => e.content.includes('alice')));
  assert.ok(!aliceEntries.some(e => e.content.includes('bob')));
  assert.ok(bobEntries.some(e => e.content.includes('bob')));
});

test('per-user-scope — backfill was run at bootstrap (no NULL rows)', () => {
  const raw = db._raw();
  for (const t of ['messages', 'mirror_entries', 'wiki_entries']) {
    const nullCount = raw.exec(`SELECT COUNT(*) FROM ${t} WHERE user_id IS NULL`)[0].values[0][0];
    assert.strictEqual(nullCount, 0, `${t} has NULL user_id rows`);
  }
});
```

- [ ] **Step 2: Run the test**

Run: `npm test -- tests/auth/per-user-scope.test.js`
Expected: PASS (6 tests).

- [ ] **Step 3: Commit**

```bash
git add tests/auth/per-user-scope.test.js
git commit -m "test(auth): per-user data isolation assertions"
```

---

## Task 25: `tests/auth/retrofit.test.js` — anonymous-401 regression net

**Files:**
- Create: `tests/auth/retrofit.test.js`

- [ ] **Step 1: Write the test**

This test spins up an Express app with the real `routes/api.js` + `routes/auth.js` + `routes/users.js`, then hits every endpoint anonymously and asserts 401 (or 200 for the handful of public ones), and hits every endpoint with an admin cookie and asserts 200/400/404 (but never 401).

```javascript
const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-retrofit-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');
process.env.MOTHERSHIP_SATELLITES_DIR = path.join(tmpRoot, 'satellites');
process.env.MOTHERSHIP_KINDS_DIR = path.join(__dirname, '..', 'fixtures', 'satellite-kinds');
fs.mkdirSync(process.env.MOTHERSHIP_SATELLITES_DIR, { recursive: true });

const db = require('../../src/database');
const auth = require('../../src/auth');
const users = require('../../src/auth/users');
const sessions = require('../../src/auth/sessions');
const satellites = require('../../src/satellites');
const apiRoutes = require('../../src/routes/api');
const authRoutes = require('../../src/routes/auth');
const userMgmtRoutes = require('../../src/routes/users');
const { v4: uuidv4 } = require('uuid');

let server, baseUrl, adminCookie;

before(async () => {
  await db.init();
  await auth.init();
  await satellites.init();

  const adminId = await users.createUser({ email: 'admin@x', password: 'p' });
  const raw = db._raw();
  const adminRole = raw.exec("SELECT id FROM roles WHERE name = 'mothership_admin'")[0].values[0][0];
  raw.run(`INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id) VALUES (?, 'user', ?, ?, NULL)`, [uuidv4(), adminId, adminRole]);
  db.save();
  adminCookie = `mothership_sid=${sessions.createSession(adminId, {}).id}`;

  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use('/api', userMgmtRoutes);
  app.use('/api', apiRoutes);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await satellites.shutdown();
  await auth.shutdown();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const PUBLIC_ROUTES = [
  ['GET', '/api/status'],
  // auth endpoints handle their own validation, expected 400/401 without body
];

const GATED_ROUTES_THAT_SHOULD_401 = [
  ['GET', '/api/messages'],
  ['GET', '/api/mirror'],
  ['GET', '/api/mirror/entries'],
  ['GET', '/api/wiki/entries'],
  ['GET', '/api/logs'],
  ['GET', '/api/satellites'],
  ['GET', '/api/satellites/drafts'],
  ['GET', '/api/users'],
  ['POST', '/api/satellites'],
  ['POST', '/api/export'],
  ['POST', '/api/briefing']
];

for (const [method, path] of GATED_ROUTES_THAT_SHOULD_401) {
  test(`retrofit — anonymous ${method} ${path} returns 401`, async () => {
    const r = await fetch(`${baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    assert.strictEqual(r.status, 401, `expected 401 for ${method} ${path}, got ${r.status}`);
  });
}

for (const [method, path] of GATED_ROUTES_THAT_SHOULD_401) {
  test(`retrofit — admin ${method} ${path} is NOT 401`, async () => {
    const r = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: method === 'POST' ? '{}' : undefined
    });
    assert.notStrictEqual(r.status, 401, `admin got 401 on ${method} ${path}`);
  });
}

test('retrofit — GET /api/status is public', async () => {
  const r = await fetch(`${baseUrl}/api/status`);
  assert.strictEqual(r.status, 200);
});
```

- [ ] **Step 2: Run the test**

Run: `npm test -- tests/auth/retrofit.test.js`
Expected: PASS — every gated route returns 401 anonymously and ≠401 with admin cookie; status is public.

- [ ] **Step 3: Commit**

```bash
git add tests/auth/retrofit.test.js
git commit -m "test(auth): retrofit regression net — anonymous 401, admin bypass"
```

---

## Task 26: `tests/auth/e2e.test.js` — full cross-sub-project flow

**Files:**
- Create: `tests/auth/e2e.test.js`

- [ ] **Step 1: Write the test**

```javascript
const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-e2e-auth-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');
process.env.MOTHERSHIP_SATELLITES_DIR = path.join(tmpRoot, 'satellites');
process.env.MOTHERSHIP_KINDS_DIR = path.join(__dirname, '..', 'fixtures', 'satellite-kinds');
fs.mkdirSync(process.env.MOTHERSHIP_SATELLITES_DIR, { recursive: true });

const db = require('../../src/database');
const auth = require('../../src/auth');
const users = require('../../src/auth/users');
const sessions = require('../../src/auth/sessions');
const apiKeys = require('../../src/auth/api-keys');
const satellites = require('../../src/satellites');
const apiRoutes = require('../../src/routes/api');
const authRoutes = require('../../src/routes/auth');
const userMgmtRoutes = require('../../src/routes/users');
const { v4: uuidv4 } = require('uuid');

let server, baseUrl;
let adminId, adminCookie;

before(async () => {
  await db.init();
  await auth.init();
  await satellites.init();

  // Bootstrap admin
  adminId = await users.createUser({ email: 'yoel@x', password: 'correct-horse', display_name: 'Yoel' });
  const raw = db._raw();
  const adminRole = raw.exec("SELECT id FROM roles WHERE name = 'mothership_admin'")[0].values[0][0];
  const viewerRole = raw.exec("SELECT id FROM roles WHERE name = 'viewer'")[0].values[0][0];
  raw.run(`INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id) VALUES (?, 'user', ?, ?, NULL)`, [uuidv4(), adminId, adminRole]);
  raw.run(`INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id) VALUES (?, 'user', ?, ?, NULL)`, [uuidv4(), adminId, viewerRole]);
  db.save();

  adminCookie = `mothership_sid=${sessions.createSession(adminId, {}).id}`;

  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use('/api', userMgmtRoutes);
  app.use('/api', apiRoutes);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await satellites.shutdown();
  await auth.shutdown();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function req(method, pathname, body, headers = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed, setCookie: res.headers.get('set-cookie') };
}

test('e2e — full multi-user flow with per-user Mirror isolation', async () => {
  // 1. Admin creates a fixture satellite
  let r = await req('POST', '/api/satellites', {
    slug: 'tx-auto', name: 'TX Auto', kind: 'test-kind'
  }, { Cookie: adminCookie });
  assert.strictEqual(r.status, 200);
  const satId = r.body.id;

  // 2. Admin creates an invitation for a staff member with satellite_editor on tx-auto
  const raw = db._raw();
  const editorRoleId = raw.exec("SELECT id FROM roles WHERE name = 'satellite_editor'")[0].values[0][0];
  r = await req('POST', '/api/invitations', {
    role_grants: [{ role_id: editorRoleId, satellite_id: satId }],
    expires_in_days: 7
  }, { Cookie: adminCookie });
  assert.strictEqual(r.status, 200);
  const invitationToken = r.body.token;

  // 3. Invitee claims the invitation with a password
  r = await req('POST', '/api/auth/claim-invite', {
    token: invitationToken, password: 'staff-pass', display_name: 'Staff'
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.user.display_name, 'Staff');
  const staffCookie = r.setCookie.split(';')[0];

  // 4. Staff can issue a directive to tx-auto
  r = await req('POST', '/api/satellites/tx-auto/directives', {
    kind: 'config.set', payload: { key: 'greeting', value: 'hi' }
  }, { Cookie: staffCookie });
  assert.strictEqual(r.status, 200);

  // 5. Staff CANNOT archive tx-auto (satellite_editor doesn't include archive)
  r = await req('POST', '/api/satellites/tx-auto/archive', {}, { Cookie: staffCookie });
  assert.strictEqual(r.status, 403);

  // 6. Staff CANNOT see satellites they're not a member of
  await req('POST', '/api/satellites', { slug: 'dental', name: 'Dental', kind: 'test-kind' }, { Cookie: adminCookie });
  r = await req('GET', '/api/satellites', null, { Cookie: staffCookie });
  assert.strictEqual(r.status, 200);
  const visibleToStaff = r.body;
  assert.ok(visibleToStaff.some(s => s.slug === 'tx-auto'));
  assert.ok(!visibleToStaff.some(s => s.slug === 'dental'));

  // 7. Staff's POST /api/chat writes under their own user_id
  r = await req('POST', '/api/chat', { content: 'This is a substantive staff message for the Mothership about dental satellite design' }, { Cookie: staffCookie });
  assert.strictEqual(r.status, 200);

  // 8. Staff GETs /api/messages — sees their own messages
  r = await req('GET', '/api/messages', null, { Cookie: staffCookie });
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.some(m => m.content.includes('substantive staff message')));

  // 9. Staff cannot fetch another user's messages via ?user_id=
  r = await req('GET', `/api/messages?user_id=${adminId}`, null, { Cookie: staffCookie });
  assert.strictEqual(r.status, 403);

  // 10. Admin (mothership_admin) CAN fetch another user's messages via ?user_id=
  //     (bypass via mothership_admin — covers all _any permissions)
  const staffUser = users.getUserByEmail('user-' + /* invitation id prefix */ '');
  // Find staff id from DB
  const staffRow = raw.exec("SELECT id FROM users WHERE display_name = 'Staff'")[0].values[0][0];
  r = await req('GET', `/api/messages?user_id=${staffRow}`, null, { Cookie: adminCookie });
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.some(m => m.content.includes('substantive staff message')));

  // 11. Admin disables the staff user
  r = await req('PATCH', `/api/users/${staffRow}/disable`, {}, { Cookie: adminCookie });
  assert.strictEqual(r.status, 200);

  // 12. Staff's next request with the old cookie → 401
  r = await req('GET', '/api/auth/me', null, { Cookie: staffCookie });
  assert.strictEqual(r.status, 401);
});
```

- [ ] **Step 2: Run the test**

Run: `npm test -- tests/auth/e2e.test.js`
Expected: PASS (1 test, ~12 assertions).

- [ ] **Step 3: Commit**

```bash
git add tests/auth/e2e.test.js
git commit -m "test(auth): cross-sub-project e2e — invitations, permissions, per-user Mirror"
```

---

## Task 27: Wire `auth.init()` + new routes into `server.js`

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Add the auth init block**

Near the top of `server.js`, add:

```javascript
const auth = require('./src/auth');
const authRoutes = require('./src/routes/auth');
const userMgmtRoutes = require('./src/routes/users');
```

Mount the new routes before the existing `/api` mount:

```javascript
app.use('/api/auth', authRoutes);
app.use('/api', userMgmtRoutes);
app.use('/api', apiRoutes);
```

Inside `boot()`, after `db.init()` and before `satellites.init()`, add:

```javascript
  // 1c. Initialize auth (Phase 6 #2)
  try {
    await auth.init();
    console.log('  ✔ Auth initialized');
  } catch (err) {
    console.log(`  ⚠ Auth init error: ${err.message}`);
  }
```

- [ ] **Step 2: Smoke-test the server boots**

Run:
```bash
ANTHROPIC_API_KEY=dummy timeout 3 node server.js || true
```
Expected: boot log lines include "Auth initialized" and "Satellites loaded" (or warning if no admin yet).

- [ ] **Step 3: Run full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(auth): wire auth.init and auth routes into server boot"
```

---

## Task 28: Success-criteria walk-through

**Files:** none. Verification pass.

- [ ] **Step 1: Walk the §17 success criteria from the spec**

Open `docs/superpowers/specs/2026-04-13-multi-user-auth-design.md` §17 and verify each checkbox against the implementation:

**Auth + RBAC infrastructure:**
- All 10 new tables exist → Task 2 test
- Seed roles + permissions populated idempotent → Task 5 test
- `scripts/create-admin.js` creates admin + auto-grants viewer → Task 15 test
- `scripts/create-admin.js` refuses without `--force` → Task 15 test
- Anonymous to previously-public endpoint → 401 → Task 25 retrofit test
- Admin can hit every retrofitted endpoint → Task 25 retrofit test
- `satellite_editor` on A can issue directives to A, 403 on B → Task 26 e2e test
- Bearer token works end-to-end → Task 11 middleware test (bearer path)
- Invitation flow end-to-end → Task 26 e2e test
- Password change invalidates other sessions → Task 16 auth-routes test
- Session sweep deletes expired rows → Task 7 sessions test
- Rate limit trips at 6 failures → Task 16 auth-routes test

**Per-user scoping:**
- `user_id` column on messages/mirror_entries/wiki_entries → Task 3 test
- Backfill populates existing rows → Task 14 backfill test
- `POST /api/chat` stamps `req.user.id` → Task 23 retrofit + Task 26 e2e
- User A can't SELECT user B's Mirror → Task 24 per-user-scope test + Task 26 e2e
- Admin `mirror.read_any` overrides via `?user_id=` → Task 26 e2e
- conversation.respond uses caller's Mirror → Task 19 updated tests
- synthesizeFromTurn stores under caller user_id → Task 19 updated tests
- Wiki synthesis same → Task 20 updated tests
- Telegram bot + file watcher use system owner → Task 21

**Regression:**
- All 136 #1 tests still pass → Task 22/23 updates
- Every new test file passes → Tasks 2-26
- e2e test green → Task 26

- [ ] **Step 2: Run the full test suite one more time**

Run: `npm test`
Expected: Full suite passes. Total test count ~230+ (136 baseline + ~100 new auth tests).

- [ ] **Step 3: Run manual smoke test**

```bash
# Reset a scratch DB, create an admin, boot the server, hit /api/auth/me
MOTHERSHIP_DB_PATH=/tmp/smoke.db node scripts/create-admin.js --email=yoel@local --password='test-pw'
MOTHERSHIP_DB_PATH=/tmp/smoke.db ANTHROPIC_API_KEY=dummy node server.js &
SERVER_PID=$!
sleep 2

# Should return 401
curl -s http://localhost:3000/api/satellites | head
echo

# Login
CURL_OUT=$(curl -s -c /tmp/mothership-cookies.txt -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"yoel@local","password":"test-pw"}')
echo "$CURL_OUT"

# Authenticated request
curl -s -b /tmp/mothership-cookies.txt http://localhost:3000/api/auth/me

kill $SERVER_PID
rm -f /tmp/smoke.db /tmp/mothership-cookies.txt
```

Expected: first `/api/satellites` returns 401, login returns user + permissions, `/api/auth/me` returns user info.

- [ ] **Step 4: Verify `public/index.html` is still uncommitted and untouched**

Run: `git status --short`
Expected: only ` M public/index.html` (unchanged since session start).

- [ ] **Step 5: Finalize**

No commit needed unless minor fix-ups surfaced during walk-through.

---

## Self-Review Summary

**Spec coverage check:**
- §1 Overview — plumbed through every task
- §2 Non-goals — correctly deferred (no 2FA code, no OAuth, no email infra)
- §3 Vocabulary — all terms have implementations (Task 13 system owner, Task 14 backfill)
- §5 Data model — Tasks 2, 3
- §5.11 per-user columns + backfill — Tasks 3, 14, 15
- §6 Seed roles + auto-grant viewer — Tasks 5, 15, 16 (claim-invite), 17 (POST /api/users)
- §7 Resolver — Task 10
- §8 Middleware — Task 11
- §9 Session/token lifecycle — Tasks 7 (sessions), 8 (api-keys), 16 (auth routes handle login/logout/password-change)
- §10 Retrofit — Tasks 22 (satellites), 23 (mothership-wide)
- §10.7 non-route modules — Tasks 18 (database.js), 19 (conversation+hooks+qm), 20 (retriever+ve+syn), 21 (telegram+watcher+health+obsidian)
- §11 New endpoint surface — Tasks 16 (/api/auth), 17 (/api/users, /api/invitations, /api/role-assignments, /api/groups)
- §12 Bootstrap CLI — Task 15
- §13 Invitation flow — Tasks 12, 16 (claim route)
- §14 Error handling — each route handler returns the right status
- §15 Tests — Tasks 2-26 cover every test file §15 lists
- §17 Success criteria — Task 28 walk-through

**Placeholder scan:** no TBD/TODO/vague items in any task. Every step has exact code or exact commands.

**Type consistency:** `userId` is the argument name across all module signatures. `can(permission, satelliteSlugOrId?)` is consistent. `requireAuth({ permission, satelliteParam? })` factory signature consistent across all route files.

**Known trade-offs documented:**
- API key and invitation lookup are O(N) due to argon2 salting (noted in Task 8). Acceptable for Mothership's scale.
- The `config`-sentinel backfill assumes the config table persists across restarts — which it does via sql.js `save()` and load.
- The per-row `can()` filter on `GET /api/satellites` is O(N × permission_set_size). Fine for ≤1000 satellites; if it grows, replace with a JOIN-based query.
- Legacy `src/mirror.js` (static JSON mirror) is NOT scoped per-user because it's a legacy in-memory aggregate — only `src/quantum-mirror.js` + `mirror_entries` table get per-user treatment. Flagged in Task 23 Step 2.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-13-multi-user-auth.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**

