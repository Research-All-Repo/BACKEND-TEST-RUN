'use strict';
const crypto = require('crypto');
const { createAuthClient, createUserClient } = require('../lib/supabase');
const { E, fromSupabase, isNetworkError } = require('../lib/errors');
const { setSessionCookies, clearSessionCookies, readSessionCookies } = require('../lib/session');

// Short cache so every API call does not re-validate the token with Supabase Auth.
// Profile status is still re-read on every request (suspension takes effect immediately).
const USER_CACHE_MS = 30_000;
const userCache = new Map();

function tokenKey(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function getUserForToken(accessToken) {
  const key = tokenKey(accessToken);
  const hit = userCache.get(key);
  if (hit && hit.expires > Date.now()) return { user: hit.user };
  const { data, error } = await createAuthClient().auth.getUser(accessToken);
  if (error) {
    if (isNetworkError(error) || error.status >= 500) throw E.supabaseUnavailable();
    return { user: null };
  }
  if (userCache.size > 2000) userCache.clear();
  userCache.set(key, { user: data.user, expires: Date.now() + USER_CACHE_MS });
  return { user: data.user };
}

// Single-flight refresh: the dashboard fires several requests at once, and all of
// them may notice the expired access token together. Only one refresh call is made.
const inflightRefresh = new Map();

async function doRefresh(refreshToken) {
  const { data, error } = await createAuthClient().auth.refreshSession({ refresh_token: refreshToken });
  if (error) {
    if (isNetworkError(error) || error.status >= 500) throw E.supabaseUnavailable();
    return null;
  }
  return data.session;
}

function refresh(refreshToken) {
  const key = tokenKey(refreshToken);
  if (!inflightRefresh.has(key)) {
    const p = doRefresh(refreshToken);
    inflightRefresh.set(key, p);
    p.finally(() => setTimeout(() => inflightRefresh.delete(key), 10_000)).catch(() => {});
  }
  return inflightRefresh.get(key);
}

async function loadProfile(db, userId) {
  const { data, error } = await db.from('user_access_profiles').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw fromSupabase(error);
  return data;
}

/**
 * Resolves the Supabase session from cookies, refreshing it when the access
 * token has expired, then verifies email + ACTIVE profile.
 * Sets req.auth = { user, profile, db, accessToken }.
 */
function requireAuth() {
  return async function requireAuthMiddleware(req, res, next) {
    try {
      const { accessToken, refreshToken, remember } = readSessionCookies(req);
      if (!accessToken && !refreshToken) throw E.sessionMissing();

      let token = accessToken;
      let user = null;
      if (token) ({ user } = await getUserForToken(token));
      if (!user && refreshToken) {
        const session = await refresh(refreshToken);
        if (session) {
          setSessionCookies(res, session, remember);
          token = session.access_token;
          user = session.user;
        }
      }
      if (!user) {
        clearSessionCookies(res);
        throw E.sessionExpired();
      }
      if (!user.email_confirmed_at) {
        clearSessionCookies(res);
        throw E.emailNotVerified();
      }

      const db = createUserClient(token);
      const profile = await loadProfile(db, user.id);
      if (!profile || profile.status !== 'ACTIVE') {
        clearSessionCookies(res);
        throw E.accountStatus(profile?.status || 'NO_PROFILE');
      }

      req.auth = { user, profile, db, accessToken: token };
      next();
    } catch (err) {
      next(err);
    }
  };
}

function requireRole(...roles) {
  return function requireRoleMiddleware(req, _res, next) {
    if (!req.auth) return next(E.sessionMissing());
    if (!roles.includes(req.auth.profile.role)) return next(E.forbidden());
    next();
  };
}

function forgetToken(token) {
  if (token) userCache.delete(tokenKey(token));
}

module.exports = { requireAuth, requireRole, loadProfile, forgetToken };
