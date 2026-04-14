const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-per-user-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');

const db = require('../../src/database');
const auth = require('../../src/auth');
const users = require('../../src/auth/users');
const authRoles = require('../../src/auth/roles');
const { v4: uuidv4 } = require('uuid');

let alice, bob, admin;

before(async () => {
  await db.init();
  await auth.init();
  alice = await users.createUser({ email: 'alice@x', password: 'p' });
  bob = await users.createUser({ email: 'bob@x', password: 'p' });
  admin = await users.createUser({ email: 'admin@x', password: 'p' });
  const raw = db._raw();
  function getRole(n) {
    const stmt = raw.prepare('SELECT id FROM roles WHERE name = ?');
    stmt.bind([n]);
    stmt.step();
    const id = stmt.getAsObject().id;
    stmt.free();
    return id;
  }
  raw.run(`INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id) VALUES (?, 'user', ?, ?, NULL)`, [uuidv4(), admin, getRole('mothership_admin')]);
  raw.run(`INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id) VALUES (?, 'user', ?, ?, NULL)`, [uuidv4(), alice, getRole('viewer')]);
  raw.run(`INSERT INTO role_assignments (id, principal_type, principal_id, role_id, satellite_id) VALUES (?, 'user', ?, ?, NULL)`, [uuidv4(), bob, getRole('viewer')]);
  db.save();
});

after(async () => {
  await auth.shutdown();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('per-user-scope — addMessage stamps user_id', () => {
  const id = db.addMessage("alice's message", 'dashboard', 'uncategorized', {}, alice);
  const raw = db._raw();
  const stmt = raw.prepare('SELECT user_id FROM messages WHERE id = ?');
  stmt.bind([id]);
  stmt.step();
  const row = stmt.getAsObject();
  stmt.free();
  assert.strictEqual(row.user_id, alice);
});

test('per-user-scope — getMessages filters to the user', () => {
  db.addMessage("bob's message", 'dashboard', 'uncategorized', {}, bob);
  const aliceMessages = db.getMessages({ userId: alice });
  const bobMessages = db.getMessages({ userId: bob });
  assert.ok(aliceMessages.every(m => m.user_id === alice));
  assert.ok(bobMessages.every(m => m.user_id === bob));
  assert.strictEqual(aliceMessages.find(m => m.content === "bob's message"), undefined);
});

test('per-user-scope — getMessages without userId throws', () => {
  assert.throws(() => db.getMessages({}), /userId/);
});

test('per-user-scope — getMessages with allUsers=true returns everything', () => {
  const all = db.getMessages({ allUsers: true });
  assert.ok(all.length >= 2);
});

test('per-user-scope — addMirrorEntry + getMirrorEntries isolated by user', () => {
  db.addMirrorEntry({
    category: 'preferences', content: 'alice likes dense explanations',
    confidence: 0.8, source_type: 'conversation', userId: alice
  });
  db.addMirrorEntry({
    category: 'preferences', content: 'bob likes bullet points',
    confidence: 0.8, source_type: 'conversation', userId: bob
  });
  const aliceEntries = db.getMirrorEntries({ userId: alice });
  const bobEntries = db.getMirrorEntries({ userId: bob });
  assert.ok(aliceEntries.some(e => e.content.includes('alice')));
  assert.ok(!aliceEntries.some(e => e.content.includes('bob')));
  assert.ok(bobEntries.some(e => e.content.includes('bob')));
});

test('per-user-scope — backfill was run at bootstrap (no NULL rows)', () => {
  const raw = db._raw();
  for (const t of ['messages', 'mirror_entries', 'wiki_entries']) {
    const stmt = raw.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE user_id IS NULL`);
    stmt.step();
    const nullCount = stmt.getAsObject().c;
    stmt.free();
    assert.strictEqual(nullCount, 0, `${t} has NULL user_id rows`);
  }
});
