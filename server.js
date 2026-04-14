/**
 * MOTHERSHIP — Phase 1: Foundation Server
 *
 * The pipe that makes everything else possible.
 * Local Node.js server with SQLite, Telegram webhook, and file watcher.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const db = require('./src/database');
const telegram = require('./src/telegram');
const watcher = require('./src/watcher');
const apiRoutes = require('./src/routes/api');
const authRoutes = require('./src/routes/auth');
const userMgmtRoutes = require('./src/routes/users');
const migrate = require('./src/migrate-legacy-mirror');
const healthcheck = require('./src/health-check');
const satellites = require('./src/satellites');
const auth = require('./src/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api', userMgmtRoutes);
app.use('/api', apiRoutes);

// Dashboard — serve the UI
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Ensure inbox folder exists
const inboxPath = path.resolve(process.env.DROP_FOLDER || './inbox');
if (!fs.existsSync(inboxPath)) {
  fs.mkdirSync(inboxPath, { recursive: true });
}

// Boot sequence
async function boot() {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║         M O T H E R S H I P          ║');
  console.log('  ║        Phase 1 — Foundation           ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');

  // 1. Initialize database
  await db.init();
  console.log('  ✔ Database initialized');

  // 1a. Initialize auth (Phase 6 #2) — must run before migrate-legacy-mirror
  //     so the system owner is available for legacy data ownership assignment.
  try {
    await auth.init();
    console.log('  ✔ Auth initialized');
  } catch (err) {
    console.log(`  ⚠ Auth init error: ${err.message}`);
  }

  // 1b. Migrate legacy mirror entries (no-op if already done). Requires a
  //     system owner; if no admin exists yet (pre-bootstrap) this is skipped.
  const systemOwnerId = auth.getSystemOwnerId();
  if (systemOwnerId) {
    const migratedCount = await migrate.runIfNeeded({ userId: systemOwnerId });
    if (migratedCount > 0) console.log(`  ✔ Migrated ${migratedCount} legacy mirror entries`);
  } else {
    console.log('  ⚠ Legacy mirror migration skipped — no admin user yet (run scripts/create-admin.js first)');
  }

  // 1c. Initialize satellites (Phase 6 #1)
  try {
    await satellites.init();
    console.log('  ✔ Satellites loaded');
  } catch (err) {
    console.log(`  ⚠ Satellite init error: ${err.message}`);
  }

  // 2. Start Telegram bot (if configured)
  const telegramOk = telegram.init();
  if (telegramOk) {
    console.log('  ✔ Telegram bot connected');
  } else {
    console.log('  ⚠ Telegram not configured (add token to .env)');
  }

  // 3. Start file watcher
  watcher.init(inboxPath);
  console.log(`  ✔ Watching inbox: ${inboxPath}`);

  // 4. Schedule weekly health check
  healthcheck.start();
  console.log('  ✔ Health check scheduled');

  // 5. Start server
  app.listen(PORT, () => {
    console.log(`  ✔ Dashboard live at http://localhost:${PORT}`);
    console.log('');
    console.log('  Ready. The Mothership is online.');
    console.log('');
  });
}

boot().catch(err => {
  console.error('Boot failed:', err);
  process.exit(1);
});
