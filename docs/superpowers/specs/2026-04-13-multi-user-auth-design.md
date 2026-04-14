# Multi-User Auth — Design

**Status:** draft · awaiting user review
**Date:** 2026-04-13
**Owner:** Yoel
**Phase:** 6 · sub-project #2 of 7
**Predecessor:** #1 Satellite model & registry
**Successors:** #3 Dashboard multi-tenancy, #4 Per-satellite Telegram bot runners, #5 Control plane, #6 Staff sub-agent framework, #7 Provision first real satellites

---

## 1. Overview

Phase 6 sub-project #2 adds first-class authentication, hybrid role-based access control, **and per-user data scoping** to Mothership. It shapes the system for a **public-domain deployment** with heterogeneous identities: Yoel as `mothership_admin`, staff members with scoped access to specific satellites, clients who own a single transferred satellite, and machine identities (Claude Code, Telegram bots, automation scripts) authenticated by bearer tokens.

Humans authenticate via password + server-side session cookies. Machines authenticate via opaque bearer tokens in `Authorization: Bearer <token>`. Both credential types resolve to the same `req.user` object downstream, so every permission check is uniform regardless of caller.

Permissions follow hybrid RBAC: **system roles** grant global capabilities (e.g., `mothership_admin`, `user_manager`), **satellite roles** grant per-satellite capabilities (e.g., `satellite_editor` on `texas-auto-center`). Users acquire roles directly or through **group** membership. A unified `role_assignments` table uses `principal_type` + `principal_id` + nullable `satellite_id` to discriminate every combination without table explosion.

**Per-user data scoping** is a core design tenet: every user gets their own Quantum Mirror, their own Wiki, and their own chat history with Mothership. The Mothership-core tables `messages`, `mirror_entries`, and `wiki_entries` each gain a `user_id` column; reads and writes on those tables filter by the authenticated caller's id. A one-time migration backfills existing rows with the first admin's user_id so Yoel's accumulated Mirror/Wiki/message history carries forward without interruption. System-wide reads (seeing another user's Mirror, for example) are restricted to the separate `observer` role, which is distinct from the baseline `viewer` role that every authenticated user receives automatically. Mothership infrastructure state — satellites, drafts, logs, config — remains shared and is governed by satellite-scoped roles, not per-user scoping.

This sub-project ships zero UI. The dashboard login/management screens are #3's responsibility. #2 provides the REST primitives — the `/api/auth/*`, `/api/users/*`, `/api/invitations/*`, `/api/role-assignments/*`, and `/api/groups/*` endpoint surface — the RBAC enforcement middleware that retroactively gates every existing route, and the per-user data partitioning that makes multi-user Mothership meaningful.

---

## 2. Non-goals for #2

Explicitly out of scope. Deferred to keep #2 tight.

- **TOTP/2FA.** Slots in as a small additive sub-project (#2.1) — one dependency, one column, one `/auth/mfa/*` endpoint group. Mandatory before inviting any production client.
- **OAuth / SSO (Google, GitHub).** Additive as a new `auth_method` value on the `users` table. Deferred.
- **Password reset via email.** Admin-only reset (`PATCH /api/users/:id/password` as `user_manager`). Email-based self-service reset requires outbound email infra, deferred.
- **Rate limiting beyond login attempts.** A simple in-memory counter gates `/api/auth/login` (5 attempts per IP per 15 minutes). General API rate limiting belongs at the reverse proxy (Caddy / nginx / Cloudflare) once the domain is live.
- **CSRF tokens.** SameSite=Lax cookies + origin header check on state-changing requests is the chosen defense. True CSRF tokens can be added in a follow-up if a specific flow demands them.
- **Dedicated audit log table.** Auth events log through the existing `db.log('info'/'warn', 'auth.*', ...)` pipeline into the `logs` table. A structured `audit_events` table is deferred.
- **Per-API-key scopes.** API keys inherit all of their owner's permissions. A `scope_json` column is reserved on `api_keys` but not yet populated.
- **Session device trust / fingerprinting.** 30-day expiry with IP + user-agent stamped on the row. No device-trust logic.
- **Admin dashboard UI for user management.** Endpoints ship in #2; the dashboard UI is #3.
- **Multi-tenant database isolation.** One `data/mothership.db` serves all users. Satellite sovereignty (separate DB per satellite) is already enforced by the Task 1 sovereignty wrapper.
- **Email delivery of invitations.** Invitations generate a one-time URL to be sent out of band (Signal, copy-paste, etc.).

---

## 3. Vocabulary

| Term | Meaning |
|---|---|
| **User** | An identity row in the `users` table. Represents a human (with a password) or a machine (authenticated only via API keys). |
| **Session** | A server-side row in `sessions` referenced by the `mothership_sid` cookie. HttpOnly, Secure, SameSite=Lax. |
| **API key** | An opaque bearer token stored hashed in `api_keys`. Sent as `Authorization: Bearer <token>`. |
| **System role** | A role whose `kind='system'`. Grants capabilities that apply globally, regardless of satellite. |
| **Satellite role** | A role whose `kind='satellite'`. Grants capabilities scoped to a specific satellite. |
| **Permission** | An atomic capability string like `satellite.issue_directive` or `user.create`. Roles are bundles of permissions. |
| **Principal** | Either a user or a group. Role assignments target a principal via `principal_type` + `principal_id`. |
| **Group** | A named collection of users. Assigning a role to a group grants that role to all current and future members. |
| **Invitation** | A one-time URL carrying a set of role grants. The invitee claims it by choosing a password, which creates their user account and applies the grants atomically. |
| **Bootstrap** | The first-run action that seeds the initial `mothership_admin` via `scripts/create-admin.js`. Refuses to run if any user already exists (without `--force`). |
| **Scoped table** | A Mothership-core table with a `user_id` column. Every row belongs to exactly one user. Reads filter by caller id; writes stamp it. In #2: `messages`, `mirror_entries`, `wiki_entries`. |
| **Shared table** | A Mothership-core table without a `user_id` column. Rows belong to Mothership-infrastructure as a whole, not to a specific user. In #2: `satellites`, `satellite_drafts`, `logs`, `config`, and all auth tables. |
| **System owner** | The user_id used as the default owner for Mothership pipelines that have no authenticated caller — the Telegram bot, the file watcher inbox, and any automation that runs outside a request. Resolves to the first `mothership_admin` (Yoel). |

---

## 4. Architecture overview

### 4.1 Module layout

```
src/auth/
  index.js              — public surface imported by server.js and routes
  users.js              — users CRUD, password hashing, disable/reset
  sessions.js           — session create, lookup, expire, invalidate-all
  api-keys.js           — token generate, verify, revoke
  roles.js              — seed data for roles, permissions, role_permissions
  resolver.js           — req.user.can() permission resolver
  middleware.js         — requireAuth factory (identify → validate → authorize)
  hashing.js            — argon2id wrapper over hash-wasm
  invitations.js        — generate, claim, revoke
  groups.js             — group CRUD and membership management

src/routes/
  auth.js               — /api/auth/* endpoints
  users.js              — /api/users/*, /api/invitations/*, /api/role-assignments/*, /api/groups/*
  api.js                — existing file, retrofitted with requireAuth guards

scripts/
  create-admin.js       — CLI bootstrap for the first admin
```

### 4.2 Request lifecycle

Every API request passes through the `requireAuth` middleware factory unless the route is explicitly marked public (`/api/status`, `/api/auth/login`, `/api/auth/claim-invite`).

```
┌───────────┐   ┌──────────┐   ┌──────────┐   ┌────────────┐   ┌──────────┐
│  request  │ → │ identify │ → │ validate │ → │ attach     │ → │ authorize│
└───────────┘   └──────────┘   └──────────┘   │ req.user + │   └──────────┘
                                               │ permission │
                                               │ set cache  │
                                               └────────────┘
```

- **Identify.** Extract credentials from `Cookie: mothership_sid=<id>` or `Authorization: Bearer <token>`. Bearer wins if both present (API clients override browser sessions). Missing → 401 `authentication required`.
- **Validate.** Cookie path: look up `sessions`, check `expires_at > NOW`, bump `last_seen_at`. Bearer path: argon2id-hash the presented token, look up `api_keys.token_hash`, check `disabled_at IS NULL`, bump `last_used_at`. Invalid → 401 `invalid credential`.
- **Attach.** Populate `req.user` with the user row, fetch and cache the permission set for this request.
- **Authorize.** The route-level factory `requireAuth({ permission, satelliteParam? })` calls `req.user.can(permission, req.params[satelliteParam])`. On false → 403 `forbidden: missing <permission> on <scope>`.

### 4.3 Trust boundaries

- **Plaintext credentials** (passwords, API key tokens) are only touched at the edge: `hashing.hash()` during user creation and password change, `hashing.verify()` during login and token validation. Plaintext never enters the database and never leaves the request scope.
- **API key plaintext is returned exactly once** — in the response body of `POST /api/users/:id/api-keys`. After that, only the hash lives in the DB. A lost token is a revoke + regenerate operation.
- **The session cookie is opaque.** The session id is a 32-byte random value. The cookie is HttpOnly (no JS access), Secure (HTTPS only), SameSite=Lax.

---

## 5. Data model

Ten new tables in `data/mothership.db`. All use the existing `TEXT DEFAULT (datetime('now'))` timestamp convention. All use `IF NOT EXISTS`.

### 5.1 `users`

```sql
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                          -- uuid
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  auth_method TEXT NOT NULL DEFAULT 'password', -- 'password' | 'api_key_only'
  password_hash TEXT,                           -- argon2id; NULL if auth_method='api_key_only'
  created_at TEXT DEFAULT (datetime('now')),
  disabled_at TEXT,                             -- NULL = active; non-null = soft-deleted
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_disabled ON users(disabled_at);
```

- `auth_method='password'` — human user, must have `password_hash`
- `auth_method='api_key_only'` — machine identity, `password_hash IS NULL`, authenticates only via bearer tokens
- Disabled users' sessions and api_keys return 401 regardless of row validity — enforced at middleware layer

### 5.2 `sessions`

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,                          -- 32-byte random, base64url
  user_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,                     -- created_at + 30 days
  last_seen_at TEXT DEFAULT (datetime('now')),
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
```

- 30-day default expiry, bumped on every authenticated request
- Sweep: a boot-time `DELETE WHERE expires_at < NOW` plus a daily cron via `setInterval` inside `sessions.js`
- Password change invalidates all sessions for that user

### 5.3 `api_keys`

```sql
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,                          -- uuid
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,                           -- human-readable: "claude-code-dev", "tg-bot-prod"
  token_hash TEXT NOT NULL,                     -- argon2id hash of the plaintext token
  scope_json TEXT,                              -- reserved for #2.x fine-grained scoping; unused in #2
  last_used_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  disabled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(token_hash);
```

- Plaintext token format: `mk_live_` + 32 base64url chars (prefixed so leaked tokens are instantly identifiable in logs)
- Never expires by default. Revocation is explicit via `DELETE /api/users/:id/api-keys/:keyId` (which sets `disabled_at`, does not remove the row — keeps the audit trail).

### 5.4 `groups`

```sql
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

### 5.5 `group_memberships`

```sql
CREATE TABLE IF NOT EXISTS group_memberships (
  user_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  added_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, group_id)
);
CREATE INDEX IF NOT EXISTS idx_group_memberships_user ON group_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_group_memberships_group ON group_memberships(group_id);
```

### 5.6 `roles`

```sql
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,                            -- 'system' | 'satellite'
  description TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_roles_kind ON roles(kind);
```

### 5.7 `permissions`

```sql
CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,                     -- e.g., 'satellite.issue_directive'
  description TEXT
);
```

### 5.8 `role_permissions`

```sql
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id TEXT NOT NULL,
  permission_id TEXT NOT NULL,
  PRIMARY KEY (role_id, permission_id)
);
CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_perm ON role_permissions(permission_id);
```

### 5.9 `role_assignments`

The single table that unifies (user, group) × (system, satellite) role grants.

```sql
CREATE TABLE IF NOT EXISTS role_assignments (
  id TEXT PRIMARY KEY,
  principal_type TEXT NOT NULL,                  -- 'user' | 'group'
  principal_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  satellite_id TEXT,                             -- NULL = system role; non-null = satellite-scoped
  granted_by TEXT,                               -- user_id of grantor, for audit
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_role_assignments_principal ON role_assignments(principal_type, principal_id);
CREATE INDEX IF NOT EXISTS idx_role_assignments_role ON role_assignments(role_id);
CREATE INDEX IF NOT EXISTS idx_role_assignments_satellite ON role_assignments(satellite_id);
```

Application-level invariants (not enforced by SQL because sql.js does not enable `PRAGMA foreign_keys = ON`):
- `principal_type='user'` → `principal_id` references `users.id`
- `principal_type='group'` → `principal_id` references `groups.id`
- `role_id` always references `roles.id`
- `satellite_id` (if non-null) references `satellites.id` from sub-project #1
- A role whose `kind='system'` must have `satellite_id IS NULL` in all assignments
- A role whose `kind='satellite'` must have `satellite_id` set in all assignments

Violations raise application-level errors before INSERT.

### 5.10 `invitations`

```sql
CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,               -- argon2id hash of the one-time token
  email TEXT,                                    -- optional, purely informational
  invited_by TEXT NOT NULL,                      -- user_id of inviter
  role_grants_json TEXT NOT NULL,                -- JSON array: [{role_id, satellite_id}, ...]
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  claimed_at TEXT,
  claimed_by_user_id TEXT                        -- set on claim
);
CREATE INDEX IF NOT EXISTS idx_invitations_token ON invitations(token_hash);
CREATE INDEX IF NOT EXISTS idx_invitations_expires ON invitations(expires_at);
```

- Plaintext invitation token format: `mi_` + 32 base64url chars
- Default expiry: 7 days
- Single-use: `claimed_at IS NOT NULL` means no further claims accepted
- The claim flow creates the user AND applies `role_grants_json` AND marks `claimed_at` in a single application-level transaction (best-effort, with rollback-on-partial-failure similar to `registry.createInstance`)

### 5.11 Per-user scope additions to existing tables

Three existing Mothership-core tables gain a `user_id` column so every row belongs to exactly one user. Reads filter by the caller's id; writes stamp it.

```sql
-- messages
ALTER TABLE messages ADD COLUMN user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);

-- mirror_entries
ALTER TABLE mirror_entries ADD COLUMN user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_mirror_entries_user ON mirror_entries(user_id);

-- wiki_entries
ALTER TABLE wiki_entries ADD COLUMN user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_wiki_entries_user ON wiki_entries(user_id);
```

Notes on the migration:

- **The column is added as nullable** so the ALTER statements succeed on an existing populated DB without needing a default value. Application code treats NULL as "not yet migrated" and refuses to return such rows to normal users — only `mothership_admin` can see rows with `user_id IS NULL`, and only for the purpose of assigning them.
- **Backfill runs inside `auth.init()`** after the bootstrap admin exists. The backfill performs `UPDATE messages SET user_id = <admin_id> WHERE user_id IS NULL`, similarly for the other two tables. Idempotent — once all rows have a user_id the UPDATE is a no-op.
- **The migration is gated on the first admin existing.** Before the first `scripts/create-admin.js` run, no user_id is known, so the backfill is skipped. `auth.init()` logs a warning and continues. Once the admin exists, the next boot runs the backfill exactly once.
- **After the backfill completes**, a sentinel row is written to `config`: `SET meta.per_user_backfill_done = 'true'`. On subsequent boots, the backfill function short-circuits on this flag.
- **Application-level constraint:** every INSERT into `messages`, `mirror_entries`, `wiki_entries` must supply a non-null `user_id`. The existing `db.addMessage()` and `ve.storeMirrorEntry()` APIs gain a required `user_id` parameter. Callers that don't have an authenticated user (Telegram bot, file watcher, health check synthesis) pass the "system owner" id — resolved via `getSystemOwnerId()` which returns the oldest `mothership_admin`.

**No ALTER on `logs`, `config`, `satellites`, `satellite_drafts`, `sessions`, `api_keys`, `role_assignments`, `groups`, `group_memberships`, `invitations`, `roles`, `permissions`, `role_permissions`.** These are either infrastructure (shared by everyone) or already have their own ownership model (auth tables reference users explicitly via `user_id` where appropriate, but that's a FK, not a scoping column).

---

## 6. Seed data — roles, permissions, role_permissions

Seeded on first migration via `src/auth/roles.js`. The seed is idempotent — safe to re-run after every boot. The source of truth is a JS constant; the migration reads it and `INSERT OR IGNORE`s rows.

### 6.1 Permission atoms

```javascript
const PERMISSIONS = [
  // User management (system-level)
  { name: 'user.create',          desc: 'Create new users directly' },
  { name: 'user.list',            desc: 'List all users' },
  { name: 'user.disable',         desc: 'Disable a user account' },
  { name: 'user.reset_password',  desc: 'Admin-reset another user password' },
  { name: 'invitation.create',    desc: 'Generate invitation links' },
  { name: 'invitation.list',      desc: 'List outstanding invitations' },
  { name: 'invitation.revoke',    desc: 'Revoke an unclaimed invitation' },
  { name: 'role.assign',          desc: 'Grant roles to users or groups' },
  { name: 'role.revoke',          desc: 'Revoke role assignments' },
  { name: 'group.create',         desc: 'Create groups' },
  { name: 'group.edit',           desc: 'Edit group membership and metadata' },
  { name: 'group.delete',         desc: 'Delete groups' },

  // Per-user self-scoped data (baseline — granted to `viewer` and implicitly
  // scoped to the caller's own user_id)
  { name: 'mirror.read',          desc: 'Read your own Quantum Mirror entries' },
  { name: 'wiki.read',            desc: 'Read your own Wiki entries' },
  { name: 'message.read',         desc: 'Read your own ingested messages' },
  { name: 'chat.send',            desc: 'Send chat turns to Mothership via /api/chat' },

  // Cross-user reads (admin-level — granted to `observer` and inherited by
  // `mothership_admin`. Holders can see ANY user's Mirror/Wiki/messages.)
  { name: 'mirror.read_any',      desc: "Read any user's Quantum Mirror entries" },
  { name: 'wiki.read_any',        desc: "Read any user's Wiki entries" },
  { name: 'message.read_any',     desc: "Read any user's messages" },

  // Mothership-wide reads (operator-level)
  { name: 'log.read',             desc: 'Read system logs' },
  { name: 'export.run',           desc: 'Run export jobs' },
  { name: 'briefing.run',         desc: 'Run synthesis briefings' },

  // Drafts (system-level — drafts are Mothership-wide, not per-satellite)
  { name: 'draft.create',         desc: 'Create satellite drafts' },
  { name: 'draft.read',           desc: 'Read satellite drafts' },
  { name: 'draft.edit_status',    desc: 'Change a drafts status' },
  { name: 'draft.regenerate_brief', desc: 'Regenerate a drafts brief via LLM' },

  // Satellites (system-level for creation/listing)
  { name: 'satellite.create',     desc: 'Create new satellites' },
  { name: 'satellite.list',       desc: 'List satellites the caller can see' },

  // Satellites (satellite-scoped — applied per satellite_id)
  { name: 'satellite.read',       desc: 'Read a satellites registry row + loaded db' },
  { name: 'satellite.edit_config',     desc: 'Edit a satellites config' },
  { name: 'satellite.issue_directive', desc: 'Issue directives to a satellite' },
  { name: 'satellite.read_directives', desc: 'Read a satellites directive history' },
  { name: 'satellite.archive',    desc: 'Archive a satellite' },
  { name: 'satellite.unarchive',  desc: 'Unarchive a satellite' },
  { name: 'satellite.transfer',   desc: 'Transfer a satellite to a client' },
  { name: 'satellite.set_visibility', desc: 'Change a satellites visibility tier' }
];
```

### 6.2 Seed roles

```javascript
const ROLES = [
  // System roles
  { name: 'mothership_admin', kind: 'system', desc: 'Superuser — bypasses all checks',
    permissions: '*' },   // special sentinel; resolver short-circuits

  { name: 'user_manager', kind: 'system', desc: 'Manages users, invitations, role assignments',
    permissions: [
      'user.create', 'user.list', 'user.disable', 'user.reset_password',
      'invitation.create', 'invitation.list', 'invitation.revoke',
      'role.assign', 'role.revoke',
      'group.create', 'group.edit', 'group.delete'
    ] },

  // Viewer is the baseline role every authenticated user receives on account
  // creation. It grants access to the user's OWN scoped data (their own
  // Mirror, Wiki, messages, chat with Mothership) plus the ability to list
  // satellites and read drafts. Nothing cross-user. Every normal Mothership
  // user operates as a `viewer` with zero or more satellite-role grants on
  // top.
  { name: 'viewer', kind: 'system', desc: 'Baseline role for authenticated users — access to own scope',
    permissions: [
      'chat.send',
      'mirror.read',    // self-scoped; filtered by user_id = caller
      'wiki.read',      // self-scoped
      'message.read',   // self-scoped
      'draft.read',
      'satellite.list'
    ] },

  // Observer is the ADMIN read role — it can see across all users' Mothership
  // data. Distinct from `viewer`, which is self-scoped. Use sparingly.
  { name: 'observer', kind: 'system', desc: 'Admin read-only across all users',
    permissions: [
      'mirror.read_any', 'wiki.read_any', 'message.read_any',
      'log.read', 'draft.read', 'satellite.list'
    ] },

  { name: 'draft_author', kind: 'system', desc: 'Creates and edits satellite drafts',
    permissions: [
      'draft.create', 'draft.read', 'draft.edit_status', 'draft.regenerate_brief'
    ] },

  // Satellite roles
  { name: 'satellite_owner', kind: 'satellite', desc: 'Full control over a specific satellite',
    permissions: [
      'satellite.read', 'satellite.edit_config',
      'satellite.issue_directive', 'satellite.read_directives',
      'satellite.archive', 'satellite.unarchive',
      'satellite.transfer', 'satellite.set_visibility'
    ] },

  { name: 'satellite_editor', kind: 'satellite', desc: 'Edit config and issue directives',
    permissions: [
      'satellite.read', 'satellite.edit_config',
      'satellite.issue_directive', 'satellite.read_directives'
    ] },

  { name: 'satellite_directive_issuer', kind: 'satellite',
    desc: 'Issue directives only (shaped for Claude Code and automation bots)',
    permissions: [
      'satellite.read', 'satellite.issue_directive', 'satellite.read_directives'
    ] },

  { name: 'satellite_viewer', kind: 'satellite', desc: 'Read-only at the current visibility tier',
    permissions: [
      'satellite.read', 'satellite.read_directives'
    ] }
];
```

### 6.3 Seeding behavior

The `src/auth/roles.js` module exports `seedOnce(db)` which:
1. `INSERT OR IGNORE`s every permission in `PERMISSIONS`.
2. `INSERT OR IGNORE`s every role in `ROLES`.
3. For each role, `INSERT OR IGNORE`s the role_permissions rows linking the role to its permission list. `mothership_admin`'s `'*'` sentinel means no rows are inserted — the resolver handles this role via an explicit bypass.
4. Called from `auth.init()`, which runs after `db.init()` during boot.

### 6.4 Auto-grant of `viewer` on user creation

Every user creation path automatically grants the `viewer` system role. This is the difference between "a user account exists" and "a user can actually use Mothership":

- `scripts/create-admin.js` — the bootstrap admin receives both `mothership_admin` AND `viewer`. The `mothership_admin` bypass would cover `viewer`'s permissions anyway, but the explicit grant keeps the model uniform and makes revoking `mothership_admin` safe (the admin downgrades to a normal user without losing access to their own Mirror).
- `POST /api/users` (admin-created) — user gets `viewer` automatically unless `--skip-default-roles` is passed in the body.
- `POST /api/auth/claim-invite` — user gets `viewer` + whatever role grants were listed in the invitation.

The auto-grant is a single `role_assignments` row with `principal_type='user'`, `principal_id=<new user id>`, `role_id=<viewer role id>`, `satellite_id=NULL`. If the grant fails for any reason, user creation rolls back.

---

## 7. Permission resolver — `req.user.can()`

### 7.1 Algorithm

```javascript
function can(user, permission, satelliteSlug = null) {
  // Mothership admin bypass
  if (user.systemRoles.includes('mothership_admin')) return true;

  // Resolve slug → id (cached per request)
  const satelliteId = satelliteSlug ? resolveSatelliteId(satelliteSlug) : null;

  // Hit the cached permission set
  const key = satelliteId ? `${permission}|${satelliteId}` : `${permission}|GLOBAL`;
  if (user.permissionSet.has(key)) return true;

  // Fallback: if the same permission exists at GLOBAL scope (granted via
  // a system role), let it satisfy a per-satellite query too. The seed
  // roles in §6 don't exercise this path — satellite-scoped permissions
  // only appear on satellite-role assignments by design. The fallback is
  // a defensive measure for custom roles that future operators may define.
  if (satelliteId && user.permissionSet.has(`${permission}|GLOBAL`)) return true;

  return false;
}
```

### 7.2 Building the permission set

On credential validation (session lookup or api-key lookup), `resolver.loadPermissionSet(userId)` runs once and caches the result on `req.user`:

```sql
-- Collect all roles assigned to the user (direct + group-inherited)
SELECT ra.role_id, ra.satellite_id
FROM role_assignments ra
WHERE (ra.principal_type = 'user' AND ra.principal_id = ?)
   OR (ra.principal_type = 'group' AND ra.principal_id IN (
        SELECT group_id FROM group_memberships WHERE user_id = ?
      ))
```

Then for each returned `(role_id, satellite_id)` pair, expand via `role_permissions` into `(permission_name, satellite_id)` entries, which populate the `permissionSet: Set<string>` using the `"{perm}|{satellite_id or GLOBAL}"` encoding.

Result is an in-memory Set with O(1) lookup. Typical sets have 10-30 entries for staff users and 5-10 for machine identities.

### 7.3 Performance

- One JOIN query per request on first `can()` call. Cached for the rest of the request.
- No N+1 issues — everything is joined.
- For heavy users (many groups + many satellite assignments), the query cost is bounded by `O(roles × satellites)`. Even a user with access to 100 satellites × 5 roles would produce a 500-row result, which sql.js handles in <5 ms.

---

## 8. Middleware — `requireAuth({ permission, satelliteParam? })`

### 8.1 Factory signature

```javascript
const { requireAuth } = require('../auth/middleware');

router.post('/satellites/:slug/directives',
  requireAuth({ permission: 'satellite.issue_directive', satelliteParam: 'slug' }),
  (req, res) => { /* ... */ }
);
```

- `permission` — required atom name to check
- `satelliteParam` — (optional) name of the Express route param that holds the satellite slug. When present, the resolver runs a per-satellite check. When absent, the check is global.
- A second convenience factory `requireAnyAuth()` (no permission check) is available for endpoints that need `req.user` but have their own authorization logic inside the handler (e.g., `GET /api/satellites` which filters the list based on what the user can see — no single permission covers that).

### 8.2 Stages in detail

**Identify.**
```javascript
const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
const cookieSid = req.cookies?.mothership_sid;
const credential = bearer || cookieSid;
if (!credential) return res.status(401).json({ error: 'authentication required' });
```

Bearer wins if both are present.

**Validate.**
- Bearer path: argon2id-hash the presented token, SELECT from `api_keys WHERE token_hash = ? AND disabled_at IS NULL`. On match, JOIN to `users` (reject if `disabled_at IS NOT NULL`), bump `last_used_at`, populate `req.user`.
- Cookie path: SELECT from `sessions WHERE id = ? AND expires_at > NOW`. On expired: DELETE the row. On match: JOIN to `users` (reject if disabled), bump `last_seen_at`, populate `req.user`.

Invalid/expired/disabled → 401 `invalid credential`.

**Authorize.**
```javascript
const ok = req.user.can(permission, req.params[satelliteParam]);
if (!ok) return res.status(403).json({
  error: `forbidden: missing ${permission}${satelliteParam ? ` on ${req.params[satelliteParam]}` : ''}`
});
```

### 8.3 Attaching `req.user`

The user object attached to the request:

```javascript
req.user = {
  id: 'uuid',
  email: 'yoel@example.com',
  display_name: 'Yoel',
  auth_method: 'password',
  systemRoles: ['mothership_admin'],   // Array<string> of system role names
  permissionSet: Set {
    'mirror.read|GLOBAL',
    'satellite.issue_directive|<sat-uuid>',
    // ...
  },
  can(permission, satelliteSlugOrId?) { /* resolver */ }
};
```

---

## 9. Session and token lifecycle

### 9.1 Login (`POST /api/auth/login`)

Body: `{ email, password }`.

1. Look up user by email. If missing or disabled → 401 (don't leak which).
2. `hashing.verify(user.password_hash, password)`. If false → 401 + increment rate-limit counter.
3. On success: generate 32 random bytes → base64url → session id. INSERT into `sessions` with `expires_at = NOW + 30 days`, `ip = req.ip`, `user_agent = req.headers['user-agent']`.
4. Set cookie: `Set-Cookie: mothership_sid=<id>; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000; Path=/`.
5. Respond `{ user: { id, email, display_name }, permissions: [...array form of permissionSet] }`.

### 9.2 Logout (`POST /api/auth/logout`)

Deletes the current `sessions` row, clears the cookie, responds 204.

### 9.3 Password change (`PATCH /api/auth/password`)

Body: `{ current_password, new_password }`.
1. Verify `current_password` against `req.user.password_hash`.
2. Hash `new_password`.
3. `UPDATE users SET password_hash = ?`.
4. `DELETE FROM sessions WHERE user_id = ? AND id != ?` (invalidate all other sessions, keep current).
5. Log `auth.password_changed`.

### 9.4 Session sweep

Two-pronged cleanup:
- **Boot-time:** `sessions.sweepExpired()` runs once at `auth.init()` time, deletes rows where `expires_at < NOW`.
- **Daily cron:** `setInterval(sweepExpired, 24 * 60 * 60 * 1000)` — same function.

### 9.5 API key generation (`POST /api/users/:id/api-keys`)

1. Check `req.user.can('user.list')` (admin operation; scoped by user target).
2. Generate 32 random bytes → base64url, prefix with `mk_live_`.
3. Hash with argon2id, INSERT into `api_keys`.
4. Return `{ id, name, token: '<plaintext>' }` — plaintext shown once.

### 9.6 Rate limiting (login only, in-memory)

A module-local `Map<ip, { count, windowStart }>` counts failed login attempts. After 5 failures in 15 minutes, subsequent attempts from that IP return 429 until the window passes. No persistence — resets on process restart. Good enough until a real reverse proxy takes over.

---

## 10. Retrofit plan

Every existing endpoint in `src/routes/api.js` gets gated. Grouped by permission.

### 10.1 Public (no auth)

- `GET /api/status`
- `POST /api/auth/login`, `POST /api/auth/logout`, `POST /api/auth/claim-invite`

### 10.2 Per-user scoped endpoints (self-filtering)

These endpoints return only the authenticated caller's own data. Middleware gate: `requireAuth({ permission: <self-scoped perm> })`. Handler-level filter: `WHERE user_id = req.user.id`. An admin user with `mirror.read_any` / `wiki.read_any` / `message.read_any` can override the filter via an explicit `?user_id=<other>` query param — the handler checks for that param and, if present, verifies the caller has the `_any` variant before honoring it.

| Endpoint | Permission (baseline) | Override permission |
|---|---|---|
| `GET /api/messages`, `GET /api/messages/:id` | `message.read` | `message.read_any` via `?user_id=` |
| `POST /api/messages` | `message.read` (writes to caller's scope) | n/a |
| `POST /api/chat` | `chat.send` (stamps `req.user.id` into `messages.user_id` AND `metadata`) | n/a |
| `GET /api/mirror`, `GET /api/mirror/models`, `GET /api/mirror/learning`, `GET /api/mirror/knowledge`, `GET /api/mirror/resonance`, `GET /api/mirror/entries` | `mirror.read` | `mirror.read_any` via `?user_id=` |
| `POST /api/mirror/resonance` | `mirror.read` (writes to caller's scope) | n/a |
| `GET /api/wiki/entries` | `wiki.read` | `wiki.read_any` via `?user_id=` |

### 10.3 Mothership operator endpoints (system permissions, not user-scoped)

| Endpoint | Permission |
|---|---|
| `GET /api/logs` | `log.read` |
| `POST /api/export` | `export.run` (exports the caller's own Mirror/Wiki; admins can pass `?user_id=`) |
| `POST /api/briefing` | `briefing.run` |

### 10.4 Satellite endpoints (satellite-scoped permissions, except where noted)

| Endpoint | Permission | Scope |
|---|---|---|
| `POST /api/satellites` | `satellite.create` | system |
| `GET /api/satellites` | `satellite.list` + list-filtered by visible satellites | system + per-row |
| `GET /api/satellites/:slug` | `satellite.read` | `slug` |
| `POST /api/satellites/:slug/archive` | `satellite.archive` | `slug` |
| `POST /api/satellites/:slug/unarchive` | `satellite.unarchive` | `slug` |
| `POST /api/satellites/:slug/transfer` | `satellite.transfer` | `slug` |
| `POST /api/satellites/:slug/visibility` | `satellite.set_visibility` | `slug` |
| `POST /api/satellites/:slug/directives` | `satellite.issue_directive` | `slug` |
| `GET /api/satellites/:slug/directives` | `satellite.read_directives` | `slug` |

### 10.5 Draft endpoints (system-scoped)

| Endpoint | Permission |
|---|---|
| `POST /api/satellites/drafts` | `draft.create` |
| `GET /api/satellites/drafts` | `draft.read` |
| `GET /api/satellites/drafts/:slug` | `draft.read` |
| `POST /api/satellites/drafts/:slug/regenerate-brief` | `draft.regenerate_brief` |
| `POST /api/satellites/drafts/:slug/status` | `draft.edit_status` |

### 10.6 The `GET /api/satellites` filter

Unlike most endpoints, this does not 401 unauthenticated users past the `requireAnyAuth()` stage — instead, it returns the subset of satellites that the authenticated user has `satellite.read` permission for. Implementation:

```javascript
router.get('/satellites', requireAnyAuth(), (req, res) => {
  const all = satellites.registry.listRows({ status: req.query.status, ... });
  const visible = all.filter(row => req.user.can('satellite.read', row.slug));
  res.json(visible);
});
```

A user with zero memberships gets `[]`. A user with `mothership_admin` gets everything. A staff member with `satellite_editor` on one satellite gets a one-element array.

### 10.7 Per-user scoping changes to non-route modules

The retrofit is not purely a routing concern — several Mothership modules that currently operate in a global namespace need to accept a `userId` parameter and scope their reads/writes to it.

**`src/database.js`** — `addMessage`, `getMessages`, `getMessageCount`, `getSourceCounts`, `getCategoryCounts` all gain a required `userId` parameter. SELECTs add `WHERE user_id = ?` (or `WHERE user_id = ? OR ? = 'ANY'` for admin overrides). INSERTs stamp `user_id`. The existing three-argument `addMessage(content, source, category, metadata)` signature becomes `addMessage({ content, source, category, metadata, userId })` — callers are updated in the same task.

Similar updates for `addMirrorEntry`, `getMirrorEntries`, `supersedeMirrorEntry`, `addWikiEntry`, `getWikiEntries`, `getAllWikiEntries`, `updateWikiEntry`.

**`src/conversation.js`** — `buildHistory` takes a `userId` argument and filters by it. `respond(userText, opts)` signature adds `opts.userId` (required) and passes it through the synthesis pipeline.

**`src/conversation-hooks.js`** — `postResponse({ userText, assistantText, sourceId, draftSlug, userId })` passes `userId` into `quantum-mirror.synthesizeFromTurn`.

**`src/quantum-mirror.js`** — `synthesizeFromTurn({ userId, ... })` stores new Mirror entries under that `userId`. `getExistingCandidates` filters by `userId`.

**`src/synthesizer.js`** — `synthesizeFromContent({ userId, ... })` stores new Wiki entries under that `userId`.

**`src/memory/retriever.js`** — `buildContextBlock(query, { userId, mirrorTopK, wikiTopK })` filters Mirror/Wiki retrieval by `userId`.

**`src/memory/vector-engine.js`** — `storeMirrorEntry({ userId, ... })`, `storeWikiEntry({ userId, ... })`, `searchMirrorByQuery({ userId, ... })`, `searchWikiByQuery({ userId, ... })`.

**`src/telegram.js`** — the Telegram bot has no authenticated caller context. It resolves the "system owner" user_id once at startup (via `auth.getSystemOwnerId()`, which returns the oldest `mothership_admin`) and uses it for every message ingested through the Telegram pipeline. Later, sub-project #4's per-satellite bots will each map to their own service-account user.

**`src/watcher.js`** — the file watcher inbox uses the system owner id for the same reason.

**`src/health-check.js`** — the weekly decay/synthesis health check iterates over all users and runs the decay + gap analysis per-user. Scans `users WHERE disabled_at IS NULL` and processes each in sequence.

**`src/exporters/obsidian.js`** — export runs scoped to a single user at a time. `exportAll({ userId })` writes that user's Mirror + Wiki to their vault. The default Obsidian vault path becomes per-user via env vars or DB config, with the old single-path behavior kept as a fallback when only one user exists.

---

## 11. New endpoint surface

### 11.1 `/api/auth/*` (public or self-service)

| Method | Path | Auth | Body / Behavior |
|---|---|---|---|
| POST | `/api/auth/login` | public | `{ email, password }` → session cookie + `{ user, permissions }` |
| POST | `/api/auth/logout` | session | clears session and cookie |
| GET | `/api/auth/me` | session or bearer | returns `req.user` + permission set |
| POST | `/api/auth/claim-invite` | public | `{ token, password, display_name }` → claims invitation, creates user, logs in |
| PATCH | `/api/auth/password` | session | `{ current_password, new_password }` — self-service change |

### 11.2 `/api/users/*` (requires `user.*` permissions)

| Method | Path | Permission |
|---|---|---|
| POST | `/api/users` | `user.create` |
| GET | `/api/users` | `user.list` |
| GET | `/api/users/:id` | `user.list` |
| PATCH | `/api/users/:id/disable` | `user.disable` |
| PATCH | `/api/users/:id/password` | `user.reset_password` |
| POST | `/api/users/:id/api-keys` | authenticated; **self-or-admin check in handler** (allowed if `:id == req.user.id`, else requires `user.reset_password`) |
| GET | `/api/users/:id/api-keys` | authenticated; same self-or-admin check |
| DELETE | `/api/users/:id/api-keys/:keyId` | authenticated; same self-or-admin check |

The three api-key endpoints use `requireAnyAuth()` at the middleware layer and perform the self-or-admin check inside the handler. Rationale: every authenticated user should be able to manage their own API keys (generate/list/revoke) without any role grant, but touching another user's keys is a sensitive admin operation that requires the same permission as resetting their password.

### 11.3 `/api/invitations/*`

| Method | Path | Permission |
|---|---|---|
| POST | `/api/invitations` | `invitation.create` |
| GET | `/api/invitations` | `invitation.list` |
| DELETE | `/api/invitations/:id` | `invitation.revoke` |

Create body: `{ email?, expires_in_days?, role_grants: [{ role_id, satellite_id? }] }`.

### 11.4 `/api/role-assignments/*`

| Method | Path | Permission |
|---|---|---|
| POST | `/api/role-assignments` | `role.assign` |
| GET | `/api/role-assignments` | `role.assign` |
| DELETE | `/api/role-assignments/:id` | `role.revoke` |

Create body: `{ principal_type, principal_id, role_id, satellite_id? }`.

### 11.5 `/api/groups/*`

| Method | Path | Permission |
|---|---|---|
| POST | `/api/groups` | `group.create` |
| GET | `/api/groups` | `group.create` |
| PATCH | `/api/groups/:id` | `group.edit` |
| DELETE | `/api/groups/:id` | `group.delete` |
| POST | `/api/groups/:id/members` | `group.edit` |
| DELETE | `/api/groups/:id/members/:userId` | `group.edit` |

---

## 12. Bootstrap — `scripts/create-admin.js`

CLI usage:

```bash
node scripts/create-admin.js \
  --email=yoel@example.com \
  --password='<secure>' \
  --display-name='Yoel'
```

Behavior:

1. Requires `--email` and `--password` (errors out otherwise with usage help).
2. Connects to `data/mothership.db` via the existing `src/database.js` module. Calls `db.init()`.
3. Calls `auth.init()` which creates auth tables if missing and seeds roles/permissions.
4. Counts rows in `users`. If count > 0 and `--force` is not passed → error out with "use --force to create another admin".
5. Hashes password with `hashing.hash()` (argon2id via `hash-wasm`).
6. INSERTs the user with `auth_method='password'`.
7. INSERTs two role assignments for the new user: the `mothership_admin` system role (`satellite_id=NULL`) AND the baseline `viewer` system role. Both are system-scoped.
8. Runs the one-time per-user backfill (§5.11): `UPDATE messages SET user_id = <new admin id> WHERE user_id IS NULL`, similarly for `mirror_entries` and `wiki_entries`. Sets the `config.meta.per_user_backfill_done` sentinel. This step is skipped if the sentinel is already set (which means a prior run of this script already did the backfill).
9. Prints `{ id, email, display_name }` and exits 0.

### 12.1 Dependency choice: `hash-wasm`

The existing project rule forbids native-compilation dependencies (project CLAUDE.md: "Always use pure JS or WASM alternatives"). The popular `argon2` npm package is a native binding, so it's excluded. `hash-wasm` is a pure-WASM argon2id implementation (~45 KB gzipped, no Node-native bindings, works cross-platform including Windows).

`package.json` dep addition:
```json
"hash-wasm": "^4.11.0"
```

Sample usage in `src/auth/hashing.js`:
```javascript
const { argon2id } = require('hash-wasm');

async function hash(password) {
  const salt = crypto.randomBytes(16);
  return argon2id({
    password,
    salt,
    parallelism: 1,
    iterations: 3,
    memorySize: 65536,     // 64 MiB
    hashLength: 32,
    outputType: 'encoded'  // produces the standard $argon2id$... string
  });
}

async function verify(encoded, password) {
  return argon2id.verify({ password, hash: encoded });
}
```

---

## 13. Invitation flow

### 13.1 Create

Admin POSTs:

```json
{
  "email": "staff@tx-auto.com",
  "expires_in_days": 7,
  "role_grants": [
    { "role_id": "<satellite_editor uuid>", "satellite_id": "<texas-auto-center uuid>" }
  ]
}
```

Server:
1. Generates 32 random bytes → base64url → token.
2. Prepends `mi_` → plaintext (e.g. `mi_abc123...`).
3. argon2id-hashes the plaintext.
4. INSERTs into `invitations` with `expires_at = NOW + expires_in_days`.
5. Returns `{ id, token: '<plaintext>', url: 'https://<domain>/claim?token=<plaintext>', expires_at }`.

Admin copies the URL out of band (Signal, etc.) to the invitee.

### 13.2 Claim

Invitee lands on `/claim?token=<plaintext>` (dashboard page, #3), which POSTs:

```json
{ "token": "<plaintext>", "password": "<chosen>", "display_name": "Jane Smith" }
```

Server:
1. argon2id-hashes the token and looks up `invitations` by `token_hash`.
2. Checks `claimed_at IS NULL` and `expires_at > NOW`. Fail → 400.
3. Creates a `users` row with `auth_method='password'`, hashed password.
4. Grants the baseline `viewer` system role (auto-grant; see §6.4).
5. Parses `role_grants_json` from the invitation and inserts one additional `role_assignments` row per grant.
6. Updates `invitations`: `claimed_at = NOW`, `claimed_by_user_id = <new user id>`.
7. Creates a session and sets the cookie.
8. Responds `{ user, permissions }`.

Partial failure: steps 3-6 are wrapped in a best-effort transaction — if any of steps 4-6 fails, step 3's user row is rolled back (`DELETE FROM users WHERE id = ?`) and the invitation is not marked claimed.

---

## 14. Error handling & failure modes

| Failure | Behavior |
|---|---|
| Missing credential | 401 `authentication required` |
| Invalid cookie or bearer | 401 `invalid credential` |
| Expired session | 401 `invalid credential`, session row deleted |
| Disabled user | 401 `invalid credential` (don't leak distinction) |
| Missing permission | 403 `forbidden: missing <perm> on <scope>` |
| Login rate limit exceeded | 429 `too many attempts` |
| Password verify throws | 500, log `auth.verify_error`, no user context leaked |
| Invitation expired | 400 `invitation expired` |
| Invitation already claimed | 400 `invitation already claimed` |
| Role assignment to nonexistent role | 400 `unknown role` |
| Role assignment satellite-scoped role with null satellite_id | 400 `satellite role requires satellite_id` |
| Role assignment system-scoped role with non-null satellite_id | 400 `system role cannot be satellite-scoped` |
| Bootstrap script run with existing users + no --force | exit 1, log `bootstrap refused: users exist` |
| Seed role table mismatch (code has a role DB doesn't) | `auth.init()` inserts the missing role automatically |
| Seed permission mismatch | same — auto-insert |

All auth events log through `db.log('info'/'warn', 'auth.<event>', ...)` to the existing `logs` table. Success path: `login`, `logout`, `password_changed`, `user_created`, `api_key_created`, `api_key_used`, `invitation_created`, `invitation_claimed`, `role_assigned`, `role_revoked`. Failure path: `login_failed`, `credential_invalid`, `permission_denied`.

---

## 15. Testing strategy

Test framework: `node --test`, same as #1. New test root: `tests/auth/`.

### 15.1 Unit tests

| File | Coverage |
|---|---|
| `tests/auth/hashing.test.js` | `hash()` produces encoded string, `verify()` accepts correct + rejects wrong, argon2id encoded format check |
| `tests/auth/users.test.js` | create, lookup by email, disable, reset password, password change invalidates other sessions |
| `tests/auth/sessions.test.js` | create, lookup, expire, sweep, invalidate user sessions |
| `tests/auth/api-keys.test.js` | generate (returns plaintext once), verify, disable, last_used_at bump |
| `tests/auth/roles.test.js` | seedOnce is idempotent, role-permission lookup works, seed content matches constants |
| `tests/auth/resolver.test.js` | `can()` across all matrix cases: direct user role (system + satellite), group-inherited role, both at once (dedup), mothership_admin bypass, wrong satellite, nonexistent permission, system role satisfies per-satellite check |
| `tests/auth/invitations.test.js` | create, claim, double-claim fails, expired claim fails, role grants applied, viewer auto-granted |
| `tests/auth/per-user-scope.test.js` | Core partitioning guarantees: user A cannot SELECT user B's `messages`/`mirror_entries`/`wiki_entries`, admin with `*_any` can override via `?user_id=`, `addMessage` stamps `user_id` correctly, retriever filters by `userId`, backfill populates NULL rows with the bootstrap admin, backfill is idempotent on second run |

### 15.2 Integration tests

| File | Coverage |
|---|---|
| `tests/auth/middleware.test.js` | express app + real routes: anonymous→401, invalid cookie→401, valid cookie no permission→403, valid cookie with permission→200, expired→401+row deleted, bearer→200+last_used_at bumped, disabled api_key→401, login rate limit→429 after 5 failures |
| `tests/auth/retrofit.test.js` | every existing endpoint exercised anonymously (expect 401), with admin session (expect 200), with insufficient-permission session (expect 403). This is the regression safety net for the retrofit. |
| `tests/auth/bootstrap.test.js` | `scripts/create-admin.js` as a subprocess with `--email` + `--password`, verifies user row + mothership_admin assignment, second run without `--force` fails, `--force` creates another admin |
| `tests/auth/e2e.test.js` | Full cross-sub-project flow: bootstrap admin → admin creates invitation with `satellite_editor` role on a fixture satellite → invitee claims → invitee gets auto-granted `viewer` + the invitation's `satellite_editor` → invitee issues directive → invitee cannot archive → invitee cannot touch other satellites → invitee `POST /api/chat` creates messages scoped to their own user_id → admin GETs `/api/mirror/entries` and sees only their own Mirror → admin GETs `/api/mirror/entries?user_id=<invitee>` and sees the invitee's Mirror (via `mirror.read_any`) → admin disables invitee → invitee next request returns 401 |

### 15.3 Regression — #1 tests

All 136 existing sub-project #1 tests must continue passing. The retrofit changes the error code for unauthenticated requests from 200 (previously — endpoints were public) to 401, so several existing tests in `tests/satellites/api.test.js` will need to be updated to log in first. This is part of the work, not regression.

---

## 16. Security trade-offs (documented)

The threat model is "public-domain deployment with HTTPS, minimum hardening, expectation of a reverse proxy in front." Explicit decisions worth naming:

- **Password hashing:** argon2id with m=64 MiB, t=3, p=1. Meets OWASP 2026 baseline. Pure-WASM implementation (hash-wasm) avoids native deps per project rule.
- **Session storage:** server-side DB, opaque cookie. No JWT — simpler revocation, no key rotation problem, no token-size bloat.
- **Cookie flags:** HttpOnly (no JS access) + Secure (HTTPS only) + SameSite=Lax (allows same-site navigation, blocks cross-site state-changing POSTs).
- **CSRF:** SameSite=Lax is the primary defense. Critical state-changing endpoints (password change, role grants) additionally check `Origin` header matches the configured deployment origin. Full CSRF tokens deferred to #2.x.
- **API key format:** prefixed (`mk_live_`) so leaks are detectable by secret scanners (GitHub, etc.). Argon2id-hashed at rest; plaintext shown exactly once.
- **Password leakage surface:** plaintext only exists in (a) the request body on login/password-change/claim-invite, (b) the hashing function's local variable. Never logged, never stored.
- **Bootstrap secret handling:** the CLI takes `--password` as an argument, which is visible in `ps` output. Acceptable for a one-shot install-time action; a `--password-from-stdin` variant is a trivial follow-up if needed.
- **Rate limiting scope:** only `POST /api/auth/login`. General API rate limiting is a reverse-proxy concern (Caddy, nginx, Cloudflare).
- **Session fixation:** each login generates a fresh session id. The existing session (if any) is left alone — the new cookie overwrites the old one in the browser.
- **Token length:** 32 random bytes = 256 bits of entropy, well above brute-force attack ranges.

---

## 17. Success criteria

Sub-project #2 is complete when all of the following are true:

**Auth + RBAC infrastructure:**
- [ ] All 10 new tables exist in `data/mothership.db` after boot
- [ ] Seed roles and permissions populated and idempotent across reboots
- [ ] `scripts/create-admin.js` creates the first `mothership_admin` successfully and auto-grants `viewer`
- [ ] `scripts/create-admin.js` refuses to run when users already exist (without `--force`)
- [ ] Anonymous request to any previously-public endpoint (except `/api/status`) returns 401
- [ ] An admin session can hit every retrofitted endpoint and gets 200
- [ ] A `satellite_editor` session on satellite A can issue directives to A and gets 403 on B
- [ ] A bearer token authenticates end-to-end: generate → use → revoke → 401
- [ ] Invitation flow works end-to-end: create → claim → viewer auto-granted → invitation role grants applied → user logged in
- [ ] Password change invalidates all other sessions for that user
- [ ] Session sweep deletes expired rows at boot and on the daily cron
- [ ] Rate limit on `/api/auth/login` trips at 6 consecutive failures from one IP

**Per-user data scoping:**
- [ ] `user_id` column present on `messages`, `mirror_entries`, `wiki_entries`
- [ ] Backfill populates all existing rows with the bootstrap admin's user_id, idempotent on second run
- [ ] `POST /api/chat` stamps `req.user.id` into the created rows
- [ ] User A cannot SELECT user B's Mirror/Wiki/messages via the standard GET endpoints
- [ ] Admin with `mirror.read_any` can override via `?user_id=<other>` and see another user's data
- [ ] `conversation.respond` uses the caller's own Mirror + Wiki as context
- [ ] `quantum-mirror.synthesizeFromTurn` writes new entries under the caller's user_id
- [ ] `synthesizer.synthesizeFromContent` writes new Wiki entries under the caller's user_id
- [ ] Telegram bot and file watcher use the `system_owner` id (resolved to the bootstrap admin)

**Regression:**
- [ ] All 136 existing #1 tests still pass (retrofitted tests now log in first)
- [ ] Every new test file in §15 passes
- [ ] `tests/auth/e2e.test.js` cross-sub-project flow passes green, including the Mirror partitioning checks

---

## 18. What this unblocks

- **#3 Dashboard multi-tenancy** — consumes `GET /api/auth/me`, `GET /api/satellites` (filtered list), `POST /api/auth/login`, `POST /api/auth/logout`, and the full `/api/users/*` + `/api/invitations/*` surface to build the login screen, the satellite switcher, and user management UIs. Also gets per-user Mirror/Wiki/chat UIs for free — the backend already filters by caller. No new backend auth work; #3 is pure UI.
- **#4 Per-satellite Telegram bot runners** — each bot runner authenticates to Mothership via an API key, mapped to a machine user with `satellite_directive_issuer` role on its target satellite.
- **#5 Control plane** — cross-satellite queries scoped by `req.user.permissionSet`. A `mothership_admin` gets a system-wide briefing; an `observer` gets their own subset.
- **#6 Staff sub-agent framework** — staff-authored sub-agents run under a machine user with a narrow role (`satellite_viewer` or `satellite_directive_issuer`), logged via the existing auth pipeline.
- **#7 Provision real satellites** — Texas Auto Center, ABC Auto Titles, etc. get real user accounts, real invitations, real role assignments, and real API keys for their respective bots.

---

## 19. Open questions deliberately deferred

1. **How do we handle session renewal for long-lived API clients?** Cookie sessions bump `last_seen_at` but don't extend `expires_at`. For the dashboard this is fine (users re-login every 30 days). Dashboard UX can add a "remember me" toggle later.
2. **Should there be a `mothership_viewer` system role for read-only Mothership-wide access?** The `observer` role covers this. Might split later if the role bundle proves too narrow or too broad.
3. **Per-API-key scope restrictions (GitHub-PAT style).** Reserved `scope_json` column, not implemented. Add when a real use case demands it.
4. **Invitation email delivery.** The URL is shared out of band. Add an SMTP/Resend integration when #3 adds the dashboard UI for it.
5. **Self-signup for public clients.** Not in #2. Every user account is either created by an admin or claimed via an invitation. Self-signup (with email verification + admin approval) is a potential future sub-project but not planned.
6. **Hardware key / WebAuthn.** Way out of scope for #2. Considered only if #2.1 TOTP isn't enough.
7. **Audit log retention and querying.** Auth events go to the existing `logs` table. A dedicated table with structured columns is a follow-up if the existing `logs` schema proves insufficient.
