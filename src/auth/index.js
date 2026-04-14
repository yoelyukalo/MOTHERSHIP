/**
 * MOTHERSHIP — Auth public surface
 */

const hashing = require('./hashing');
const users = require('./users');
const sessions = require('./sessions');
const apiKeys = require('./api-keys');
const groups = require('./groups');
const roles = require('./roles');
const resolver = require('./resolver');
const middleware = require('./middleware');
const invitations = require('./invitations');
const systemOwner = require('./system-owner');
const backfill = require('./backfill');

async function init() {
  await roles.seedOnce(require('../database'));
  try { sessions.sweepExpired(); } catch (_) {}
  sessions.startDailySweep();
  await backfill.runBackfillIfNeeded();
}

async function shutdown() {
  sessions.stopDailySweep();
}

function getSystemOwnerId() {
  return systemOwner.getSystemOwnerId();
}

module.exports = {
  init, shutdown,
  hashing, users, sessions, apiKeys, groups, roles,
  resolver, middleware, invitations, backfill,
  getSystemOwnerId,
  requireAuth: middleware.requireAuth,
  requireAnyAuth: middleware.requireAnyAuth
};
