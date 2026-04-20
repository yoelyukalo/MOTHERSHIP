/**
 * MOTHERSHIP Builder System — Telegram Commands
 *
 * Registers all /builder_* commands and callback handlers.
 * Call registerBuilderCommands(bot) inside telegram.js init().
 * Call interceptMessage(bot, msg) at the top of bot.on('message') to handle
 * pending state (e.g. project description follow-up).
 */

const builderDb = require('./database');
const coordinator = require('./coordinator');
const goalGenerator = require('./goal-generator');

// In-memory state for multi-step flows. key: chatId → { step, data }
const pendingProjectCreations = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeSend(bot, chatId, text, opts = {}) {
  return bot.sendMessage(chatId, text, opts).catch(err => {
    console.error(`  ⚠ builder telegram-commands: sendMessage failed (chat ${chatId}): ${err.message}`);
  });
}

function escapeMarkdown(text) {
  // Escape Telegram Markdown V1 special chars in dynamic content
  return (text || '').replace(/([*_`\[])/g, '\\$1');
}

function priorityLabel(p) {
  const stars = '★'.repeat(p) + '☆'.repeat(5 - p);
  return `${stars} P${p}`;
}

// ─── Intercept hook ───────────────────────────────────────────────────────────

/**
 * Called at the top of bot.on('message') to intercept pending flow messages.
 * Returns true if the message was consumed (caller should return immediately).
 */
async function interceptMessage(bot, msg) {
  const chatId = msg.chat.id;

  if (!msg.text) return false;

  // Slash command clears any pending state without consuming the message
  if (msg.text.startsWith('/')) {
    pendingProjectCreations.delete(chatId);
    return false;
  }

  const pending = pendingProjectCreations.get(chatId);
  if (!pending) return false;

  pendingProjectCreations.delete(chatId);

  const descriptionMd = msg.text.trim();
  try {
    const projectId = builderDb.addProject(pending.name, descriptionMd);
    await safeSend(bot, chatId,
      `✅ Project created!\n\nName: ${pending.name}\nID: ${projectId}\n\nGenerate goals with /builder_generate ${projectId}`,
      { reply_to_message_id: msg.message_id }
    );
  } catch (err) {
    await safeSend(bot, chatId, `⚠ Failed to create project: ${err.message}`);
  }

  return true;
}

// ─── Command registration ─────────────────────────────────────────────────────

function registerBuilderCommands(bot) {
  // Give the coordinator a bot reference so it can send notifications
  coordinator.setBot(bot);

  // /builder_join [name]
  bot.onText(/^\/builder_join(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const rawName = (match[1] || '').trim() || msg.from?.first_name || 'Builder';
    const name = rawName.slice(0, 80);

    try {
      builderDb.upsertBuilderProfile(String(chatId), name, []);
      const stats = builderDb.getBuilderStats(String(chatId));
      await safeSend(bot, chatId,
        `✅ Registered as builder: *${escapeMarkdown(name)}*\n` +
        `Goals completed: ${stats.completed} · Active: ${stats.inProgress}\n\n` +
        `Commands:\n` +
        `/builder_status — your active goals\n` +
        `/builder_goals — all open goals\n` +
        `/builder_report — full system report`,
        { parse_mode: 'Markdown', reply_to_message_id: msg.message_id }
      );
    } catch (err) {
      await safeSend(bot, chatId, `⚠ Join failed: ${err.message}`);
    }
  });

  // /builder_status
  bot.onText(/^\/builder_status$/, async (msg) => {
    const chatId = msg.chat.id;
    const chatIdStr = String(chatId);

    try {
      const profile = builderDb.getBuilderProfile(chatIdStr);
      if (!profile) {
        await safeSend(bot, chatId, '⚠ Not registered. Use /builder_join first.');
        return;
      }

      builderDb.touchBuilderProfile(chatIdStr);
      const active = builderDb.getActiveAssignmentsForBuilder(chatIdStr);
      const stats = builderDb.getBuilderStats(chatIdStr);

      if (!active.length) {
        await safeSend(bot, chatId,
          `👋 *${escapeMarkdown(profile.name)}* — no active goals right now.\n` +
          `Total completed: ${stats.completed}\n\n` +
          `Check /builder\\_goals for open work.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      await safeSend(bot, chatId,
        `👤 *${escapeMarkdown(profile.name)}* — ${active.length} active goal(s)\nCompleted: ${stats.completed}`,
        { parse_mode: 'Markdown' }
      );

      for (const assignment of active) {
        const goal = builderDb.getGoal(assignment.goal_id);
        if (!goal) continue;

        const shortId = goal.id.slice(0, 8);
        const statusEmoji = assignment.status === 'in_progress' ? '🔄' : '⏳';
        const text = `${statusEmoji} *${escapeMarkdown(goal.title)}*\n` +
          `ID: \`${goal.id}\`\nPriority: ${priorityLabel(goal.priority)}\nStatus: ${assignment.status}`;

        const keyboard = assignment.status === 'in_progress'
          ? [[
              { text: '✅ Done', callback_data: `builder:done:${assignment.id}` },
              { text: '📋 Spec', callback_data: `builder:spec:${goal.id}` }
            ]]
          : [[
              { text: '▶️ Start', callback_data: `builder:start:${assignment.id}` },
              { text: '📋 Spec', callback_data: `builder:spec:${goal.id}` },
              { text: '⏭ Skip', callback_data: `builder:skip:${assignment.id}` }
            ]];

        await safeSend(bot, chatId, text, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: keyboard }
        });
      }
    } catch (err) {
      await safeSend(bot, chatId, `⚠ Status failed: ${err.message}`);
    }
  });

  // /builder_goals
  bot.onText(/^\/builder_goals$/, async (msg) => {
    const chatId = msg.chat.id;

    try {
      const pending = builderDb.getGoals({ status: 'pending', limit: 20 });
      const inProgress = builderDb.getGoals({ status: 'in_progress', limit: 10 });
      const assigned = builderDb.getGoals({ status: 'assigned', limit: 10 });
      const allActive = [...pending, ...assigned, ...inProgress];

      if (!allActive.length) {
        await safeSend(bot, chatId, '📭 No open goals right now. Use /builder_generate [project_id] to create some.');
        return;
      }

      await safeSend(bot, chatId,
        `📋 *Open Goals* (${pending.length} pending · ${assigned.length} assigned · ${inProgress.length} in-progress)`,
        { parse_mode: 'Markdown' }
      );

      for (const goal of allActive) {
        const shortId = goal.id.slice(0, 8);
        const statusEmoji = { pending: '⏳', assigned: '📌', in_progress: '🔄' }[goal.status] || '•';
        const text = `${statusEmoji} *${escapeMarkdown(goal.title)}*\n` +
          `ID: \`${goal.id}\`\n` +
          `Priority: ${priorityLabel(goal.priority)} · Status: ${goal.status}`;

        await safeSend(bot, chatId, text, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '📋 Full Spec', callback_data: `builder:spec:${goal.id}` }
            ]]
          }
        });
      }
    } catch (err) {
      await safeSend(bot, chatId, `⚠ Goals list failed: ${err.message}`);
    }
  });

  // /builder_done [goal_id]
  bot.onText(/^\/builder_done(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const chatIdStr = String(chatId);
    const goalIdArg = (match[1] || '').trim();

    try {
      if (!goalIdArg) {
        await safeSend(bot, chatId, '⚠ Usage: /builder_done [goal_id]');
        return;
      }

      const active = builderDb.getActiveAssignmentsForBuilder(chatIdStr);
      const assignment = active.find(a =>
        a.goal_id === goalIdArg || a.goal_id.startsWith(goalIdArg)
      );

      if (!assignment) {
        await safeSend(bot, chatId,
          `⚠ No active assignment found for goal \`${goalIdArg}\`.\n` +
          `Check your active goals with /builder_status.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      builderDb.markAssignmentComplete(assignment.id);
      builderDb.touchBuilderProfile(chatIdStr);

      const stats = builderDb.getBuilderStats(chatIdStr);
      await safeSend(bot, chatId,
        `✅ Goal marked done: *${escapeMarkdown(assignment.goal_title)}*\n` +
        `Total completed: ${stats.completed} 🎉`,
        { parse_mode: 'Markdown', reply_to_message_id: msg.message_id }
      );

      // Assign next pending goal to this builder
      await coordinator.assignPendingGoals();
    } catch (err) {
      await safeSend(bot, chatId, `⚠ Done failed: ${err.message}`);
    }
  });

  // /builder_report
  bot.onText(/^\/builder_report$/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const report = coordinator.getStatusReport();
      const CHUNK = 3900;
      for (let i = 0; i < report.length; i += CHUNK) {
        await safeSend(bot, chatId, report.slice(i, i + CHUNK), { parse_mode: 'Markdown' });
      }
    } catch (err) {
      await safeSend(bot, chatId, `⚠ Report failed: ${err.message}`);
    }
  });

  // /builder_new_project [name]
  bot.onText(/^\/builder_new_project(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const name = (match[1] || '').trim();

    if (!name) {
      await safeSend(bot, chatId, '⚠ Usage: /builder_new_project [project name]');
      return;
    }

    pendingProjectCreations.set(chatId, { name });
    await safeSend(bot, chatId,
      `📁 Creating project: *${escapeMarkdown(name)}*\n\nSend a description for this project in your next message.\n(Or send any command to cancel.)`,
      { parse_mode: 'Markdown', reply_to_message_id: msg.message_id }
    );
  });

  // /builder_generate [project_id]
  bot.onText(/^\/builder_generate(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const projectId = (match[1] || '').trim();

    if (!projectId) {
      const projects = builderDb.getProjects({ status: 'active' });
      if (!projects.length) {
        await safeSend(bot, chatId, '⚠ No active projects. Create one with /builder_new_project [name].');
        return;
      }
      const list = projects.map(p => `  • ${p.name}\n    ID: \`${p.id}\``).join('\n\n');
      await safeSend(bot, chatId,
        `📁 *Active Projects:*\n\n${list}\n\nUsage: /builder\\_generate [project\\_id]`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const sent = await safeSend(bot, chatId, '⏳ Generating goals via Claude…');

    try {
      const goals = await goalGenerator.generateGoalsForProject(projectId, { count: 3 });

      if (!goals.length) {
        await bot.editMessageText('⚠ No goals were generated. Check project description and API key.',
          { chat_id: chatId, message_id: sent?.message_id }).catch(() => {});
        return;
      }

      await bot.editMessageText(
        `✅ Generated ${goals.length} new goal(s)! Use /builder\\_goals to see them all.`,
        { chat_id: chatId, message_id: sent?.message_id, parse_mode: 'Markdown' }
      ).catch(() => {});

      // Auto-assign after generating
      await coordinator.assignPendingGoals();
    } catch (err) {
      await bot.editMessageText(`⚠ Generation failed: ${err.message}`,
        { chat_id: chatId, message_id: sent?.message_id }).catch(() => {});
    }
  });
}

// ─── Callback handler ─────────────────────────────────────────────────────────

async function handleBuilderCallback(bot, query) {
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const chatIdStr = String(chatId);
  const data = query.data || '';

  // data format: builder:<action>:<id>
  const parts = data.split(':');
  const action = parts[1];
  const id = parts.slice(2).join(':');

  const ack = (text) => bot.answerCallbackQuery(query.id, { text }).catch(() => {});
  const edit = (text) => bot.editMessageText(text, { chat_id: chatId, message_id: msgId }).catch(() => {});

  try {
    switch (action) {
      case 'start': {
        const assignment = builderDb.getAssignment(id);
        if (!assignment) { await ack('Assignment not found'); return; }
        builderDb.markAssignmentStarted(id);
        builderDb.touchBuilderProfile(chatIdStr);
        await ack('Started!');
        await edit(
          `▶️ Started: ${assignment.goal_title}\n\nSend /builder_done ${assignment.goal_id} when complete.`
        );
        break;
      }

      case 'done': {
        const assignment = builderDb.getAssignment(id);
        if (!assignment) { await ack('Assignment not found'); return; }
        const goalId = builderDb.markAssignmentComplete(id);
        builderDb.touchBuilderProfile(chatIdStr);
        const stats = builderDb.getBuilderStats(chatIdStr);
        await ack('Marked done!');
        await edit(`✅ Done: ${assignment.goal_title}\nTotal completed: ${stats.completed} 🎉`);
        // Assign next goal
        await coordinator.assignPendingGoals();
        break;
      }

      case 'skip': {
        const assignment = builderDb.getAssignment(id);
        if (!assignment) { await ack('Assignment not found'); return; }
        builderDb.dropAssignment(id);
        await ack('Skipped');
        await edit(`⏭ Skipped: ${assignment.goal_title}\n(Goal returned to pending pool)`);
        // Try to assign a different goal to this builder
        await coordinator.assignPendingGoals();
        break;
      }

      case 'spec': {
        // id is a goal id here
        const goal = builderDb.getGoal(id);
        if (!goal) { await ack('Goal not found'); return; }
        await ack('Sending spec…');
        const spec = coordinator.formatGoalSpec(goal);
        const CHUNK = 3900;
        for (let i = 0; i < spec.length; i += CHUNK) {
          await bot.sendMessage(chatId, spec.slice(i, i + CHUNK)).catch(() => {});
        }
        break;
      }

      default:
        await ack('Unknown action');
    }
  } catch (err) {
    console.error(`  ⚠ builder callback (${action}): ${err.message}`);
    await ack(`Error: ${err.message}`);
  }
}

module.exports = { registerBuilderCommands, handleBuilderCallback, interceptMessage };
