/**
 * MOTHERSHIP Builder System — Coordinator
 *
 * The assignment and communication brain. Assigns goals to builders,
 * sends Telegram notifications, detects blockers, and generates status reports.
 */

const builderDb = require('./database');

// Bot reference injected by telegram-commands.js after init
let _bot = null;

function setBot(bot) {
  _bot = bot;
}

// ─── Telegram helpers ─────────────────────────────────────────────────────────

async function notifyBuilder(telegramChatId, message, opts = {}) {
  if (!_bot) {
    console.warn(`  ⚠ builder coordinator: bot not set, cannot notify builder ${telegramChatId}`);
    return;
  }
  try {
    await _bot.sendMessage(telegramChatId, message, opts);
  } catch (err) {
    console.error(`  ⚠ builder coordinator: notifyBuilder failed (chat ${telegramChatId}): ${err.message}`);
  }
}

async function broadcastToAllBuilders(message) {
  const profiles = builderDb.getAllBuilderProfiles();
  for (const profile of profiles) {
    await notifyBuilder(profile.telegram_chat_id, message);
  }
}

// ─── Goal spec formatting ─────────────────────────────────────────────────────

function formatGoalSpec(goal) {
  const shortId = goal.id ? goal.id.slice(0, 8) : '????????';
  const priorityStars = '★'.repeat(goal.priority || 3) + '☆'.repeat(Math.max(0, 5 - (goal.priority || 3)));

  const steps = Array.isArray(goal.steps_json) ? goal.steps_json : [];
  const stepsText = steps.length
    ? steps.map((s, i) => `${i + 1}. ${s.title}\n   ${s.detail || ''}`).join('\n')
    : '(no steps defined)';

  const deps = Array.isArray(goal.dependencies_json) ? goal.dependencies_json : [];
  const depsText = deps.length ? deps.map(d => `• ${d}`).join('\n') : 'None';

  return [
    `📋 GOAL #${shortId}: ${goal.title}`,
    '',
    `Priority: ${priorityStars} (P${goal.priority || 3})`,
    `Status: ${goal.status || 'pending'}`,
    '',
    'OBJECTIVE:',
    goal.objective || '(none)',
    '',
    'CONTEXT:',
    goal.context_md || '(none)',
    '',
    'ACCEPTANCE CRITERIA:',
    goal.acceptance_criteria_md || '(none)',
    '',
    'STEPS:',
    stepsText,
    '',
    'DEPENDENCIES:',
    depsText
  ].join('\n');
}

// ─── Assignment engine ────────────────────────────────────────────────────────

/**
 * Find all pending goals whose dependencies are satisfied, then assign each
 * to the builder with the fewest active goals. Sends a Telegram notification
 * to each assigned builder.
 */
async function assignPendingGoals() {
  const pendingGoals = builderDb.getGoals({ status: 'pending', limit: 50 });
  if (!pendingGoals.length) return;

  const builders = builderDb.getAllBuilderProfiles();
  if (!builders.length) {
    console.log('  ℹ builder coordinator: no builders registered — skipping assignment');
    return;
  }

  // Build a title→goal map for dependency resolution
  const allGoals = builderDb.getGoals({ limit: 5000 });
  const goalsByTitle = new Map(allGoals.map(g => [g.title, g]));

  for (const goal of pendingGoals) {
    const deps = Array.isArray(goal.dependencies_json) ? goal.dependencies_json : [];
    const blocked = deps.some(depTitle => {
      const depGoal = goalsByTitle.get(depTitle);
      return !depGoal || depGoal.status !== 'done';
    });
    if (blocked) continue;

    // Pick builder with fewest active goals
    const ranked = builders
      .map(b => ({ builder: b, active: builderDb.getBuilderStats(b.telegram_chat_id).inProgress }))
      .sort((a, b) => a.active - b.active);

    const { builder } = ranked[0];
    const assignmentId = builderDb.assignGoal(goal.id, builder.telegram_chat_id, builder.name);

    const spec = formatGoalSpec(builderDb.getGoal(goal.id));
    const intro = `🎯 New goal assigned to you!\n\n${spec}\n\n━━━━━━━━━━━━━━━━━━━━`;

    await notifyBuilder(builder.telegram_chat_id, intro, {
      reply_markup: {
        inline_keyboard: [[
          { text: '▶️ Start', callback_data: `builder:start:${assignmentId}` },
          { text: '📋 Spec', callback_data: `builder:spec:${goal.id}` },
          { text: '⏭ Skip', callback_data: `builder:skip:${assignmentId}` }
        ]]
      }
    });

    console.log(`  ✔ builder coordinator: assigned goal "${goal.title}" → ${builder.name}`);
  }
}

// ─── Blocker detection ────────────────────────────────────────────────────────

async function checkForBlockers() {
  const activeStatuses = ['assigned', 'in_progress'];
  const activeGoals = [
    ...builderDb.getGoals({ status: 'assigned', limit: 200 }),
    ...builderDb.getGoals({ status: 'in_progress', limit: 200 })
  ];

  if (!activeGoals.length) return;

  const allGoals = builderDb.getGoals({ limit: 5000 });
  const goalsByTitle = new Map(allGoals.map(g => [g.title, g]));

  for (const goal of activeGoals) {
    const deps = Array.isArray(goal.dependencies_json) ? goal.dependencies_json : [];
    const blockers = deps.filter(depTitle => {
      const depGoal = goalsByTitle.get(depTitle);
      return !depGoal || depGoal.status !== 'done';
    });

    if (!blockers.length) continue;

    const assignments = builderDb.getAssignmentsForGoal(goal.id)
      .filter(a => activeStatuses.includes(a.status));

    for (const assignment of assignments) {
      const blockList = blockers.map(b => `• ${b}`).join('\n');
      await notifyBuilder(
        assignment.builder_telegram_chat_id,
        `⚠️ BLOCKER: Your goal "${goal.title}" is waiting on:\n${blockList}\n\nHold off until those are done.`
      );
    }
  }
}

// ─── Status report ────────────────────────────────────────────────────────────

function getStatusReport() {
  const projects = builderDb.getProjects({});
  const builders = builderDb.getAllBuilderProfiles();
  const allGoals = builderDb.getGoals({ limit: 10000 });

  const totals = { pending: 0, assigned: 0, in_progress: 0, done: 0, cancelled: 0 };
  allGoals.forEach(g => { if (totals[g.status] !== undefined) totals[g.status]++; });

  let report = '📊 *MOTHERSHIP Builder Status*\n\n';

  // Projects section
  report += '*Projects:*\n';
  if (!projects.length) {
    report += '  No projects yet. Use /builder\\_new\\_project to create one.\n';
  } else {
    for (const proj of projects) {
      const projGoals = allGoals.filter(g => g.project_id === proj.id);
      const pc = { pending: 0, in_progress: 0, done: 0 };
      projGoals.forEach(g => {
        if (g.status === 'pending') pc.pending++;
        else if (g.status === 'in_progress' || g.status === 'assigned') pc.in_progress++;
        else if (g.status === 'done') pc.done++;
      });
      report += `  • *${proj.name}* \\[${proj.status}\\]\n`;
      report += `    ${pc.pending} pending · ${pc.in_progress} active · ${pc.done} done\n`;
    }
  }

  // Goal totals
  report += '\n*Goal Totals:*\n';
  report += `  Pending: ${totals.pending}\n`;
  report += `  Assigned: ${totals.assigned}\n`;
  report += `  In Progress: ${totals.in_progress}\n`;
  report += `  Done: ${totals.done}\n`;
  report += `  Cancelled: ${totals.cancelled}\n`;

  // Builders section
  report += '\n*Builders:*\n';
  if (!builders.length) {
    report += '  No builders registered. Use /builder\\_join to register.\n';
  } else {
    for (const b of builders) {
      const active = builderDb.getActiveAssignmentsForBuilder(b.telegram_chat_id);
      const stats = builderDb.getBuilderStats(b.telegram_chat_id);
      if (active.length) {
        const goalList = active.map(a => a.goal_title || 'unknown').join(', ');
        report += `  • *${b.name}*: ${goalList} \\[${stats.completed} done total\\]\n`;
      } else {
        report += `  • *${b.name}*: idle \\[${stats.completed} done total\\]\n`;
      }
    }
  }

  return report;
}

module.exports = {
  setBot,
  notifyBuilder,
  broadcastToAllBuilders,
  formatGoalSpec,
  assignPendingGoals,
  checkForBlockers,
  getStatusReport
};
