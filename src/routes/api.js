/**
 * MOTHERSHIP — API Routes
 *
 * REST endpoints for the dashboard and future integrations.
 */

const express = require('express');
const router = express.Router();
const db = require('../database');
const mirror = require('../mirror');

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

module.exports = router;
