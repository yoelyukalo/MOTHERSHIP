const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-sat-chat-'));
process.env.MOTHERSHIP_DB_PATH = path.join(tmpRoot, 'mothership.db');

const db = require('../../src/database');
const ve = require('../../src/memory/vector-engine');
const qm = require('../../src/quantum-mirror');
const hooks = require('../../src/conversation-hooks');
const users = require('../../src/auth/users');
const authRoles = require('../../src/auth/roles');

let testUserId;

before(async () => {
  await db.init();
  await authRoles.seedOnce(db);
  testUserId = await users.createUser({ email: 'chat-draft@x', password: 'p' });
});
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test('hooks.postResponse — draftSlug forces entry_type=experiment', async () => {
  ve._setClient({
    embeddings: { create: async () => ({ data: [{ embedding: new Array(3).fill(0.5) }] }) }
  });
  qm._setClient({
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: JSON.stringify({
          new_entries: [
            { entry_type: 'model', content: 'some insight about the workflow', confidence: 0.7 }
          ],
          supersede: [], contradictions: []
        }) }]
      })
    }
  });

  await hooks.postResponse({
    userText: 'Long enough message to trigger synthesis about a new dental satellite idea',
    assistantText: 'ok',
    sourceId: 't-draft',
    draftSlug: 'dr-chat-1',
    userId: testUserId
  });

  const entries = db.getMirrorEntries({ activeOnly: true, limit: 100, userId: testUserId });
  // Draft synthesis should be pinned to 'experiment', overriding the LLM's
  // proposed entry_type ('model').
  assert.ok(entries.some(e => e.entry_type === 'experiment'));
  assert.ok(!entries.some(e => e.entry_type === 'model'));
});
