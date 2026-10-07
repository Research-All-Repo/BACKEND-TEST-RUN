'use strict';
const config = require('../config');

// Tokens live only in httpOnly cookies: page JavaScript can never read them.
const ACCESS_COOKIE = 'aq_at';
const REFRESH_COOKIE = 'aq_rt';
const REMEMBER_COOKIE = 'aq_rm';

function cookieBase() {
  return { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/' };
}

/** Store a Supabase session. remember=false -> browser-session cookies only. */
function setSessionCookies(res, session, remember) {
  const base = cookieBase();
  const maxAge = remember ? config.rememberMeDays * 24 * 3600 * 1000 : undefined;
  res.cookie(ACCESS_COOKIE, session.access_token, { ...base, ...(maxAge ? { maxAge } : {}) });
  res.cookie(REFRESH_COOKIE, session.refresh_token, { ...base, path: '/api', ...(maxAge ? { maxAge } : {}) });
  res.cookie(REMEMBER_COOKIE, remember ? '1' : '0', { ...base, ...(maxAge ? { maxAge } : {}) });
}

function clearSessionCookies(res) {
  const base = cookieBase();
  res.clearCookie(ACCESS_COOKIE, base);
  res.clearCookie(REFRESH_COOKIE, { ...base, path: '/api' });
  res.clearCookie(REMEMBER_COOKIE, base);
}

function readSessionCookies(req) {
  return {
    accessToken: req.cookies?.[ACCESS_COOKIE] || null,
    refreshToken: req.cookies?.[REFRESH_COOKIE] || null,
    remember: req.cookies?.[REMEMBER_COOKIE] === '1',
  };
}

module.exports = { setSessionCookies, clearSessionCookies, readSessionCookies };
