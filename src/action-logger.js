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

const AUTOLOG_CONFIDENCE = parseFloat(process.env.ACTION_AUTOLOG_CONFIDENCE || '0.75');
const QUEUE_CONFIDENCE = parseFloat(process.env.ACTION_QUEUE_CONFIDENCE || '0.5');

async function logActionFromTurn({ userText, assistantText, sourceId, userId }) {
  if (!userId) return { autoLogged: 0, queued: 0, dropped: 0 };

  // Lazy require to keep the dependency direction one-way:
  // extractor → action-logger is NOT allowed; action-logger → extractor IS.
  const extractor = require('./extractors/action-extractor');

  let result;
  try {
    result = await extractor.extract({ userText, assistantText, userId });
  } catch (err) {
    try { db.log('error', 'action-logger', `extractor failed: ${err.message}`); } catch {}
    return { autoLogged: 0, queued: 0, dropped: 0 };
  }

  const candidates = result?.candidates || [];
  let autoLogged = 0;
  let queued = 0;
  let dropped = 0;

  for (const cand of candidates) {
    if (!cand || !cand.kind || !cand.subject) {
      dropped++;
      continue;
    }
    const conf = typeof cand.confidence === 'number' ? cand.confidence : 0;
    if (conf >= AUTOLOG_CONFIDENCE) {
      logAction({
        kind: cand.kind,
        subject: cand.subject,
        data: cand.data || {},
        confidence: conf,
        status: 'active',
        sourceType: 'conversation',
        sourceId,
        userId
      });
      autoLogged++;
    } else if (conf >= QUEUE_CONFIDENCE) {
      logAction({
        kind: cand.kind,
        subject: cand.subject,
        data: cand.data || {},
        confidence: conf,
        status: 'pending_confirm',
        sourceType: 'conversation',
        sourceId,
        userId
      });
      queued++;
    } else {
      dropped++;
    }
  }

  return { autoLogged, queued, dropped };
}

module.exports = {
  logAction,
  logActionFromTurn,
  confirmPendingAction,
  rejectPendingAction,
  resolveAction
};
