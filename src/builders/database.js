/**
 * MOTHERSHIP Builder System — Database Layer
 *
 * All DB operations for the builder system. Uses the same sql.js db instance
 * as the core database via _raw(). Schema: see schema.sql.
 */

const { v4: uuidv4 } = require('uuid');
const mainDb = require('../database');

function getDb() {
  const raw = mainDb._raw();
  if (!raw) throw new Error('builders/database: db not initialized — call db.init() first');
  return raw;
}

function save() {
  mainDb.save();
}

// ─── Schema init ─────────────────────────────────────────────────────────────

function initBuilderTables() {
  const db = getDb();

  db.run(`
    CREATE TABLE IF NOT EXISTS builder_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description_md TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','complete')),
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_builder_projects_status ON builder_projects(status)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS builder_goals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      objective TEXT NOT NULL,
      context_md TEXT,
      acceptance_criteria_md TEXT,
      steps_json TEXT DEFAULT '[]',
      dependencies_json TEXT DEFAULT '[]',
      priority INTEGER NOT NULL DEFAULT 3,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','assigned','in_progress','done','cancelled')),
      generated_at TEXT DEFAULT (datetime('now')),
      generated_by_model TEXT,
      project_id TEXT
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_builder_goals_status ON builder_goals(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_builder_goals_project ON builder_goals(project_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_builder_goals_priority ON builder_goals(priority)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS builder_goal_assignments (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      builder_telegram_chat_id TEXT NOT NULL,
      builder_name TEXT NOT NULL,
      assigned_at TEXT DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','in_progress','done','dropped'))
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_bga_goal ON builder_goal_assignments(goal_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_bga_builder ON builder_goal_assignments(builder_telegram_chat_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_bga_status ON builder_goal_assignments(status)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS builder_profiles (
      telegram_chat_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      skills_json TEXT DEFAULT '[]',
      active_goal_ids_json TEXT DEFAULT '[]',
      joined_at TEXT DEFAULT (datetime('now')),
      last_active_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

// ─── Projects ─────────────────────────────────────────────────────────────────

function addProject(name, descriptionMd = '') {
  const db = getDb();
  const id = uuidv4();
  db.run(
    `INSERT INTO builder_projects (id, name, description_md) VALUES (?, ?, ?)`,
    [id, name, descriptionMd]
  );
  save();
  return id;
}

function getProjects({ status = null } = {}) {
  const db = getDb();
  let q = 'SELECT * FROM builder_projects WHERE 1=1';
  const p = [];
  if (status) { q += ' AND status = ?'; p.push(status); }
  q += ' ORDER BY created_at DESC';

  const stmt = db.prepare(q);
  if (p.length) stmt.bind(p);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function updateProjectStatus(projectId, status) {
  const db = getDb();
  db.run(`UPDATE builder_projects SET status = ? WHERE id = ?`, [status, projectId]);
  save();
}

// ─── Goals ────────────────────────────────────────────────────────────────────

function _parseGoalRow(row) {
  if (!row) return null;
  try { row.steps_json = JSON.parse(row.steps_json || '[]'); } catch { row.steps_json = []; }
  try { row.dependencies_json = JSON.parse(row.dependencies_json || '[]'); } catch { row.dependencies_json = []; }
  return row;
}

function addGoal({
  title,
  objective,
  contextMd = '',
  acceptanceCriteriaMd = '',
  stepsJson = [],
  dependenciesJson = [],
  priority = 3,
  projectId = null,
  generatedByModel = null
}) {
  if (!title) throw new Error('addGoal: title required');
  if (!objective) throw new Error('addGoal: objective required');
  const db = getDb();
  const id = uuidv4();
  db.run(
    `INSERT INTO builder_goals
       (id, title, objective, context_md, acceptance_criteria_md,
        steps_json, dependencies_json, priority, project_id, generated_by_model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, title, objective, contextMd, acceptanceCriteriaMd,
      JSON.stringify(Array.isArray(stepsJson) ? stepsJson : []),
      JSON.stringify(Array.isArray(dependenciesJson) ? dependenciesJson : []),
      priority, projectId, generatedByModel
    ]
  );
  save();
  return id;
}

function getGoal(id) {
  const db = getDb();
  const stmt = db.prepare(`SELECT * FROM builder_goals WHERE id = ?`);
  stmt.bind([id]);
  let row = null;
  if (stmt.step()) row = _parseGoalRow(stmt.getAsObject());
  stmt.free();
  return row;
}

function getGoals({ status = null, projectId = null, limit = 100 } = {}) {
  const db = getDb();
  let q = 'SELECT * FROM builder_goals WHERE 1=1';
  const p = [];
  if (status) { q += ' AND status = ?'; p.push(status); }
  if (projectId) { q += ' AND project_id = ?'; p.push(projectId); }
  q += ' ORDER BY priority ASC, generated_at ASC LIMIT ?';
  p.push(limit);

  const stmt = db.prepare(q);
  stmt.bind(p);
  const rows = [];
  while (stmt.step()) rows.push(_parseGoalRow(stmt.getAsObject()));
  stmt.free();
  return rows;
}

function updateGoalStatus(goalId, status) {
  const db = getDb();
  db.run(`UPDATE builder_goals SET status = ? WHERE id = ?`, [status, goalId]);
  save();
}

// ─── Assignments ──────────────────────────────────────────────────────────────

function _parseAssignmentRow(row) {
  if (!row) return null;
  return row;
}

function assignGoal(goalId, builderChatId, builderName) {
  const db = getDb();
  const id = uuidv4();
  db.run(
    `INSERT INTO builder_goal_assignments
       (id, goal_id, builder_telegram_chat_id, builder_name)
     VALUES (?, ?, ?, ?)`,
    [id, goalId, builderChatId, builderName]
  );
  // Advance goal to assigned
  db.run(`UPDATE builder_goals SET status = 'assigned' WHERE id = ?`, [goalId]);
  save();
  return id;
}

function getAssignmentsForGoal(goalId) {
  const db = getDb();
  const stmt = db.prepare(
    `SELECT bga.*, bg.title as goal_title, bg.objective as goal_objective
     FROM builder_goal_assignments bga
     JOIN builder_goals bg ON bga.goal_id = bg.id
     WHERE bga.goal_id = ?
     ORDER BY bga.assigned_at DESC`
  );
  stmt.bind([goalId]);
  const rows = [];
  while (stmt.step()) rows.push(_parseAssignmentRow(stmt.getAsObject()));
  stmt.free();
  return rows;
}

function getActiveAssignmentsForBuilder(builderChatId) {
  const db = getDb();
  const stmt = db.prepare(
    `SELECT bga.*, bg.title as goal_title, bg.objective as goal_objective,
            bg.priority as goal_priority, bg.project_id as goal_project_id
     FROM builder_goal_assignments bga
     JOIN builder_goals bg ON bga.goal_id = bg.id
     WHERE bga.builder_telegram_chat_id = ?
       AND bga.status IN ('assigned','in_progress')
     ORDER BY bg.priority ASC, bga.assigned_at ASC`
  );
  stmt.bind([builderChatId]);
  const rows = [];
  while (stmt.step()) rows.push(_parseAssignmentRow(stmt.getAsObject()));
  stmt.free();
  return rows;
}

function getAssignment(assignmentId) {
  const db = getDb();
  const stmt = db.prepare(
    `SELECT bga.*, bg.title as goal_title
     FROM builder_goal_assignments bga
     JOIN builder_goals bg ON bga.goal_id = bg.id
     WHERE bga.id = ?`
  );
  stmt.bind([assignmentId]);
  let row = null;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return row;
}

function markAssignmentStarted(assignmentId) {
  const db = getDb();
  const assignment = getAssignment(assignmentId);
  if (!assignment) throw new Error(`Assignment ${assignmentId} not found`);

  db.run(
    `UPDATE builder_goal_assignments
     SET status = 'in_progress', started_at = datetime('now')
     WHERE id = ?`,
    [assignmentId]
  );
  db.run(`UPDATE builder_goals SET status = 'in_progress' WHERE id = ?`, [assignment.goal_id]);
  save();
}

function markAssignmentComplete(assignmentId) {
  const db = getDb();
  const assignment = getAssignment(assignmentId);
  if (!assignment) throw new Error(`Assignment ${assignmentId} not found`);

  db.run(
    `UPDATE builder_goal_assignments
     SET status = 'done', completed_at = datetime('now')
     WHERE id = ?`,
    [assignmentId]
  );
  db.run(`UPDATE builder_goals SET status = 'done' WHERE id = ?`, [assignment.goal_id]);
  save();
  return assignment.goal_id;
}

function dropAssignment(assignmentId) {
  const db = getDb();
  const assignment = getAssignment(assignmentId);
  if (!assignment) throw new Error(`Assignment ${assignmentId} not found`);

  db.run(
    `UPDATE builder_goal_assignments SET status = 'dropped' WHERE id = ?`,
    [assignmentId]
  );

  // If no active assignments remain for this goal, reset to pending
  const countStmt = db.prepare(
    `SELECT COUNT(*) as n FROM builder_goal_assignments
     WHERE goal_id = ? AND status IN ('assigned','in_progress')`
  );
  countStmt.bind([assignment.goal_id]);
  countStmt.step();
  const remaining = countStmt.getAsObject().n;
  countStmt.free();

  if (remaining === 0) {
    db.run(`UPDATE builder_goals SET status = 'pending' WHERE id = ?`, [assignment.goal_id]);
  }
  save();
  return assignment.goal_id;
}

// ─── Builder Profiles ─────────────────────────────────────────────────────────

function upsertBuilderProfile(telegramChatId, name, skills = []) {
  const existing = getBuilderProfile(telegramChatId);
  const skillsJson = JSON.stringify(Array.isArray(skills) ? skills : []);

  const db = getDb();
  if (existing) {
    db.run(
      `UPDATE builder_profiles
       SET name = ?, skills_json = ?, last_active_at = datetime('now')
       WHERE telegram_chat_id = ?`,
      [name, skillsJson, telegramChatId]
    );
  } else {
    db.run(
      `INSERT INTO builder_profiles (telegram_chat_id, name, skills_json) VALUES (?, ?, ?)`,
      [telegramChatId, name, skillsJson]
    );
  }
  save();
  return getBuilderProfile(telegramChatId);
}

function getBuilderProfile(telegramChatId) {
  const db = getDb();
  const stmt = db.prepare(`SELECT * FROM builder_profiles WHERE telegram_chat_id = ?`);
  stmt.bind([telegramChatId]);
  let row = null;
  if (stmt.step()) {
    row = stmt.getAsObject();
    try { row.skills_json = JSON.parse(row.skills_json || '[]'); } catch { row.skills_json = []; }
    try { row.active_goal_ids_json = JSON.parse(row.active_goal_ids_json || '[]'); } catch { row.active_goal_ids_json = []; }
  }
  stmt.free();
  return row;
}

function getAllBuilderProfiles() {
  const db = getDb();
  const stmt = db.prepare(`SELECT * FROM builder_profiles ORDER BY last_active_at DESC`);
  const rows = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    try { row.skills_json = JSON.parse(row.skills_json || '[]'); } catch { row.skills_json = []; }
    try { row.active_goal_ids_json = JSON.parse(row.active_goal_ids_json || '[]'); } catch { row.active_goal_ids_json = []; }
    rows.push(row);
  }
  stmt.free();
  return rows;
}

function touchBuilderProfile(telegramChatId) {
  const db = getDb();
  db.run(
    `UPDATE builder_profiles SET last_active_at = datetime('now') WHERE telegram_chat_id = ?`,
    [telegramChatId]
  );
  save();
}

function getBuilderStats(telegramChatId) {
  const db = getDb();
  const stmt = db.prepare(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as completed,
       SUM(CASE WHEN status IN ('assigned','in_progress') THEN 1 ELSE 0 END) as inProgress
     FROM builder_goal_assignments
     WHERE builder_telegram_chat_id = ?`
  );
  stmt.bind([telegramChatId]);
  stmt.step();
  const row = stmt.getAsObject();
  stmt.free();
  return {
    total: row.total || 0,
    completed: row.completed || 0,
    inProgress: row.inProgress || 0
  };
}

module.exports = {
  initBuilderTables,
  // Projects
  addProject, getProjects, updateProjectStatus,
  // Goals
  addGoal, getGoal, getGoals, updateGoalStatus,
  // Assignments
  assignGoal, getAssignmentsForGoal, getActiveAssignmentsForBuilder,
  getAssignment, markAssignmentStarted, markAssignmentComplete, dropAssignment,
  // Profiles
  upsertBuilderProfile, getBuilderProfile, getAllBuilderProfiles,
  touchBuilderProfile, getBuilderStats
};
