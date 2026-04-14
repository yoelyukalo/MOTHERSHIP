/**
 * MOTHERSHIP — Auth middleware factory
 */

const sessions = require('./sessions');
const apiKeys = require('./api-keys');
const resolver = require('./resolver');
const db = require('../database');

const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 0, windowStart: now });
    return true;
  }
  return entry.count < LOGIN_MAX_ATTEMPTS;
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, windowStart: now });
  } else {
    entry.count++;
  }
}

function clearLoginFailures(ip) {
  loginAttempts.delete(ip);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k) out[k] = v;
  }
  return out;
}

async function identifyAndLoad(req) {
  const auth = req.headers.authorization;
  const bearerMatch = auth && auth.match(/^Bearer (.+)$/);
  if (bearerMatch) {
    const keyRow = await apiKeys.lookupByToken(bearerMatch[1]);
    if (!keyRow) return null;
    const user = await resolver.loadUserWithPermissions(keyRow.user_id);
    if (!user || user.disabled_at) return null;
    return user;
  }
  const cookies = parseCookies(req);
  const sid = cookies.mothership_sid;
  if (sid) {
    const sess = sessions.getSession(sid);
    if (!sess) return null;
    const user = await resolver.loadUserWithPermissions(sess.user_id);
    if (!user || user.disabled_at) return null;
    return user;
  }
  return null;
}

function requireAuth({ permission, satelliteParam = null } = {}) {
  return async function (req, res, next) {
    try {
      const user = await identifyAndLoad(req);
      if (!user) return res.status(401).json({ error: 'authentication required' });
      req.user = user;
      if (permission) {
        const slug = satelliteParam ? req.params[satelliteParam] : null;
        if (!user.can(permission, slug)) {
          return res.status(403).json({
            error: `forbidden: missing ${permission}${slug ? ` on ${slug}` : ''}`
          });
        }
      }
      next();
    } catch (err) {
      db.log('error', 'auth.middleware', err.message);
      res.status(500).json({ error: 'auth middleware error' });
    }
  };
}

function requireAnyAuth() {
  return requireAuth({});
}

module.exports = {
  requireAuth, requireAnyAuth,
  checkLoginRateLimit, recordLoginFailure, clearLoginFailures
};
