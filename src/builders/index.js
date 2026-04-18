/**
 * MOTHERSHIP Builder System — Entry Point
 *
 * Call init() from server.js boot(). Initializes tables and starts
 * the 24-hour goal generation schedule.
 */

const builderDb = require('./database');
const goalGenerator = require('./goal-generator');
const coordinator = require('./coordinator');

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

async function init() {
  // Tables are created by database.js:init() via the initBuilderTables()
  // call added there. We call it again here so init() is safe to call
  // standalone (it's idempotent via CREATE TABLE IF NOT EXISTS).
  builderDb.initBuilderTables();

  // Run daily goal generation immediately on boot, then every 24h.
  // Errors are logged and swallowed so a missing API key doesn't block boot.
  try {
    await goalGenerator.generateDailyGoals();
  } catch (err) {
    console.error('  ⚠ builder system: startup goal generation failed:', err.message);
  }

  setInterval(async () => {
    try {
      await goalGenerator.generateDailyGoals();
      // After generating, try to fill builder queues
      await coordinator.assignPendingGoals();
    } catch (err) {
      console.error('  ⚠ builder system: scheduled goal generation failed:', err.message);
    }
  }, TWENTY_FOUR_HOURS_MS);
}

// Re-export initBuilderTables for the integration point in src/database.js
function initBuilderTables() {
  builderDb.initBuilderTables();
}

module.exports = { init, initBuilderTables, coordinator, goalGenerator, builderDb };
