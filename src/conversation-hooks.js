/**
 * MOTHERSHIP — Conversation hooks
 *
 * Three integration points wired into the message pipeline:
 * 1. preResponse  → retriever builds the live context block
 * 2. postResponse → quantum-mirror synthesis from the turn
 * 3. postIngestion → wiki synthesis from newly ingested content
 *
 * Synthesis calls ALWAYS catch errors so a synthesis failure never breaks
 * a user reply.
 */

const retriever = require('./memory/retriever');
const qm = require('./quantum-mirror');
const syn = require('./synthesizer');
const db = require('./database');

const MIRROR_TOPK = parseInt(process.env.MIRROR_TOPK || '5', 10);
const WIKI_TOPK = parseInt(process.env.WIKI_TOPK || '5', 10);
const MIN_TURN_LENGTH = parseInt(process.env.SYNTHESIS_MIN_CHARS || '40', 10);

async function preResponse(userText, { userId } = {}) {
  if (!userId) throw new Error('preResponse: userId required');
  try {
    return await retriever.buildContextBlock(userText, {
      mirrorTopK: MIRROR_TOPK,
      wikiTopK: WIKI_TOPK,
      userId
    });
  } catch (err) {
    db.log('error', 'hooks.preResponse', err.message);
    return '';
  }
}

async function postResponse({ userText, assistantText, sourceId, draftSlug = null, userId }) {
  if (!userId) throw new Error('postResponse: userId required');
  if (!userText || userText.length < MIN_TURN_LENGTH) return;
  try {
    await qm.synthesizeFromTurn({
      userText,
      assistantText,
      sourceId,
      userId,
      forceCategory: draftSlug ? 'satellite-building' : null
    });
  } catch (err) {
    db.log('error', 'hooks.postResponse', err.message);
  }
}

async function postIngestion({ content, sourceId, userId }) {
  if (!userId) throw new Error('postIngestion: userId required');
  if (!content || content.length < MIN_TURN_LENGTH) return;
  try {
    await syn.synthesizeFromContent({ content, sourceId });
  } catch (err) {
    db.log('error', 'hooks.postIngestion', err.message);
  }
}

module.exports = { preResponse, postResponse, postIngestion };
