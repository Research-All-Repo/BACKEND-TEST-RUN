'use strict';
const crypto = require('crypto');
const { E } = require('../lib/errors');
const { getAdminClient } = require('../lib/supabase');

/**
 * Fixed-window limiter for auth endpoints.
 * Counts live in Supabase (public.app_rate_limits, migration 004) so every Vercel instance
 * shares them; the key is hashed so no e-mail or IP is stored. If the table/function is not
 * installed yet (or Supabase is briefly unreachable), it falls back to a per-instance memory
 * counter so sign-in never breaks because of the limiter itself.
 */
function rateLimit({ windowMs, max, key }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, Math.min(windowMs, 60_000)).unref();

  function memoryHit(k) {
    const now = Date.now();
    let entry = hits.get(k);
    if (!entry || entry.reset <= now) { entry = { count: 0, reset: now + windowMs }; hits.set(k, entry); }
    entry.count += 1;
    return { allowed: entry.count <= max, retry: Math.ceil((entry.reset - now) / 1000) };
  }

  async function sharedHit(k) {
    const { data, error } = await getAdminClient().rpc('app_rate_limit_hit', { p_key: k, p_window_seconds: Math.round(windowMs / 1000), p_max: max });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row.allowed !== 'boolean') throw new Error('unexpected rate limit reply');
    return { allowed: row.allowed, retry: row.retry_after };
  }

  return async function rateLimitMiddleware(req, res, next) {
    const k = crypto.createHash('sha256').update(key(req)).digest('hex');
    let r;
    try { r = await sharedHit(k); } catch { r = memoryHit(k); }
    if (!r.allowed) {
      res.set('Retry-After', String(r.retry));
      return next(E.rateLimited(r.retry));
    }
    next();
  };
}

module.exports = { rateLimit };
