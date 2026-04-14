/**
 * MOTHERSHIP — Action Logger
 *
 * Thin wrapper over db.addAction + status helpers. Two concerns:
 * 1. logAction() — direct structured log, used by Mothership-side callsites
 *    (conversation.js, quantum-mirror.js, synthesizer.js, processor.js)
 *    and by the hybrid extractor after it classifies a user turn.
 * 2. logActionFromTurn() — orchestrates the action-extractor LLM pass and
 *    auto-logs high-confidence candidates / queues borderline ones. Added
 *    in a later task (Task 15).
 *
 * All calls are swallow-on-error: we never break the user path because an
 * audit write failed. Matches the existing pattern in conversation-hooks.js
 * and quantum-mirror.js.
 */

const db = require('./database');

function logAction({ kind, subject, data = {}, confidence = 0.8, status = 'active',
                     sourceType, sourceId = null, parentActionId = null, userId }) {
  try {
    return db.addAction({
      kind, subject, data, confidence, status,
      sourceType, sourceId, parentActionId, userId
    });
  } catch (err) {
    try { db.log('error', 'action-logger', err.message, { kind, subject }); } catch {}
    return null;
  }
}

function confirmPendingAction(actionId) {
  try {
    db.updateActionStatus(actionId, 'active');
  } catch (err) {
    try { db.log('error', 'action-logger', `confirm failed: ${err.message}`, { actionId }); } catch {}
  }
}

function rejectPendingAction(actionId) {
  try {
    db.updateActionStatus(actionId, 'rejected');
  } catch (err) {
    try { db.log('error', 'action-logger', `reject failed: ${err.message}`, { actionId }); } catch {}
  }
}

function resolveAction(commitmentId, resolvingActionId) {
  try {
    db.resolveAction(commitmentId, resolvingActionId);
  } catch (err) {
    try { db.log('error', 'action-logger', `resolve failed: ${err.message}`, { commitmentId }); } catch {}
  }
}

module.exports = {
  logAction,
  confirmPendingAction,
  rejectPendingAction,
  resolveAction
};
