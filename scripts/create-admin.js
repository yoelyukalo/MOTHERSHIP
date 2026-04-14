#!/usr/bin/env node
/**
 * MOTHERSHIP — Bootstrap CLI: create the first mothership_admin
 *
 * Usage:
 *   node scripts/create-admin.js --email=yoel@example.com --password='secret' --display-name='Yoel'
 *   node scripts/create-admin.js --email=new@x --password='p' --force
 */

const { v4: uuidv4 } = require('uuid');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const key = m[1];
    if (m[2] !== undefined) {
      out[key] = m[2];
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      out[key] = argv[++i];
    } else {
      out[key] = true;
    }
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
  const countStmt = raw.prepare('SELECT COUNT(*) AS c FROM users');
  countStmt.step();
  const userCount = countStmt.getAsObject().c;
  countStmt.free();

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

  function getRoleId(name) {
    const stmt = raw.prepare('SELECT id FROM roles WHERE name = ?');
    stmt.bind([name]);
    stmt.step();
    const id = stmt.getAsObject().id;
    stmt.free();
    return id;
  }
  const adminRoleId = getRoleId('mothership_admin');
  const viewerRoleId = getRoleId('viewer');

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
