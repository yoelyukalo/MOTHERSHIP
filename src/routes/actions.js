/**
 * MOTHERSHIP — Actions routes (Phase 5)
 *
 * Endpoints for browsing the action log, managing the pending_confirm
 * queue, and reading the latest reflection. Prompt-proposal endpoints
 * are added to this same router in Task 22.
 */

const express = require('express');
const db = require('../database');
const actionLogger = require('../action-logger');
const { requireAnyAuth } = require('../auth/middleware');

const router = express.Router();

router.get('/actions', requireAnyAuth(), (req, res) => {
  try {
    const { kind, status, limit } = req.query;
    const rows = db.getActions({
      userId: req.user.id,
      kind: kind || null,
      status: status || null,
      limit: limit ? parseInt(limit, 10) : 200
    });
    res.json({ actions: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/actions/pending', requireAnyAuth(), (req, res) => {
  try {
    const rows = db.getPendingActions({ userId: req.user.id });
    res.json({ actions: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/actions/:id/confirm', requireAnyAuth(), (req, res) => {
  try {
    actionLogger.confirmPendingAction(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/actions/:id/reject', requireAnyAuth(), (req, res) => {
  try {
    actionLogger.rejectPendingAction(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/actions/:id/resolve', requireAnyAuth(), (req, res) => {
  try {
    const { resolvingActionId } = req.body || {};
    if (!resolvingActionId) return res.status(400).json({ error: 'resolvingActionId required' });
    actionLogger.resolveAction(req.params.id, resolvingActionId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/reflections/latest', requireAnyAuth(), (req, res) => {
  try {
    const r = db.getLatestReflection({ userId: req.user.id });
    res.json({ reflection: r });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
