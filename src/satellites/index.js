/**
 * MOTHERSHIP — Satellites public surface
 *
 * Imported by server.js and routes/api.js. This is the only module the rest
 * of Mothership should reach into. Internals (sovereignty, kinds, raw
 * handles) are deliberately not re-exported.
 */

const registry = require('./registry');
const loader = require('./loader');
const directives = require('./directives');
const drafts = require('./drafts');

async function init() {
  await loader.init();
}

async function shutdown() {
  await loader.shutdown();
}

module.exports = {
  init,
  shutdown,
  registry,
  loader,
  directives,
  drafts
};
