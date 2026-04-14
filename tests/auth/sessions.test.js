const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-auth-sessions-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');

const db = require('../../src/database');
const users = require('../../src/auth/users');
const sessions = require('../../src/auth/sessions');

let userId;

before(async () => {
  await db.init();
  userId = await users.createUser({ email: 'u@x', password: 'p' });
});
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test('sessions — createSession returns a random id and stores row', () => {
  const s = sessions.createSession(userId, { ip: '127.0.0.1', userAgent: 'test' });
  assert.ok(s.id);
  assert.strictEqual(typeof s.id, 'string');
  assert.ok(s.id.length >= 40); // 32 bytes base64url = 43 chars
  const fetched = sessions.getSession(s.id);
  assert.strictEqual(fetched.user_id, userId);
});

test('sessions — getSession returns null for missing id', () => {
  assert.strictEqual(sessions.getSession('nope'), null);
});

test('sessions — getSession deletes and returns null for expired row', () => {
  const s = sessions.createSession(userId, { ip: '127.0.0.1', userAgent: 'test' });
  const raw = db._raw();
  raw.run(`UPDATE sessions SET expires_at = datetime('now', '-1 day') WHERE id = ?`, [s.id]);
  db.save();
  assert.strictEqual(sessions.getSession(s.id), null);
  const stmt = raw.prepare('SELECT * FROM sessions WHERE id = ?');
  stmt.bind([s.id]);
  assert.strictEqual(stmt.step(), false);
  stmt.free();
});

test('sessions — invalidateSession removes the row', () => {
  const s = sessions.createSession(userId, {});
  sessions.invalidateSession(s.id);
  assert.strictEqual(sessions.getSession(s.id), null);
});

test('sessions — invalidateAllSessionsForUser removes all', () => {
  sessions.createSession(userId, {});
  sessions.createSession(userId, {});
  sessions.createSession(userId, {});
  sessions.invalidateAllSessionsForUser(userId);
  const raw = db._raw();
  const stmt = raw.prepare('SELECT COUNT(*) FROM sessions WHERE user_id = ?');
  stmt.bind([userId]);
  stmt.step();
  const count = stmt.getAsObject()['COUNT(*)'];
  stmt.free();
  assert.strictEqual(count, 0);
});

test('sessions — invalidateAllSessionsForUser with exceptId keeps current', () => {
  const keep = sessions.createSession(userId, {});
  sessions.createSession(userId, {});
  sessions.createSession(userId, {});
  sessions.invalidateAllSessionsForUser(userId, { exceptId: keep.id });
  assert.ok(sessions.getSession(keep.id));
  const raw = db._raw();
  const stmt = raw.prepare('SELECT COUNT(*) FROM sessions WHERE user_id = ?');
  stmt.bind([userId]);
  stmt.step();
  const count = stmt.getAsObject()['COUNT(*)'];
  stmt.free();
  assert.strictEqual(count, 1);
});

test('sessions — sweepExpired deletes only expired rows', () => {
  sessions.invalidateAllSessionsForUser(userId);
  const fresh = sessions.createSession(userId, {});
  const stale = sessions.createSession(userId, {});
  const raw = db._raw();
  raw.run(`UPDATE sessions SET expires_at = datetime('now', '-1 day') WHERE id = ?`, [stale.id]);
  db.save();
  const removed = sessions.sweepExpired();
  assert.strictEqual(removed, 1);
  assert.ok(sessions.getSession(fresh.id));
});
