'use strict';
const crypto = require('crypto');
const { ApiError } = require('../lib/errors');
const { getAdminClient } = require('../lib/supabase');

/**
 * Fixed-window rate limiter.
 *
 *   shared: true  (default) counts live in Supabase (public.app_rate_limits, migration 004), so every
 *                 Vercel instance shares them. Used for sign-in, writes and expensive actions. If the
 *                 table/function is missing or Supabase is briefly unreachable, it falls back to the
 *                 per-instance memory counter so the limiter itself never breaks the dashboard.
 *   shared: false memory only (per instance, no database call). Used for the general request limit
 *                 that runs on every API call, where an extra database round trip would cost too much.
 *
 * Keys are hashed, so no email, IP address or session token is ever stored.
 * hit(req) can also be called by hand (e.g. only for failed edge-key attempts).
 */
function rateLimit({ windowMs, max, key, shared = true, message = null, skip = null }) {
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

  async function hit(req) {
    const k = crypto.createHash('sha256').update(key(req)).digest('hex');
    if (!shared) return memoryHit(k);
    try { return await sharedHit(k); } catch { return memoryHit(k); }
  }

  const tooMany = (retry) => new ApiError(429, 'RATE_LIMITED', message || 'Too many attempts. Please wait and try again.', { retry_after_seconds: retry });

  async function rateLimitMiddleware(req, res, next) {
    if (skip?.(req)) return next();
    const r = await hit(req);
    res.set('RateLimit-Limit', String(max));
    if (!r.allowed) {
      res.set('Retry-After', String(r.retry));
      return next(tooMany(r.retry));
    }
    next();
  }
  rateLimitMiddleware.hit = hit;
  rateLimitMiddleware.tooMany = tooMany;
  return rateLimitMiddleware;
}

/** Who is asking: the signed-in session if there is one (hashed later), otherwise the IP address. */
function clientKey(req) {
  const session = req.cookies?.aq_at;
  return session ? `s:${crypto.createHash('sha256').update(session).digest('hex').slice(0, 32)}` : `ip:${req.ip}`;
}

module.exports = { rateLimit, clientKey };
