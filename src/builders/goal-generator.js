/**
 * MOTHERSHIP Builder System — Goal Generator
 *
 * Uses Claude to produce extremely detailed goal specs for builder projects.
 * Matches the Anthropic SDK call pattern from src/conversation.js exactly.
 */

const Anthropic = require('@anthropic-ai/sdk');
const builderDb = require('./database');
const { parseLlmJson } = require('../util/parse-llm-json');

const MODEL = process.env.BUILDER_GOAL_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;

let client = null;
function getClient() {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  client = new Anthropic({ apiKey, maxRetries: 3, timeout: 120_000 });
  return client;
}

const SYSTEM_PROMPT = `You are the MOTHERSHIP goal architect. Your role is to generate extremely detailed, immediately actionable goal specs for human builders working on the MOTHERSHIP AI operating system project.

MOTHERSHIP is a personal AI operating system built in Node.js + SQLite (sql.js/WASM, no native deps). Architecture:
- server.js — Express server on port 3000, boot sequence
- src/database.js — SQLite init and queries via sql.js _raw()
- src/telegram.js — Telegram bot integration (polling mode)
- src/conversation.js — Claude API adapter, message history, respond()
- src/mirror.js — Quantum Mirror cognitive profile of the user
- src/routes/api.js — REST API endpoints
- src/builders/ — Builder system (the system you are part of)
- public/index.html — Dashboard UI (vanilla JS)

Goal sizing: each goal should scope to 2–8 hours of focused work for a single developer.

Goals must be:
1. Concrete and immediately actionable — no ambiguity, no "figure it out"
2. Specific to MOTHERSHIP's codebase, patterns, and constraints
3. Verified through clear, testable acceptance criteria
4. Self-contained or explicitly listing dependencies on other goals

OUTPUT FORMAT: Return ONLY a valid JSON array. No prose before or after. No markdown code fence.

Each element MUST have these exact keys (no extras, no omissions):
{
  "title": "string — action verb + clear outcome, max 80 chars",
  "objective": "string — 1–2 sentences precisely describing what done looks like",
  "context_md": "string — markdown: why this matters, which files to touch, relevant patterns from the codebase",
  "acceptance_criteria_md": "string — markdown bullet list with minimum 3 testable criteria, each starting with '- [ ]'",
  "steps": [{"title": "string", "detail": "string"}, ...],
  "dependencies": ["exact title of prerequisite goal", ...]
}`;

/**
 * Generate `count` goals for a project. Reads existing goals to avoid duplicates.
 * Saves each goal to DB and returns the saved goal objects.
 */
async function generateGoalsForProject(projectId, { count = 3 } = {}) {
  const projects = builderDb.getProjects({});
  const project = projects.find(p => p.id === projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);

  const existingGoals = builderDb.getGoals({ projectId, limit: 200 });
  const existingTitles = existingGoals.map(g => `- ${g.title}`).join('\n') || '(none yet)';

  const userPrompt = [
    `Project: ${project.name}`,
    `Description:\n${project.description_md || '(no description provided)'}`,
    '',
    `Existing goals (do not duplicate any of these):\n${existingTitles}`,
    '',
    `Generate exactly ${count} new goal${count !== 1 ? 's' : ''} for this project.`,
    `Make sure each goal is specific, actionable, and scoped for 2–8 hours of work.`
  ].join('\n');

  const c = getClient();
  const response = await c.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }]
  });

  const text = response.content.find(b => b.type === 'text')?.text?.trim() || '';
  if (!text) throw new Error('generateGoalsForProject: empty response from Claude');

  const parsed = parseLlmJson(text);
  if (!Array.isArray(parsed)) {
    throw new Error(`generateGoalsForProject: expected JSON array, got ${typeof parsed}`);
  }

  const savedGoals = [];
  for (const raw of parsed) {
    if (!raw.title || !raw.objective) {
      console.warn('  ⚠ builder goal-generator: skipping goal with missing title or objective:', JSON.stringify(raw).slice(0, 100));
      continue;
    }

    const goalId = builderDb.addGoal({
      title: String(raw.title).slice(0, 200),
      objective: String(raw.objective),
      contextMd: String(raw.context_md || ''),
      acceptanceCriteriaMd: String(raw.acceptance_criteria_md || ''),
      stepsJson: Array.isArray(raw.steps) ? raw.steps : [],
      dependenciesJson: Array.isArray(raw.dependencies) ? raw.dependencies : [],
      priority: 3,
      projectId,
      generatedByModel: MODEL
    });

    savedGoals.push(builderDb.getGoal(goalId));
  }

  console.log(`  ✔ builder goal-generator: generated ${savedGoals.length} goals for project "${project.name}"`);
  return savedGoals;
}

/**
 * Run for all active projects. Generates goals until each project has at least
 * PENDING_THRESHOLD pending goals. Exported for use in index.js scheduler.
 */
async function generateDailyGoals() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('  ⚠ builder goal-generator: ANTHROPIC_API_KEY not set — skipping daily goal generation');
    return;
  }

  const PENDING_THRESHOLD = 5;
  const projects = builderDb.getProjects({ status: 'active' });

  if (!projects.length) {
    console.log('  ℹ builder goal-generator: no active projects — nothing to generate');
    return;
  }

  for (const project of projects) {
    try {
      const pending = builderDb.getGoals({ status: 'pending', projectId: project.id, limit: PENDING_THRESHOLD + 1 });
      const deficit = PENDING_THRESHOLD - pending.length;
      if (deficit <= 0) {
        console.log(`  ✔ builder goal-generator: project "${project.name}" already has ${pending.length} pending goals`);
        continue;
      }
      console.log(`  📋 builder goal-generator: generating ${deficit} goal(s) for project "${project.name}"`);
      await generateGoalsForProject(project.id, { count: deficit });
    } catch (err) {
      console.error(`  ⚠ builder goal-generator: failed for project "${project.name}": ${err.message}`);
    }
  }
}

module.exports = { generateGoalsForProject, generateDailyGoals };
