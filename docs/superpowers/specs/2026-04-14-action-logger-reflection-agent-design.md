# Action Logger + Reflection Agent — Design

**Status:** Approved for implementation planning
**Date:** 2026-04-14
**Phase:** 5 (Self-improvement loop)
**Owner:** Yoel

## 1. Purpose

Build the self-improvement substrate for MOTHERSHIP. Two coupled subsystems:

1. **Action logger** — records two kinds of events into a unified timeline: (a) user actions (commitments, wins, stumbles, states, preferences) extracted from conversation, and (b) Mothership actions (replies, synthesis runs, categorizations, prompt changes) logged directly at the callsite.
2. **Reflection agent** — runs daily, reads the last 24h of actions, produces a briefing for the user, proposes Mirror entries from detected patterns, and proposes prompt changes to improve Mothership's own behavior. Prompt changes go through an approval flow with a replay-based evaluation.

Together these close the loop described in CLAUDE.md Phase 5: "Action logger, Reflection Agent, prompt versioning."

## 2. Design decisions (from brainstorming)

| # | Question | Decision |
|---|---|---|
| 1 | What does the loop learn about? | **Both:** Mothership itself AND the user. Unified data path. |
| 2 | How are user actions captured? | **Hybrid extraction:** implicit LLM extraction on every qualifying turn, auto-log high-confidence candidates, queue borderline ones for confirm/reject via Telegram or dashboard. |
| 3 | Reflection cadence? | **Daily only**, 07:00 local time, configurable. Slash command `/reflect` for on-demand runs. |
| 4 | Self-improvement aggressiveness? | **Proposed changes (semi-active)** — reflection drafts prompt diffs, replay eval runs against a sample of past actions, user approves via dashboard or `/proposals` slash command. Mirror entries from detected patterns are written autonomously (consistent with existing `postResponse` synthesis). |
| 5 | Architecture shape? | **Inline (minimalist)** — reuse existing patterns from `health-check.js`, `quantum-mirror.js`, `conversation-hooks.js`. No event bus. Not a satellite. |

## 3. Data model

Four new tables in `src/database.js`. All multi-tenant via `user_id`.

### 3.1 `actions`

The unified event log for both user and Mothership actions.

```sql
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- user: commitment|win|stumble|state|preference
                                   -- mothership: mothership_reply|mothership_synthesis|
                                   --             mothership_categorize|mothership_prompt_change|
                                   --             mothership_prompt_change_rejected
  subject TEXT NOT NULL,           -- short one-line description
  data JSON,                       -- kind-specific structured payload
  confidence REAL DEFAULT 0.8,     -- extractor confidence (user-side)
  status TEXT DEFAULT 'active',    -- active|pending_confirm|rejected|resolved|expired
  source_type TEXT NOT NULL,       -- conversation|ingestion|dashboard|hook|satellite
  source_id TEXT,                  -- FK into messages.id when applicable
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT,                -- set when a commitment becomes a win/stumble
  parent_action_id TEXT            -- self-reference: links resolving action to its commitment
);
CREATE INDEX IF NOT EXISTS idx_actions_user_created ON actions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_actions_kind_status ON actions(kind, status);
```

### 3.2 `reflections`

One row per daily reflection pass.

```sql
CREATE TABLE IF NOT EXISTS reflections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  generated_at TEXT DEFAULT (datetime('now')),
  window_start TEXT NOT NULL,      -- typically generated_at - 24h
  window_end TEXT NOT NULL,
  briefing_md TEXT NOT NULL,       -- rendered markdown digest
  action_count INTEGER,
  pattern_json JSON,               -- {patterns:[...], anomalies:[...]}
  self_critique_json JSON,         -- {issues:[...], proposals:[...]}
  delivered_telegram INTEGER DEFAULT 0,
  delivered_obsidian TEXT          -- filepath or NULL if skipped
);
CREATE INDEX IF NOT EXISTS idx_reflections_user_generated ON reflections(user_id, generated_at DESC);
```

### 3.3 `prompt_versions`

Prompt registry with monotonic version history. Replaces hardcoded prompt strings throughout `src/`.

```sql
CREATE TABLE IF NOT EXISTS prompt_versions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,              -- e.g. 'system.conversation', 'synthesis.mirror'
  version INTEGER NOT NULL,        -- 1, 2, 3… monotonic per name
  body TEXT NOT NULL,
  is_active INTEGER DEFAULT 0,     -- exactly one row per name has is_active=1
  created_at TEXT DEFAULT (datetime('now')),
  created_by TEXT,                 -- bootstrap|reflection|manual
  parent_version INTEGER,          -- NULL for v1
  UNIQUE (name, version)
);
CREATE INDEX IF NOT EXISTS idx_prompt_versions_active ON prompt_versions(name, is_active);
```

### 3.4 `prompt_proposals`

Pending prompt diffs awaiting approval.

```sql
CREATE TABLE IF NOT EXISTS prompt_proposals (
  id TEXT PRIMARY KEY,
  prompt_name TEXT NOT NULL,
  base_version INTEGER NOT NULL,   -- the version this was forked from
  proposed_body TEXT NOT NULL,
  rationale TEXT NOT NULL,
  replay_results_json JSON,        -- {sample_size, agreement_rate, regressions, improvements}
  replay_error TEXT,               -- populated if replay.run() failed
  status TEXT DEFAULT 'pending',   -- pending|approved|rejected|superseded
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_prompt_proposals_status ON prompt_proposals(status);
```

### 3.5 Seed migration

On first boot after this change, `database.js init()` invokes `prompts.seedFromHardcoded()`, which writes v1 rows for every existing hardcoded prompt:

- `system.conversation` (from `conversation.js`)
- `synthesis.mirror` (from `memory/synthesis-prompts.js` → `MIRROR_SYNTHESIS`)
- `synthesis.wiki` (from `memory/synthesis-prompts.js`)
- `health.contradictions` (from `HEALTH_CONTRADICTIONS`)
- `health.gap_analysis` (from `GAP_ANALYSIS`)
- `extractor.actions` (new — the hybrid extraction prompt)
- `reflection.daily` (new — the daily reflection prompt)

Idempotent: seeding checks for existence by `name` and no-ops if a v1 already exists.

## 4. Components

### 4.1 New files

**`src/action-logger.js`** (target ~250 lines)
- `logAction({kind, subject, data, userId, sourceType, sourceId, confidence, status})` — direct structured log. Used by Mothership-side callsites.
- `logActionFromTurn({userText, assistantText, sourceId, userId})` — orchestrates the extractor, auto-logs high-confidence, queues borderline, drops low-confidence.
- `confirmPendingAction(actionId)` / `rejectPendingAction(actionId)` — pending queue transitions.
- `resolveAction(actionId, resolutionActionId)` — links a commitment to its resolving win/stumble, sets `resolved_at`.

**`src/extractors/action-extractor.js`** (~150 lines)
- `extract({userText, assistantText, existingContext})` — single Claude haiku call, returns `{candidates: [{kind, subject, data, confidence}]}`. Prompt body loaded via `prompts.getPrompt('extractor.actions')`.
- Uses the `_setClient()` injection pattern so tests can mock.

**`src/reflection.js`** (~280 lines)
- `runNow({userId})` — the daily pass. Pulls actions in window, calls Claude opus with the `reflection.daily` prompt, parses response, writes `reflections` row, triggers replay for each proposed prompt change, writes `prompt_proposals` rows, flows Mirror proposals through `vector-engine`, calls `deliverBriefing()`.
- `start()` — schedules `setInterval` at the configured hour. Same `.unref()` pattern as `health-check.js`.
- `deliverBriefing(reflection, userId)` — chunked Telegram push + Obsidian `_reports/daily_YYYY-MM-DD.md` write.
- Module-level `reflectionInProgress` flag prevents concurrent runs; second caller receives `{status: 'already_running', started_at}`.

**`src/prompts/registry.js`** (~200 lines)
- `getPrompt(name)` — returns active body. In-memory cache, invalidated on `activateVersion`. Fallback to per-prompt `FALLBACK` constants if no active version exists (defensive; registry is load-bearing).
- `listVersions(name)` — full history for a prompt name.
- `listActive()` — all currently-active prompts, for reflection's self-critique input.
- `createVersion(name, body, {createdBy, parentVersion})` — inserts a new row with `is_active=0`.
- `activateVersion(name, version)` — transactional: UPDATE old row `is_active=0`, UPDATE new row `is_active=1`, COMMIT. On failure, ROLLBACK and leave cache alone.
- `seedFromHardcoded()` — idempotent migration.

**`src/prompts/replay.js`** (~220 lines)
- `run({promptName, proposedBody, sampleSize})` — pulls last N actions matching the prompt's usage pattern, reconstructs inputs from `messages` rows, runs both active and proposed prompts through claude-haiku-4-5, computes deterministic diff (agreement rate, regressions, improvements), returns structured result.
- If sample size < 5, returns `{sample_size, skipped: true, reason: 'insufficient_history'}`.
- Per-sample failures logged and skipped; diff computed over surviving samples.

**`src/routes/actions.js`** (~180 lines)
- `GET /api/actions` — filtered list (kind, status, date range).
- `GET /api/actions/pending` — pending_confirm queue.
- `POST /api/actions/:id/confirm` | `/reject` | `/resolve` — status transitions.
- `GET /api/reflections/latest` — dashboard feed.
- `GET /api/prompt-proposals?status=pending` — review queue.
- `POST /api/prompt-proposals/:id/approve` | `/reject` — approval transitions; approve path calls `prompts.createVersion` + `prompts.activateVersion`.
- All endpoints require authenticated user via existing auth middleware.

### 4.2 Modified files

- **`src/database.js`** — four new tables + indexes in `init()`. New helpers: `addAction`, `updateActionStatus`, `getActions`, `getPendingActions`, `getActionsByWindow`, `addReflection`, `getLatestReflection`, plus full CRUD for `prompt_versions` and `prompt_proposals`. All multi-tenant by `user_id`.
- **`src/conversation-hooks.js`** — `postResponse` gains a tail call to `action-logger.logActionFromTurn()`. Error-swallowed, same pattern as the existing `qm.synthesizeFromTurn` call.
- **`src/conversation.js`** — replace hardcoded `SYSTEM_PROMPT` with `prompts.getPrompt('system.conversation')`. Capture active prompt version number and pass it along as part of the reply metadata so the Mothership-side action log records which version produced the reply.
- **`src/quantum-mirror.js`** — `MIRROR_SYNTHESIS` import replaced with `prompts.getPrompt('synthesis.mirror')`. After synthesis, call `logAction({kind: 'mothership_synthesis', data: {created, superseded, prompt_version}})`. **New exported function `storeFromReflection({ proposals, userId, reflectionId })`** — takes an array of mirror proposals produced by the reflection agent and writes them through `vector-engine.storeMirrorEntry` with `source_type='reflection'` and `source_id=reflectionId`. Uses the same supersession logic as `synthesizeFromTurn` so reflection-sourced entries merge cleanly with conversation-sourced ones.
- **`src/synthesizer.js`** — `WIKI_SYNTHESIS`-equivalent prompt replaced with `prompts.getPrompt('synthesis.wiki')`. After synthesis, call `logAction({kind: 'mothership_synthesis', data: {updated_topics, prompt_version}})`.
- **`src/health-check.js`** — `HEALTH_CONTRADICTIONS` and `GAP_ANALYSIS` imports replaced with `prompts.getPrompt('health.contradictions')` and `prompts.getPrompt('health.gap_analysis')`. Original constants remain in the module as `FALLBACK_CONTRADICTIONS` / `FALLBACK_GAP_ANALYSIS` for the registry safety net.
- **`src/processor.js`** — after file categorization, call `logAction({kind: 'mothership_categorize', data: {detected_kind, confidence, filename}})`.
- **`src/telegram.js`** — new `/reflect` and `/proposals` slash commands. Inline-keyboard confirm/reject flow for pending actions (identical pattern to the existing media mode picker).
- **`server.js`** — mount `/api/actions` router; call `prompts.seedFromHardcoded()` after `db.init()`; call `reflection.start()` in boot sequence after `healthcheck.start()`.
- **`public/index.html`** — two new dashboard tabs: **Actions** (list, filters, confirm/reject pending queue) and **Reflections** (latest briefing, prompt-proposal queue with side-by-side diff viewer and replay results).

### 4.3 Directory additions

Two new subdirectories under `src/`:
- `src/prompts/` — for `registry.js` and `replay.js` (future: eval runner, prompt-specific helpers).
- `src/extractors/` — for `action-extractor.js` (future: BI, Teaching, Physical Life agents will each have their own extractor).

Justified because each subdirectory will host 3+ files within the next two phases.

### 4.4 File-size budget

No new file exceeds ~280 lines. If `reflection.js` or `action-logger.js` crosses ~300 lines during implementation, that is a signal to split (e.g., move the extractor orchestration out of `action-logger.js` into its own `src/extractors/extractor-runner.js`).

## 5. Data flows

### 5.1 Flow 1 — User message capture (hybrid extraction)

```
Telegram text received
  → telegram.js stores the message, calls conversation.respond()
  → conversation.respond() runs preResponse → Claude → postResponse (unchanged)
  → postResponse tail calls:
      (a) quantum-mirror.synthesizeFromTurn()                     [existing]
      (b) action-logger.logActionFromTurn()                       [new]
          ↓
          guard: skip if userText.length < 40
          guard: skip if URL-only message
          guard: skip if slash command
          guard: skip if another message arrived < 3s ago (batching)
          ↓
          action-extractor.extract() — claude-haiku-4-5
          returns {candidates: [{kind, subject, data, confidence}, ...]}
          ↓
          for each candidate:
            confidence ≥ 0.75 → logAction with status='active'
            0.5 ≤ confidence < 0.75 → logAction with status='pending_confirm'
            confidence < 0.5 → drop
          ↓
          for each pending_confirm: send Telegram inline-keyboard message
            "📝 Did you mean to commit to '<subject>'?  ✓ / ✗"
```

Cost: extraction uses haiku (~10% of the opus cost already paid for the reply). Short-circuit guards drop extraction for obvious non-events.

### 5.2 Flow 2 — Mothership action capture (direct log)

```
conversation.respond() completes
  → logAction({kind:'mothership_reply',
               data:{prompt_version:'system.conversation@3', tokens_in, tokens_out},
               sourceId, userId})

quantum-mirror.synthesizeFromTurn() completes
  → logAction({kind:'mothership_synthesis',
               data:{created, superseded, prompt_version:'synthesis.mirror@2'},
               sourceId, userId})

processor.processFile() completes
  → logAction({kind:'mothership_categorize',
               data:{detected_kind, confidence, filename},
               sourceId, userId})
```

No LLM call on this path. Pure direct writes. `prompt_version` capture makes the replay eval possible — we can reconstruct exactly which prompt was live when each action happened.

### 5.3 Flow 3 — Daily reflection

```
setInterval fires at 07:00 local (or /reflect slash command)
  → reflection.runNow({userId})
      1. Check reflectionInProgress flag; if set, return {already_running}.
      2. window = [now - 24h, now]
      3. actions = db.getActionsByWindow(user_id, window)
      4. activePrompts = prompts.listActive()
      5. reflectionPromptBody = prompts.getPrompt('reflection.daily')
      6. Claude opus call with:
           - actions (user + mothership, unified)
           - active Mirror entries
           - active prompt bodies for self-critique
         Returns JSON:
         {
           briefing_md: "...",
           patterns: [{description, evidence_action_ids, confidence}],
           self_critique: [{prompt_name, issue, proposed_body, rationale}],
           mirror_proposals: [{category, content, confidence, supporting_action_ids}]
         }
      7. db.addReflection(row)
      8. For each self_critique entry with proposed_body:
           replay_results = replay.run({promptName, proposedBody, sampleSize: 20})
           db.addPromptProposal({..., replay_results_json: replay_results})
      9. For each mirror_proposal:
           quantum-mirror.storeFromReflection(...) — flows through vector-engine with source_type='reflection'
     10. deliverBriefing(reflection)
           - chunk + Telegram push (respect 4096-char limit)
           - write OBSIDIAN_VAULT_PATH/_reports/daily_YYYY-MM-DD.md
     11. Clear reflectionInProgress flag.
```

Step 9 closes the raw-observation → compressed-insight loop: raw `state` actions are observed by the reflection agent, patterns are proposed as Mirror entries, those entries surface in tomorrow's conversation context via `preResponse`.

### 5.4 Flow 4 — Replay eval for a proposed prompt change

```
replay.run({promptName:'synthesis.mirror', proposedBody, sampleSize:20})
  1. samples = db.getActions({
       kind: 'mothership_synthesis',
       limit: 20,
       order: 'created_at DESC'
     })
  2. Filter samples to those where data.prompt_version matches an active-at-the-time version.
  3. If filtered count < 5 → return {sample_size:N, skipped:true, reason:'insufficient_history'}.
  4. For each sample, reconstruct input:
       sourceId → messages row → userText + assistantText
  5. For each sample, run both prompts through claude-haiku-4-5:
       baseline_out = claude(activeBody, input)
       proposed_out = claude(proposedBody, input)
     (Per-sample failures are logged and skipped; continue to next sample.)
  6. Deterministic diff analysis:
       - JSON-parse both outputs
       - agreement_rate = matching decisions / surviving_sample_size
       - regressions = samples where proposed dropped entries baseline kept
       - improvements = samples where proposed added entries baseline missed
                        (weighted by whether those are in thin_mirror_categories
                         from the latest health-check gap analysis)
  7. Return {
       sample_size: surviving,
       baseline_summary: {...},
       proposed_summary: {...},
       agreement_rate: 0.75,
       regressions: [{sample_id, issue}],
       improvements: [{sample_id, note}]
     }
```

Cost: 20 samples × 2 prompts × haiku ≈ 40 cheap calls per proposal. A reflection run producing 3 proposals costs ~120 haiku calls — well under a dollar.

### 5.5 Flow 5 — Approval

```
User sees daily briefing with "3 prompt proposals awaiting review"
User opens dashboard → Reflections tab → sees pending proposals
  OR types /proposals in Telegram → inline-keyboard list with ✓/✗ per proposal

Each proposal view shows:
  - prompt name + base version
  - rationale (from the self-critique)
  - current body / proposed body (side-by-side diff)
  - replay results: agreement rate, regressions, improvements
  - [Approve] [Reject] buttons

On approve:
  POST /api/prompt-proposals/:id/approve
  → prompts.createVersion(name, proposed_body, {createdBy:'reflection', parentVersion})
  → prompts.activateVersion(name, new_version)  -- transactional
  → in-memory cache invalidates
  → prompt_proposals: status='approved', resolved_at=now
  → logAction({kind:'mothership_prompt_change', data:{name, from:base_version, to:new_version}})
  → next call to prompts.getPrompt(name) returns new body

On reject:
  → prompt_proposals: status='rejected', resolved_at=now
  → logAction({kind:'mothership_prompt_change_rejected', data:{name, proposal_id}})
```

### 5.6 Flow 6 — Commitment resolution

```
User: "I'll ship mirror v2 by Friday"
  → action-extractor returns {kind:'commitment', subject:'ship mirror v2',
                              data:{what:'ship mirror v2', due_at:'2026-04-17'},
                              confidence:0.92}
  → auto-logged as active

Friday morning reflection runs:
  → finds commitment in 24h window (or retroactively scans open commitments)
  → no child action with parent_action_id = this id
  → briefing includes "⏰ Commitment due today: ship mirror v2 (set Mon)"

User: "shipped mirror v2 ✓"
  → extractor returns {kind:'win', subject:'shipped mirror v2', confidence:0.88}
  → reflection agent (or resolver heuristic) links via parent_action_id
  → commitment.resolved_at = now, status='resolved'
```

## 6. Error handling

The existing codebase enforces a rule in `conversation-hooks.js` and `quantum-mirror.js`: **synthesis/tail operations must never break the user path**. Every new module honors this rule.

### 6.1 Action capture (Flow 1)

- `logActionFromTurn` wraps its Claude call in try/catch. On failure: `db.log('error', 'action-extractor', err.message)`, return empty. The user reply already shipped.
- Malformed JSON from extractor: parse-with-regex-fallback (same pattern as `quantum-mirror.parseJsonFromText`). If fallback fails, log warn, return empty.
- Per-candidate write failure: each candidate writes inside its own try/catch so one bad row doesn't drop the rest (matches `quantum-mirror.js` line 66–80).

### 6.2 Mothership direct logs (Flow 2)

- `logAction()` wraps DB write in try/catch. On failure: log error, return silently. Losing an audit row is regrettable but not user-visible.

### 6.3 Daily reflection (Flow 3)

- `reflection.runNow()` tolerates partial failure:
  - Claude call fails → log error, skip today's reflection. Tomorrow retries.
  - `replay.run()` fails for one proposal → that proposal is stored with `replay_results_json=null` and `replay_error=<msg>`. Other proposals continue. UI shows "(replay failed — approve blind or reject)".
  - Telegram delivery failure does not block Obsidian write; Obsidian write failure does not block Telegram. Each logged independently.
- **Concurrency lock:** module-level `reflectionInProgress` flag. Second caller returns `{status:'already_running', started_at}` without running. Single-process architecture makes this sufficient.
- **Proposal backlog cap:** if more than `MAX_PENDING_PROPOSALS` (default 20) exist for a given `prompt_name`, reflection stops generating new proposals for that prompt until the queue drains.

### 6.4 Prompt registry (Flow 5)

- `activateVersion()` is transactional: `BEGIN` → UPDATE old `is_active=0` → UPDATE new `is_active=1` → `COMMIT`. On mid-flight failure, `ROLLBACK` and leave cache untouched.
- `getPrompt()` cache miss: load from DB; on empty result (no active version found), fall back to per-prompt `FALLBACK` constant in the calling module. Registry is load-bearing — a missing `system.conversation` must not brick user conversations.

### 6.5 Replay eval (Flow 4)

- Sample size < 5 → skip with `{skipped:true, reason:'insufficient_history'}`. UI renders "not enough history to evaluate."
- Per-sample haiku failure → log, continue. Diff computed over surviving samples.
- Whole-run failure → proposal row still created with `replay_results_json:null` + `replay_error` so user can see and decide.

### 6.6 Cost runaway kill switch

- Env flag `ACTION_EXTRACTION_ENABLED` (default `true`). Set `false` to short-circuit all extractor calls if costs spike.
- Short-circuit guards before LLM call: `userText.length < 40`, URL-only, slash command, or another message within 3 seconds (batching heuristic).

## 7. Testing

Matches existing `tests/` layout. Uses `node --test`, in-memory SQLite, mocked Claude clients via the `_setClient()` injection pattern already used by `quantum-mirror.js` and `health-check.js`.

### 7.1 New test files

- `tests/action-logger.test.js`
  - `logAction` writes expected row.
  - `logActionFromTurn` with mocked extractor: auto-logs ≥0.75, queues 0.5–0.75, drops <0.5.
  - `confirmPendingAction` / `rejectPendingAction` transition status correctly.
  - `resolveAction` sets `resolved_at` and `parent_action_id`.

- `tests/action-extractor.test.js`
  - Mocked Claude returns fixed JSON → candidates parsed correctly.
  - Malformed JSON → empty candidates, logged warn, no throw.
  - Short input (< 40 chars) → no extractor call (spy on injected client).

- `tests/prompts-registry.test.js`
  - `seedFromHardcoded` is idempotent on second run.
  - `createVersion` + `activateVersion` flip `is_active` atomically.
  - `getPrompt` cache returns new body after `activateVersion`.
  - `getPrompt` fallback returns `FALLBACK` constant when no active version exists.
  - Transaction rollback leaves old version active if activate fails mid-flight.

- `tests/prompts-replay.test.js`
  - Seeded past actions → replay runs both prompts, returns structured diff.
  - Sample size < 5 → `skipped: true`.
  - Per-sample failure → diff still computed over surviving samples.

- `tests/reflection.test.js`
  - `runNow` with seeded actions produces a reflection row.
  - Concurrency lock: second call returns `already_running`.
  - Replay failure doesn't block proposal creation.
  - `deliverBriefing`: Telegram failure doesn't block Obsidian write (both mocked).

### 7.2 Integration tests

- `tests/action-flow.test.js` — end-to-end: seed user + message → call `conversation.respond()` → assert an action row exists with expected kind and `source_id`. Uses real extractor with mocked Claude returning deterministic candidate.
- `tests/prompt-approval-flow.test.js` — seed a proposal → POST `/api/prompt-proposals/:id/approve` → assert new `prompt_versions` row has `is_active=1`, old row is `is_active=0`, `getPrompt` returns new body.
- `tests/reflection-to-mirror.test.js` — seed 24h of `state` actions with a clear pattern → run `reflection.runNow()` with mocked Claude returning a Mirror proposal → assert Mirror entry written via `vector-engine` with `source_type='reflection'`.

### 7.3 Regression coverage

`tests/conversation-hooks.test.js` already exercises `postResponse`. When `logActionFromTurn` is wired into `postResponse`, that test file gains an assertion that an action row is created, and that extractor failure does not break the hook contract. No new file — one extra assertion block in the existing test.

### 7.4 Fixtures

Add `tests/fixtures/action-candidates.json` with canned LLM responses for three scenarios:
1. Clear commitment ("I'll ship X by Friday")
2. Ambiguous state ("I'm drained")
3. Malformed JSON (parse-fallback path)

### 7.5 Coverage target

Every new file has a corresponding test file. Every new route has an integration test. Every new DB helper is exercised directly or via the modules that use it. Total new tests: ~25–30 across 7 files.

### 7.6 Test injection requirement

All new modules that instantiate Claude clients MUST expose `_setClient()` for test injection, matching `quantum-mirror.js` and `health-check.js`. No module-level `new Anthropic()` at import time.

## 8. Migration and rollout

1. **Schema migration:** `database.js init()` adds the four new tables + indexes. Idempotent (`CREATE TABLE IF NOT EXISTS`).
2. **Prompt seed migration:** `prompts.seedFromHardcoded()` runs after `db.init()` on every boot. Idempotent: no-ops if v1 already exists for each prompt name.
3. **Hardcoded-prompt cutover:** `conversation.js`, `quantum-mirror.js`, `synthesizer.js`, `health-check.js` replace their imported prompt constants with `prompts.getPrompt(name)`. The original constant remains in the calling module as `FALLBACK` so the registry has a safety net.
4. **Boot sequence:** `server.js` gains `prompts.seedFromHardcoded()` after `db.init()` and `reflection.start()` after `healthcheck.start()`.
5. **Dashboard tabs:** Actions and Reflections added to `public/index.html`. No existing tabs affected.
6. **No data backfill required:** historical messages are left alone. Action log starts from the moment `postResponse` wiring ships. Mothership-side action log starts populating immediately for all new replies/synthesis runs.

## 9. Out of scope (YAGNI)

Explicitly NOT in this build:

- **Weekly reflection pass** — `health-check.js` already runs weekly for DB-level audits. Adding a second weekly pass was considered in brainstorming and dropped.
- **Event-triggered reflection** — threshold-based automatic reflection runs. Considered and dropped; `setInterval` daily + `/reflect` on-demand covers the use cases without the noise risk.
- **Autonomous prompt changes (Option C from brainstorming)** — every prompt change requires human approval.
- **Per-user reflection scheduling** — global daily hour for now; per-user schedules can come later.
- **Cross-prompt eval (one proposal evaluated against multiple prompt names)** — out of scope; each proposal targets one prompt name.
- **Historical action backfill** — no retroactive extraction from the existing `messages` table.
- **Action categories for BI / Teaching / Physical Life agents** — those agents are Phase 4 work. The schema supports them (the `kind` field is open), but this spec only implements the five user kinds (commitment, win, stumble, state, preference) and the Mothership kinds.
- **Prompt A/B testing in production** — replay is synchronous against historical samples, not live traffic splitting.

## 10. Risks and open questions

**Risk: extractor cost runaway.** Mitigated by short-circuit guards, haiku model choice, and the `ACTION_EXTRACTION_ENABLED` kill switch. Monitor spend in first week post-deploy.

**Risk: replay eval false positives.** A prompt change can have high agreement rate on past samples but behave worse on future ones. Mitigation: agreement rate is one signal among several (regressions and improvements are also shown); user is the final judge.

**Risk: cache/DB drift.** If `activateVersion` commits but cache invalidation throws, cache is stale until restart. Mitigation: simple `try/catch` around the cache invalidation with a warn log and a singleton "dirty" flag that forces a reload on next `getPrompt` call.

**Risk: reflection agent proposing garbage Mirror entries.** Because Mirror writes are autonomous (not human-approved), bad patterns could pollute the Mirror. Mitigation: reflection-sourced Mirror entries use `source_type='reflection'` so they can be filtered out or bulk-cleaned separately. The existing `health-check.js` contradiction scan will catch obviously wrong entries.

**Open question (non-blocking):** should `resolveAction` linkage be automatic (reflection agent heuristically links wins to open commitments by subject similarity) or explicit (user must confirm each link)? Design assumes reflection agent links automatically during daily pass; if false positives become a problem, we add a confirm step. Not a blocker for v1.

## 11. Success criteria

The implementation is complete when:

1. A user text message triggers an `actions` row via `logActionFromTurn` within 3 seconds of the reply shipping.
2. Borderline candidates appear as pending_confirm and can be resolved via Telegram inline keyboard or dashboard.
3. Every Mothership reply, synthesis run, and categorization writes a `mothership_*` action row.
4. Daily reflection runs automatically at the configured hour, produces a briefing delivered to Telegram + Obsidian, and writes pending prompt proposals for any self-critique items.
5. Approving a prompt proposal via dashboard or `/proposals` Telegram flow creates a new `prompt_versions` row, activates it, and the very next Mothership reply/synthesis uses the new prompt body.
6. Rejecting a proposal leaves the registry untouched.
7. The replay eval produces structured diffs for proposals with ≥5 historical samples and `{skipped:true}` otherwise.
8. All new tests pass under `npm test`.
9. `ACTION_EXTRACTION_ENABLED=false` cleanly disables extraction without breaking anything else.
10. No hardcoded prompt string remains in `conversation.js`, `quantum-mirror.js`, `synthesizer.js`, or `health-check.js` — all go through `prompts.getPrompt()`.
