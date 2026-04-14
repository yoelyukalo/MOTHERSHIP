const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-bootstrap-'));
const tmpDb = path.join(tmpRoot, 'mothership.db');

after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function runScript(args) {
  return spawnSync('node', [path.join(__dirname, '..', '..', 'scripts', 'create-admin.js'), ...args], {
    env: { ...process.env, MOTHERSHIP_DB_PATH: tmpDb },
    encoding: 'utf8'
  });
}

test('bootstrap — rejects without --email', () => {
  const r = runScript(['--password', 'p']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /email/);
});

test('bootstrap — rejects without --password', () => {
  const r = runScript(['--email', 'a@b']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /password/);
});

test('bootstrap — creates first admin and exits 0', () => {
  const r = runScript(['--email', 'yoel@x', '--password', 'p', '--display-name', 'Yoel']);
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  assert.match(r.stdout, /yoel@x/);
});

test('bootstrap — refuses second run without --force', () => {
  const r = runScript(['--email', 'another@x', '--password', 'p']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /users exist/);
});

test('bootstrap — second run with --force creates another admin', () => {
  const r = runScript(['--email', 'another@x', '--password', 'p', '--force']);
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
});
