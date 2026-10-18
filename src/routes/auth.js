'use strict';
const express = require('express');
const config = require('../config');
const { createAuthClient, createUserClient, getAdminClient } = require('../lib/supabase');
const { E, isNetworkError } = require('../lib/errors');
const { setSessionCookies, clearSessionCookies, readSessionCookies } = require('../lib/session');
const { requireAuth, loadProfile, forgetToken } = require('../middleware/auth');
const { sanitizeText } = require('../lib/helpers');
const { rateLimit } = require('../middleware/rate-limit');

const router = express.Router();
const PRIVACY_VERSION = '2026-10';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function readEmail(body) {
  const email = String(body?.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) throw E.validation('Enter a valid email address.');
  return email;
}

// Passwords: at least 10 characters (Supabase checks length too), at most 128, not a well-known
// password, not one repeated character, and not built from the person's own email name.
const COMMON = ['password', 'passw0rd', '1234567890', '0123456789', 'qwertyuiop', 'asdfghjkl', 'iloveyou', 'aquacast', 'admin', 'welcome',
  'letmein', 'abc123', 'password1', 'qwerty123', '11111111', 'changeme', 'p@ssw0rd', 'bfar'];
function passwordProblem(pw, email = '') {
  if (pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 128) return 'Password must be at most 128 characters.';
  const low = pw.toLowerCase();
  if (/^(.)\1+$/.test(pw)) return 'Choose a password that is not one repeated character.';
  if (COMMON.some((c) => low === c || (c.length >= 8 && low.replace(/[^a-z0-9@]/g, '').startsWith(c) && low.length < c.length + 4))) return 'This password is too common. Choose something harder to guess.';
  const name = String(email).split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  if (name.length >= 4 && low.replace(/[^a-z0-9]/g, '').includes(name)) return 'Do not use your email name in your password.';
  return null;
}

function publicProfile(p) {
  if (!p) return null;
  return {
    user_id: p.user_id, email: p.email, full_name: p.full_name, organization: p.organization,
    position: p.position, role: p.role, status: p.status, last_login_at: p.last_login_at, created_at: p.created_at,
  };
}

function authFailure(error) {
  if (isNetworkError(error) || error?.status >= 500) return E.supabaseUnavailable();
  const code = error?.code || '';
  const msg = String(error?.message || '');
  if (code === 'email_not_confirmed' || /email not confirmed/i.test(msg)) return E.emailNotVerified();
  if (code === 'user_banned' || /banned/i.test(msg)) return E.accountStatus('SUSPENDED');
  if (error?.status === 429 || code === 'over_request_rate_limit') return E.rateLimited(60);
  return E.invalidCredentials();
}

/**
 * POST /api/auth/login  { email, password, remember }
 * 1. Supabase Auth verifies the password.
 * 2. Email must be confirmed.
 * 3. user_access_profiles.status must be ACTIVE (PENDING / SUSPENDED / REVOKED are refused).
 * Only then are the session cookies issued.
 */
// three sign-in limits: one person guessing one account, one network trying many accounts,
// and many networks trying one account (spread-out password guessing)
router.post('/login', rateLimit({ windowMs: 15 * 60_000, max: 10, key: (req) => `login:${req.ip}:${String(req.body?.email || '').toLowerCase()}` }),
  rateLimit({ windowMs: 15 * 60_000, max: 30, key: (req) => `login-ip:${req.ip}` }),
  rateLimit({ windowMs: 60 * 60_000, max: 20, key: (req) => `login-email:${String(req.body?.email || '').trim().toLowerCase()}` }),
  async (req, res, next) => {
    try {
      const email = readEmail(req.body);
      const password = String(req.body?.password || '');
      if (!password) throw E.validation('Password is required.');
      const remember = req.body?.remember === true || req.body?.remember === 'true';

      const auth = createAuthClient();
      const { data, error } = await auth.auth.signInWithPassword({ email, password });
      if (error) throw authFailure(error);
      const { session, user } = data;

      if (!user.email_confirmed_at) {
        await getAdminClient().auth.admin.signOut(session.access_token).catch(() => {});
        throw E.emailNotVerified();
      }

      const db = createUserClient(session.access_token);
      const profile = await loadProfile(db, user.id);
      if (!profile || profile.status !== 'ACTIVE') {
        // Credentials were right but access is not granted: revoke the session we just created.
        await getAdminClient().auth.admin.signOut(session.access_token).catch(() => {});
        throw E.accountStatus(profile?.status || 'NO_PROFILE');
      }

      await db.rpc('touch_last_login').then(() => {}, () => {});
      setSessionCookies(res, session, remember);
      res.json({ data: { user: { id: user.id, email: user.email }, profile: publicProfile(profile) } });
    } catch (err) {
      next(err);
    }
  });

/** POST /api/auth/logout - revokes the refresh token at Supabase and clears cookies. Always succeeds locally. */
router.post('/logout', async (req, res) => {
  const { accessToken } = readSessionCookies(req);
  if (accessToken) {
    forgetToken(accessToken);
    await getAdminClient().auth.admin.signOut(accessToken, 'local').catch(() => {});
  }
  clearSessionCookies(res);
  res.json({ data: { signed_out: true } });
});

/** GET /api/auth/session - who am I (used on page load to restore a remembered session). */
router.get('/session', requireAuth(), (req, res) => {
  res.json({ data: { user: { id: req.auth.user.id, email: req.auth.user.email }, profile: publicProfile(req.auth.profile) } });
});

/**
 * POST /api/auth/request-access  { full_name, email, password, organization, position }
 * Creates the Supabase Auth account. The database trigger creates a
 * BFAR_STAFF / PENDING profile; an Administrator must approve it.
 */
router.post('/request-access', rateLimit({ windowMs: 60 * 60_000, max: 5, key: (req) => `signup:${req.ip}` }),
  async (req, res, next) => {
    try {
      const email = readEmail(req.body);
      const password = String(req.body?.password || '');
      const fullName = sanitizeText(req.body?.full_name, 120);
      const organization = sanitizeText(req.body?.organization, 160);
      const position = sanitizeText(req.body?.position, 120);
      if (!fullName) throw E.validation('Full name is required.');
      if (!organization) throw E.validation('Organization / assignment is required.');
      { const weak = passwordProblem(password, email); if (weak) throw E.validation(weak); }
      const consent = req.body?.privacy_consent === true || req.body?.privacy_consent === 'on' || req.body?.privacy_consent === 'true';
      if (!consent) throw E.validation('Please read and accept the Privacy Notice to request access.');

      const { data, error } = await createAuthClient().auth.signUp({
        email, password,
        options: {
          data: { full_name: fullName, organization, position, privacy_consent_at: new Date().toISOString(), privacy_notice_version: PRIVACY_VERSION },
          emailRedirectTo: `${config.publicSiteUrl}/?verified=1`,
        },
      });
      if (error) {
        if (isNetworkError(error) || error.status >= 500) throw E.supabaseUnavailable();
        if (/already registered|already exists/i.test(error.message)) {
          // Same response as success so the endpoint cannot be used to discover registered emails.
          return res.status(202).json({ data: { submitted: true, email_verification_required: true } });
        }
        throw E.validation(error.message);
      }
      if (data.session) {
        // Projects with email confirmation turned off return a session: discard it (account is PENDING anyway).
        await getAdminClient().auth.admin.signOut(data.session.access_token).catch(() => {});
      }
      res.status(202).json({
        data: { submitted: true, email_verification_required: !data.user?.email_confirmed_at,
          message: 'Request received. Verify your email, then wait for an Administrator to approve your access.' },
      });
    } catch (err) {
      next(err);
    }
  });

/**
 * PATCH /api/auth/me { full_name, organization, position } - edit my own profile.
 * Email, role and access status cannot be changed here (email is the sign-in identity;
 * role and status are decided by Administrators).
 */
router.patch('/me', requireAuth(), async (req, res, next) => {
  try {
    const { user, profile } = req.auth;
    const fullName = sanitizeText(req.body?.full_name, 120);
    const organization = sanitizeText(req.body?.organization, 160);
    const position = sanitizeText(req.body?.position, 120);
    if (!fullName) throw E.validation('Full name is required.');
    if (!organization) throw E.validation('Organization / assignment is required.');
    const changes = { full_name: fullName, organization, position };
    const changed = Object.keys(changes).filter((k) => (profile[k] || null) !== (changes[k] || null));
    if (!changed.length) return res.json({ data: publicProfile(profile), meta: { message: 'Nothing to change.' } });
    const admin = getAdminClient();
    const { data, error } = await admin.from('user_access_profiles').update({ ...changes, updated_at: new Date().toISOString() })
      .eq('user_id', user.id).select('*').single();
    if (error) throw E.validation(error.message);
    await admin.auth.admin.updateUserById(user.id, { user_metadata: { ...(user.user_metadata || {}), full_name: fullName, organization, position } }).catch(() => {});
    await admin.from('dashboard_audit_log').insert({ actor_user_id: user.id, action: 'PROFILE_UPDATED', target_table: 'user_access_profiles', target_id: user.id,
      details: { fields: changed } }).then(() => null, () => null);
    res.json({ data: publicProfile(data), meta: { message: 'Your profile was updated.' } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/change-password { current_password, new_password }
 * Checks the current password first, then sets the new one and signs out every OTHER device
 * (this one stays signed in).
 */
router.post('/change-password', requireAuth(), rateLimit({ windowMs: 15 * 60_000, max: 5, key: (req) => `chpw:${req.auth.user.id}` }),
  async (req, res, next) => {
    try {
      const { user } = req.auth;
      const current = String(req.body?.current_password || '');
      const next_ = String(req.body?.new_password || '');
      if (!current) throw E.validation('Enter your current password.');
      { const weak = passwordProblem(next_, user.email); if (weak) throw E.validation(weak.replace(/^Password/, 'The new password')); }
      if (next_ === current) throw E.validation('The new password must be different from the current one.');
      const { data: check, error: wrong } = await createAuthClient().auth.signInWithPassword({ email: user.email, password: current });
      if (wrong) {
        if (isNetworkError(wrong) || wrong.status >= 500) throw E.supabaseUnavailable();
        throw E.validation('Your current password is not correct.');
      }
      const admin = getAdminClient();
      if (check?.session) await admin.auth.admin.signOut(check.session.access_token, 'local').catch(() => {}); // discard the check session
      const { error: upd } = await admin.auth.admin.updateUserById(user.id, { password: next_ });
      if (upd) throw E.validation(upd.message);
      const { accessToken } = readSessionCookies(req);
      if (accessToken) await admin.auth.admin.signOut(accessToken, 'others').catch(() => {});
      await admin.from('dashboard_audit_log').insert({ actor_user_id: user.id, action: 'PASSWORD_CHANGED', target_table: 'auth.users', target_id: user.id,
        details: { other_devices_signed_out: true } }).then(() => null, () => null);
      res.json({ data: { changed: true }, meta: { message: 'Password changed. Other devices were signed out; this one stays signed in.' } });
    } catch (err) {
      next(err);
    }
  });

/** GET /api/auth/privacy-info - public: who to contact about personal data, and the notice version. */
router.get('/privacy-info', (_req, res) => {
  res.json({ data: { contact: config.privacyContact || null, version: PRIVACY_VERSION } });
});

/** POST /api/auth/forgot-password { email } - always answers the same way. */
router.post('/forgot-password', rateLimit({ windowMs: 60 * 60_000, max: 5, key: (req) => `reset:${req.ip}` }),
  async (req, res, next) => {
    try {
      const email = readEmail(req.body);
      const { error } = await createAuthClient().auth.resetPasswordForEmail(email, {
        redirectTo: `${config.publicSiteUrl}/set-password.html`,
      });
      if (error && (isNetworkError(error) || error.status >= 500)) throw E.supabaseUnavailable();
      res.json({ data: { sent: true, message: 'If that email is registered, a reset link has been sent.' } });
    } catch (err) {
      next(err);
    }
  });

/**
 * POST /api/auth/set-password { access_token, password }
 * Completes a password-reset or invitation link. The token arrives in the URL
 * fragment of set-password.html (never sent to the server by the browser),
 * which posts it here once.
 */
router.post('/set-password', rateLimit({ windowMs: 15 * 60_000, max: 10, key: (req) => `setpw:${req.ip}` }),
  async (req, res, next) => {
    try {
      const token = String(req.body?.access_token || '');
      const password = String(req.body?.password || '');
      if (!token) throw E.validation('The link is missing its token. Open the link from your email again.');
      const weak = passwordProblem(password);
      if (weak) throw E.validation(weak);
      const { data, error } = await createAuthClient().auth.getUser(token);
      if (error || !data?.user) throw E.sessionExpired();
      const { error: upd } = await getAdminClient().auth.admin.updateUserById(data.user.id, { password });
      if (upd) throw E.validation(upd.message);
      await getAdminClient().auth.admin.signOut(token).catch(() => {});
      res.json({ data: { password_set: true, message: 'Password saved. You can now sign in.' } });
    } catch (err) {
      next(err);
    }
  });

module.exports = router;
