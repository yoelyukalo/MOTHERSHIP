/**
 * MOTHERSHIP — API Routes
 *
 * REST endpoints for the dashboard and future integrations.
 */

const express = require('express');
const router = express.Router();
const db = require('../database');
const mirror = require('../mirror');
const obsidian = require('../exporters/obsidian');
const retriever = require('../memory/retriever');
const conversation = require('../conversation');
const hooks = require('../conversation-hooks');
const satellites = require('../satellites');
const { requireAuth, requireAnyAuth } = require('../auth/middleware');

// --- Status ---

router.get('/status', (req, res) => {
  res.json({
    status: 'online',
    version: '1.0.0',
    phase: 1,
    uptime: process.uptime(),
    messageCount: db.getMessageCount(),
    sources: db.getSourceCounts(),
    categories: db.getCategoryCounts()
  });
});

// --- Messages ---

router.get('/messages', (req, res) => {
  const { limit, offset, source, category, search } = req.query;
  const messages = db.getMessages({
    limit: parseInt(limit) || 50,
    offset: parseInt(offset) || 0,
    source,
    category,
    search
  });
  res.json(messages);
});

router.get('/messages/:id', (req, res) => {
  const msgs = db.getMessages({ limit: 1000 });
  const msg = msgs.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ error: 'not found' });
  res.json(msg);
});

router.post('/messages', (req, res) => {
  const { content, source, category, metadata } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });
  const id = db.addMessage(content, source || 'api', category || 'uncategorized', metadata || {});
  res.json({ id, status: 'ok' });
});

// --- Chat (dashboard → conversation pipeline) ---
//
// Mirrors the Telegram text path: stores the user turn, calls
// conversation.respond(), stores the mothership reply, and fires the
// postResponse hook so quantum-mirror synthesis runs on the turn.
router.post('/chat', async (req, res) => {
  const { content, draft_slug } = req.body || {};
  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'content is required' });
  }
  const userText = content.trim();
  const draftSlug = typeof draft_slug === 'string' && draft_slug.length > 0 ? draft_slug : null;

  try {
    const userMeta = { via: 'dashboard-chat' };
    if (draftSlug) userMeta.draft_slug = draftSlug;
    const userId = db.addMessage(userText, 'dashboard', 'uncategorized', userMeta);

    const reply = await conversation.respond(userText, { contextKind: 'text' });

    const replyMeta = { via: 'dashboard-chat', in_reply_to: userId };
    if (draftSlug) replyMeta.draft_slug = draftSlug;
    const replyId = db.addMessage(reply, 'mothership', 'reply', replyMeta);

    hooks.postResponse({
      userText,
      assistantText: reply,
      sourceId: replyId,
      draftSlug
    }).catch(err => db.log('error', 'api.chat.postResponse', err.message));

    res.json({ userId, replyId, reply });
  } catch (err) {
    db.log('error', 'api.chat', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Logs ---

router.get('/logs', (req, res) => {
  const { limit, level } = req.query;
  const logs = db.getLogs({ limit: parseInt(limit) || 100, level });
  res.json(logs);
});

// --- Quantum Mirror ---

router.get('/mirror', (req, res) => {
  res.json(mirror.getMirror());
});

router.get('/mirror/models', (req, res) => {
  res.json(mirror.getModels());
});

router.get('/mirror/learning', (req, res) => {
  res.json(mirror.getLearningStyle());
});

router.get('/mirror/knowledge', (req, res) => {
  res.json(mirror.getKnowledgeGraph());
});

router.get('/mirror/resonance', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(mirror.getResonanceLog(limit));
});

router.post('/mirror/resonance', (req, res) => {
  const { type, content, score, tags } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });
  const entry = mirror.logResonance(type || 'insight', content, score || 0, tags || []);
  res.json(entry);
});

// --- Quantum Mirror v2 ---

router.get('/mirror/entries', (req, res) => {
  const { category, limit } = req.query;
  res.json(db.getMirrorEntries({
    category: category || null,
    activeOnly: true,
    limit: parseInt(limit) || 100
  }));
});

router.get('/wiki/entries', (req, res) => {
  res.json(db.getAllWikiEntries());
});

router.post('/export', async (req, res) => {
  try { res.json(await obsidian.exportAll()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/briefing', async (req, res) => {
  const { topic } = req.body;
  try { res.json({ block: await retriever.buildContextBlock(topic || 'briefing') }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Satellites ---

// Map a thrown error to an HTTP status. `registry.js` and `directives.js`
// throw plain Error with predictable messages for known validation failures;
// anything else is treated as 500.
const DRAFT_STATUSES = new Set(['discussing', 'planned', 'building', 'created', 'abandoned']);
function statusForError(err) {
  const msg = (err && err.message) || '';
  if (msg.includes('already exists')) return 409;
  if (msg.startsWith('invalid ')) return 400;
  if (msg.startsWith('no such ')) return 404;
  if (msg.startsWith('cannot unarchive')) return 400;
  return 500;
}

// Drafts routes MUST come first because GET /satellites/:slug would otherwise
// match GET /satellites/drafts with :slug='drafts'.

router.post('/satellites/drafts', requireAuth({ permission: 'draft.create' }), (req, res) => {
  try {
    const { slug, name, kind } = req.body || {};
    if (!slug || !name) return res.status(400).json({ error: 'slug and name required' });
    const id = satellites.drafts.create({ slug, name, kind });
    res.json({ id, slug });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/satellites/drafts', requireAuth({ permission: 'draft.read' }), (req, res) => {
  res.json(satellites.drafts.list({ status: req.query.status }));
});

router.get('/satellites/drafts/:slug', requireAuth({ permission: 'draft.read' }), (req, res) => {
  const result = satellites.drafts.getDraftWithMessages(req.params.slug);
  if (!result) return res.status(404).json({ error: 'not found' });
  res.json(result);
});

router.post('/satellites/drafts/:slug/regenerate-brief', requireAuth({ permission: 'draft.regenerate_brief' }), async (req, res) => {
  try {
    const brief = await satellites.drafts.regenerateBrief(req.params.slug);
    res.json({ brief });
  } catch (err) {
    res.status(statusForError(err)).json({ error: err.message });
  }
});

router.post('/satellites/drafts/:slug/status', requireAuth({ permission: 'draft.edit_status' }), (req, res) => {
  try {
    const { status } = req.body || {};
    if (!DRAFT_STATUSES.has(status)) {
      return res.status(400).json({
        error: `invalid draft status: ${status} (allowed: ${[...DRAFT_STATUSES].join(', ')})`
      });
    }
    const existing = satellites.drafts.getBySlug(req.params.slug);
    if (!existing) return res.status(404).json({ error: 'not found' });
    satellites.drafts.setStatus(req.params.slug, status);
    res.json({ status });
  } catch (err) { res.status(statusForError(err)).json({ error: err.message }); }
});

// Satellites CRUD + lifecycle + directives

router.post('/satellites', requireAuth({ permission: 'satellite.create' }), async (req, res) => {
  try {
    const { slug, name, kind, visibility, owner, config, from_draft_slug, notes } = req.body || {};
    const result = await satellites.registry.createInstance({
      slug, name, kind, visibility, owner, config, notes
    });
    if (from_draft_slug) {
      satellites.drafts.linkToSatellite(from_draft_slug, result.id);
    }
    await satellites.loader.register(slug);
    res.json({ id: result.id, slug: result.slug, status: 'active' });
  } catch (err) {
    db.log('error', 'api.satellites.create', err.message);
    res.status(statusForError(err)).json({ error: err.message });
  }
});

router.get('/satellites', requireAnyAuth(), (req, res) => {
  const { status, kind, visibility } = req.query;
  const all = satellites.registry.listRows({ status, kind, visibility });
  const visible = all.filter(row => req.user.can('satellite.read', row.slug));
  res.json(visible);
});

router.get('/satellites/:slug', requireAuth({ permission: 'satellite.read', satelliteParam: 'slug' }), (req, res) => {
  const row = satellites.registry.getBySlug(req.params.slug);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

router.post('/satellites/:slug/archive', requireAuth({ permission: 'satellite.archive', satelliteParam: 'slug' }), async (req, res) => {
  try { await satellites.registry.archive(req.params.slug); res.json({ status: 'archived' }); }
  catch (err) { res.status(statusForError(err)).json({ error: err.message }); }
});

router.post('/satellites/:slug/unarchive', requireAuth({ permission: 'satellite.unarchive', satelliteParam: 'slug' }), async (req, res) => {
  try { await satellites.registry.unarchive(req.params.slug); res.json({ status: 'active' }); }
  catch (err) { res.status(statusForError(err)).json({ error: err.message }); }
});

router.post('/satellites/:slug/transfer', requireAuth({ permission: 'satellite.transfer', satelliteParam: 'slug' }), async (req, res) => {
  try {
    const { visibility, owner } = req.body || {};
    await satellites.registry.transfer(req.params.slug, { visibility, owner });
    res.json({ status: 'transferred' });
  } catch (err) { res.status(statusForError(err)).json({ error: err.message }); }
});

router.post('/satellites/:slug/visibility', requireAuth({ permission: 'satellite.set_visibility', satelliteParam: 'slug' }), async (req, res) => {
  try {
    const { visibility } = req.body || {};
    await satellites.registry.setVisibility(req.params.slug, visibility);
    res.json({ visibility });
  } catch (err) { res.status(statusForError(err)).json({ error: err.message }); }
});

router.post('/satellites/:slug/directives', requireAuth({ permission: 'satellite.issue_directive', satelliteParam: 'slug' }), (req, res) => {
  try {
    const { kind, payload } = req.body || {};
    if (!kind) return res.status(400).json({ error: 'kind is required' });
    const id = satellites.directives.issue(req.params.slug, {
      kind, payload: payload || {}, issuedBy: 'mothership:api'
    });
    res.json({ id, status: 'issued' });
  } catch (err) { res.status(statusForError(err)).json({ error: err.message }); }
});

router.get('/satellites/:slug/directives', requireAuth({ permission: 'satellite.read_directives', satelliteParam: 'slug' }), (req, res) => {
  try {
    const entry = satellites.loader.get(req.params.slug);
    if (!entry) return res.status(404).json({ error: 'satellite not loaded' });
    // `satellite_directives_history` is in the sovereignty wrapper's allow
    // list for `limited` visibility, but `none` visibility would throw
    // VisibilityViolation here — the catch below turns it into 403-style
    // behavior via statusForError (which doesn't know about this specific
    // class, so falls through to 500 with the wrapper's own message).
    const result = entry.db.exec(
      'SELECT id, kind, payload_json, status, error, applied_at FROM satellite_directives_history ORDER BY applied_at DESC'
    );
    if (!result.length) return res.json([]);
    const [firstResult] = result;
    res.json(firstResult.values.map(row => {
      const obj = {};
      firstResult.columns.forEach((c, i) => { obj[c] = row[i]; });
      return obj;
    }));
  } catch (err) {
    res.status(statusForError(err)).json({ error: err.message });
  }
});

module.exports = router;
