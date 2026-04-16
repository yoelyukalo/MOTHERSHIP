const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(__dirname, `.tmp-reflection-${Date.now()}.db`);
process.env.MOTHERSHIP_DB_PATH = tmpDb;

const db = require('../src/database');
const users = require('../src/auth/users');
const authRoles = require('../src/auth/roles');
const registry = require('../src/prompts/registry');
const ve = require('../src/memory/vector-engine');
const reflection = require('../src/reflection');
const replay = require('../src/prompts/replay');

let uid;

before(async () => {
  await db.init();
  await authRoles.seedOnce(db);
  uid = await users.createUser({ email: 'rf@x', password: 'p' });
  registry.seedFromHardcoded();
  ve._setClient({
    embeddings: { create: async () => ({ data: [{ embedding: new Array(3).fill(0.5) }] }) }
  });

  // Seed 3 user actions and 2 mothership_synthesis actions in the last 24h
  db.addAction({ kind: 'commitment', subject: 'ship v2 by Friday', sourceType: 'conversation', userId: uid });
  db.addAction({ kind: 'state', subject: 'tired mid-week', sourceType: 'conversation', userId: uid });
  db.addAction({ kind: 'win', subject: 'closed Acme deal', sourceType: 'conversation', userId: uid });

  const msgId = db.addMessage('test content for reflection input', 'telegram', 'uncategorized', {}, uid);
  db.addAction({ kind: 'mothership_synthesis', subject: 'mirror synth', data: { prompt_version: 'synthesis.mirror' }, sourceType: 'hook', sourceId: msgId, userId: uid });
});

after(() => { try { fs.unlinkSync(tmpDb); } catch {} });

test('runNow writes a reflection row and processes LLM output', async () => {
  reflection._setClient({
    messages: { create: async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        briefing_md: '# Today\n\nTest briefing.',
        patterns: [{ description: 'test pattern', evidence_action_ids: [], confidence: 0.8 }],
        self_critique: [],
        mirror_proposals: [
          { category: 'patterns', content: 'reflection-proposed pattern fact', confidence: 0.7 }
        ]
      }) }]
    }) }
  });
  replay._setClient({
    messages: { create: async () => ({ content: [{ type: 'text', text: '{}' }] }) }
  });

  const out = await reflection.runNow({ userId: uid });
  assert.strictEqual(out.status, 'ok');
  assert.ok(out.reflectionId);
  assert.strictEqual(out.mirrorProposalsStored, 1);

  const latest = db.getLatestReflection({ userId: uid });
  assert.ok(latest);
  assert.ok(latest.briefing_md.includes('Test briefing'));

  // Mirror proposal should have been flowed through vector-engine
  const entries = db.getMirrorEntries({ userId: uid });
  assert.ok(entries.some(e => e.source_type === 'reflection' && e.content === 'reflection-proposed pattern fact'));
});

test('runNow with self_critique creates prompt_proposals + runs replay', async () => {
  reflection._setClient({
    messages: { create: async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        briefing_md: 'brief',
        patterns: [],
        self_critique: [{
          prompt_name: 'synthesis.mirror',
          issue: 'misses thin categories',
          proposed_body: 'IMPROVED PROMPT BODY',
          rationale: 'needs better coverage'
        }],
        mirror_proposals: []
      }) }]
    }) }
  });
  replay._setClient({
    messages: { create: async () => ({ content: [{ type: 'text', text: '{}' }] }) }
  });

  const out = await reflection.runNow({ userId: uid });
  assert.strictEqual(out.promptProposalsCreated, 1);
  const proposals = db.getPendingPromptProposals();
  assert.ok(proposals.some(p => p.prompt_name === 'synthesis.mirror' && p.proposed_body === 'IMPROVED PROMPT BODY'));
});

test('runNow concurrency lock returns already_running on second call', async () => {
  let release;
  const blocker = new Promise(r => { release = r; });
  reflection._setClient({
    messages: { create: async () => {
      await blocker;
      return { content: [{ type: 'text', text: JSON.stringify({
        briefing_md: 'x', patterns: [], self_critique: [], mirror_proposals: []
      }) }] };
    }}
  });
  const first = reflection.runNow({ userId: uid });
  // Give the first call a tick to set the lock
  await new Promise(r => setTimeout(r, 10));
  const second = await reflection.runNow({ userId: uid });
  assert.strictEqual(second.status, 'already_running');
  release();
  await first;
});

test('runNow tolerates Claude failure without throwing', async () => {
  reflection._setClient({
    messages: { create: async () => { throw new Error('api down'); } }
  });
  let out;
  await assert.doesNotReject(async () => {
    out = await reflection.runNow({ userId: uid });
  });
  assert.strictEqual(out.status, 'failed');
  assert.ok(out.error);
});

test('runNow with empty actions window still runs cleanly', async () => {
  // Use a user with no seeded actions
  const freshUid = await users.createUser({ email: 'fresh@x', password: 'p' });
  reflection._setClient({
    messages: { create: async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        briefing_md: 'nothing to report',
        patterns: [], self_critique: [], mirror_proposals: []
      }) }]
    }) }
  });
  const out = await reflection.runNow({ userId: freshUid });
  assert.strictEqual(out.status, 'ok');
  assert.strictEqual(out.actionCount, 0);
});

test('runNow requires userId', async () => {
  await assert.rejects(() => reflection.runNow({}), /userId required/);
});

test('runNow tolerates ```json code-fenced responses', async () => {
  const fenced = '```json\n' + JSON.stringify({
    briefing_md: '## Heads up\n\nHere is a `code` snippet.',
    patterns: [],
    self_critique: [],
    mirror_proposals: []
  }) + '\n```';
  reflection._setClient({
    messages: { create: async () => ({ content: [{ type: 'text', text: fenced }] }) }
  });
  const fresh = await users.createUser({ email: 'fenced@x', password: 'p' });
  const out = await reflection.runNow({ userId: fresh });
  assert.strictEqual(out.status, 'ok');
  const latest = db.getLatestReflection({ userId: fresh });
  assert.ok(latest.briefing_md.includes('Heads up'));
});

test('runNow logs raw payload on unparseable_response', async () => {
  reflection._setClient({
    messages: { create: async () => ({ content: [{ type: 'text', text: 'this is not JSON at all' }] }) }
  });
  const fresh = await users.createUser({ email: 'bad@x', password: 'p' });
  const out = await reflection.runNow({ userId: fresh });
  assert.strictEqual(out.status, 'failed');
  assert.strictEqual(out.error, 'unparseable_response');
  const logs = db.getLogs({ limit: 10, level: 'error' });
  assert.ok(logs.some(l =>
    l.source === 'reflection' &&
    l.message === 'unparseable_response' &&
    typeof l.data?.head === 'string'
  ), 'expected reflection error log with head payload');
});

test('deliverBriefing writes Obsidian file and marks reflection delivered', async () => {
  const os = require('os');
  const vault = path.join(os.tmpdir(), `vault-${Date.now()}`);
  process.env.OBSIDIAN_VAULT_PATH = vault;
  fs.mkdirSync(vault, { recursive: true });

  // Seed a reflection row to deliver
  const reflectionId = db.addReflection({
    userId: uid,
    windowStart: '2026-04-13T07:00:00Z',
    windowEnd: '2026-04-14T07:00:00Z',
    briefingMd: '# Delivery test\n\nThis is the briefing body.',
    actionCount: 5
  });
  const refl = db.getLatestReflection({ userId: uid });

  const sentMessages = [];
  const fakeBot = {
    sendMessage: async (chatId, text) => { sentMessages.push({ chatId, text }); return { message_id: 1 }; }
  };

  const result = await reflection.deliverBriefing({
    reflection: refl,
    telegramBot: fakeBot,
    telegramChatId: 12345
  });

  assert.ok(result.obsidianPath);
  assert.ok(fs.existsSync(result.obsidianPath));
  assert.strictEqual(result.telegramSent, 1);
  assert.strictEqual(sentMessages.length, 1);
  assert.ok(sentMessages[0].text.includes('Delivery test'));

  // Read the Obsidian file and verify frontmatter + body
  const content = fs.readFileSync(result.obsidianPath, 'utf8');
  assert.ok(content.includes('type: daily_reflection'));
  assert.ok(content.includes('Delivery test'));

  // Verify the reflection row was marked delivered
  const refreshed = db.getLatestReflection({ userId: uid });
  assert.strictEqual(refreshed.delivered_telegram, 1);
  assert.strictEqual(refreshed.delivered_obsidian, result.obsidianPath);

  // Clean up
  fs.rmSync(vault, { recursive: true, force: true });
  delete process.env.OBSIDIAN_VAULT_PATH;
});

test('deliverBriefing tolerates Telegram failure, still writes Obsidian', async () => {
  const os = require('os');
  const vault = path.join(os.tmpdir(), `vault2-${Date.now()}`);
  process.env.OBSIDIAN_VAULT_PATH = vault;
  fs.mkdirSync(vault, { recursive: true });

  const reflectionId2 = db.addReflection({
    userId: uid,
    windowStart: '2026-04-13T07:00:00Z',
    windowEnd: '2026-04-14T07:00:00Z',
    briefingMd: 'partial delivery',
    actionCount: 1
  });
  const refl = db.getLatestReflection({ userId: uid });

  const fakeBot = {
    sendMessage: async () => { throw new Error('tg down'); }
  };

  const result = await reflection.deliverBriefing({
    reflection: refl,
    telegramBot: fakeBot,
    telegramChatId: 12345
  });

  assert.ok(result.obsidianPath);
  assert.strictEqual(result.telegramSent, 0);

  fs.rmSync(vault, { recursive: true, force: true });
  delete process.env.OBSIDIAN_VAULT_PATH;
});

test('deliverBriefing skips Obsidian write when OBSIDIAN_VAULT_PATH unset', async () => {
  delete process.env.OBSIDIAN_VAULT_PATH;

  const reflectionId3 = db.addReflection({
    userId: uid,
    windowStart: 'a', windowEnd: 'b',
    briefingMd: 'no vault test',
    actionCount: 0
  });
  const refl = db.getLatestReflection({ userId: uid });

  const fakeBot = {
    sendMessage: async () => ({ message_id: 1 })
  };

  const result = await reflection.deliverBriefing({
    reflection: refl,
    telegramBot: fakeBot,
    telegramChatId: 12345
  });

  assert.strictEqual(result.obsidianPath, null);
  assert.strictEqual(result.telegramSent, 1);
});
