/**
 * MOTHERSHIP — /api/auth/* endpoints
 */

const express = require('express');
const router = express.Router();
const db = require('../database');
const users = require('../auth/users');
const sessions = require('../auth/sessions');
const hashing = require('../auth/hashing');
const resolver = require('../auth/resolver');
const middleware = require('../auth/middleware');
const invitations = require('../auth/invitations');

function clientIp(req) {
  return req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';
}

function setSessionCookie(res, sessionId) {
  res.setHeader('Set-Cookie',
    `mothership_sid=${sessionId}; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}; Path=/`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'mothership_sid=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/');
}

router.post('/login', async (req, res) => {
  const ip = clientIp(req);
  if (!middleware.checkLoginRateLimit(ip)) {
    return res.status(429).json({ error: 'too many attempts' });
  }
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password required' });
  }
  const user = users.getUserByEmail(email);
  if (!user || user.disabled_at || user.auth_method !== 'password') {
    middleware.recordLoginFailure(ip);
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const ok = await hashing.verify(user.password_hash, password);
  if (!ok) {
    middleware.recordLoginFailure(ip);
    db.log('warn', 'auth.login_failed', `${email}`);
    return res.status(401).json({ error: 'invalid credentials' });
  }
  middleware.clearLoginFailures(ip);

  const sess = sessions.createSession(user.id, { ip, userAgent: req.headers['user-agent'] });
  setSessionCookie(res, sess.id);

  const loaded = await resolver.loadUserWithPermissions(user.id);
  res.json({
    user: { id: loaded.id, email: loaded.email, display_name: loaded.display_name },
    permissions: Array.from(loaded.permissionSet)
  });
  db.log('info', 'auth.login', `${email}`);
});

router.post('/logout', middleware.requireAnyAuth(), (req, res) => {
  const cookies = (req.headers.cookie || '').split(';').map(s => s.trim()).reduce((a, c) => {
    const [k, v] = c.split('='); if (k) a[k] = v; return a;
  }, {});
  const sid = cookies.mothership_sid;
  if (sid) sessions.invalidateSession(sid);
  clearSessionCookie(res);
  res.status(204).end();
});

router.get('/me', middleware.requireAnyAuth(), (req, res) => {
  res.json({
    user: {
      id: req.user.id, email: req.user.email, display_name: req.user.display_name,
      auth_method: req.user.auth_method
    },
    permissions: Array.from(req.user.permissionSet),
    systemRoles: req.user.systemRoles
  });
});

router.patch('/password', middleware.requireAnyAuth(), async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'current_password and new_password required' });
  }
  const user = users.getUserById(req.user.id);
  const ok = await hashing.verify(user.password_hash, current_password);
  if (!ok) return res.status(401).json({ error: 'current password incorrect' });
  await users.updatePassword(user.id, new_password);

  const cookies = (req.headers.cookie || '').split(';').map(s => s.trim()).reduce((a, c) => {
    const [k, v] = c.split('='); if (k) a[k] = v; return a;
  }, {});
  sessions.invalidateAllSessionsForUser(user.id, { exceptId: cookies.mothership_sid });

  db.log('info', 'auth.password_changed', user.email);
  res.json({ ok: true });
});

router.post('/claim-invite', async (req, res) => {
  const { token, password, display_name } = req.body || {};
  if (!token || !password) {
    return res.status(400).json({ error: 'token and password required' });
  }
  try {
    const result = await invitations.claimInvitation({ token, password, displayName: display_name });
    const sess = sessions.createSession(result.userId, { ip: clientIp(req), userAgent: req.headers['user-agent'] });
    setSessionCookie(res, sess.id);
    const loaded = await resolver.loadUserWithPermissions(result.userId);
    res.json({
      user: { id: loaded.id, email: loaded.email, display_name: loaded.display_name },
      permissions: Array.from(loaded.permissionSet)
    });
    db.log('info', 'auth.invitation_claimed', loaded.email);
  } catch (err) {
    db.log('warn', 'auth.claim_failed', err.message);
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
