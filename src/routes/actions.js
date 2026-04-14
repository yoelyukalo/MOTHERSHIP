/**
 * MOTHERSHIP — Actions routes (Phase 5)
 *
 * Endpoints for browsing the action log, managing the pending_confirm
 * queue, and reading the latest reflection. Prompt-proposal endpoints
 * are added to this same router in Task 22.
 */

const express = require('express');
const db = require('../database');
const { logAction, confirmPendingAction, rejectPendingAction, resolveAction } = require('../action-logger');
const { requireAnyAuth } = require('../auth/middleware');
const registry = require('../prompts/registry');

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
    confirmPendingAction(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/actions/:id/reject', requireAnyAuth(), (req, res) => {
  try {
    rejectPendingAction(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/actions/:id/resolve', requireAnyAuth(), (req, res) => {
  try {
    const { resolvingActionId } = req.body || {};
    if (!resolvingActionId) return res.status(400).json({ error: 'resolvingActionId required' });
    resolveAction(req.params.id, resolvingActionId);
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

router.get('/prompt-proposals', requireAnyAuth(), (req, res) => {
  try {
    const status = req.query.status || 'pending';
    if (status === 'pending') {
      return res.json({ proposals: db.getPendingPromptProposals() });
    }
    // Non-pending statuses: not implemented yet; return empty for now.
    res.json({ proposals: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/prompt-proposals/:id', requireAnyAuth(), (req, res) => {
  try {
    const p = db.getPromptProposal(req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    res.json({ proposal: p });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/prompt-proposals/:id/approve', requireAnyAuth(), (req, res) => {
  try {
    const proposal = db.getPromptProposal(req.params.id);
    if (!proposal) return res.status(404).json({ error: 'not found' });
    if (proposal.status !== 'pending') {
      return res.status(409).json({ error: `already ${proposal.status}` });
    }

    const newVersion = registry.createVersion(
      proposal.prompt_name,
      proposal.proposed_body,
      { createdBy: 'reflection', parentVersion: proposal.base_version, activate: true }
    );
    db.updatePromptProposalStatus(proposal.id, 'approved');

    logAction({
      kind: 'mothership_prompt_change',
      subject: `approved ${proposal.prompt_name}`,
      data: { name: proposal.prompt_name, from: proposal.base_version, to: newVersion },
      sourceType: 'dashboard',
      userId: req.user.id
    });

    res.json({ ok: true, newVersion });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/prompt-proposals/:id/reject', requireAnyAuth(), (req, res) => {
  try {
    const proposal = db.getPromptProposal(req.params.id);
    if (!proposal) return res.status(404).json({ error: 'not found' });
    if (proposal.status !== 'pending') {
      return res.status(409).json({ error: `already ${proposal.status}` });
    }
    db.updatePromptProposalStatus(proposal.id, 'rejected');
    logAction({
      kind: 'mothership_prompt_change_rejected',
      subject: `rejected ${proposal.prompt_name}`,
      data: { name: proposal.prompt_name, proposal_id: proposal.id },
      sourceType: 'dashboard',
      userId: req.user.id
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
