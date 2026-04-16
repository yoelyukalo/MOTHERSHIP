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
const systemOwner = require('../../src/auth/system-owner');
const { v4: uuidv4 } = require('uuid');

let adminId;
before(async () => {
  await db.init();
  await authRoles.seedOnce(db);

  const raw = db._raw();
  raw.run(`INSERT INTO messages (id, content, source) VALUES (?, ?, ?)`, [uuidv4(), 'old msg 1', 'telegram']);
  raw.run(`INSERT INTO messages (id, content, source) VALUES (?, ?, ?)`, [uuidv4(), 'old msg 2', 'file']);
  raw.run(`INSERT INTO mirror_entries (id, entry_type, layer, category, content, confidence, source_type) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [uuidv4(), 'signal', 'pattern', 'signal', 'likes terse', 0.8, 'conversation']);
  raw.run(`INSERT INTO wiki_entries (id, topic, summary) VALUES (?, ?, ?)`,
    [uuidv4(), 'quantum-mirror', 'A cognitive profile']);
  db.save();

  adminId = await users.createUser({ email: 'admin@x', password: 'p' });
  const stmt = raw.prepare("SELECT id FROM roles WHERE name = 'mothership_admin'");
  stmt.step();
  const adminRoleId = stmt.getAsObject().id;
  stmt.free();
  raw.run(
    `INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id)
     VALUES (?, 'user', ?, ?, NULL)`,
    [uuidv4(), adminId, adminRoleId]
  );
  db.save();
  systemOwner.clearCache();
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
