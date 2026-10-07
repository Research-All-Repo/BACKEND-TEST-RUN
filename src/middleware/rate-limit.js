'use strict';
const { E } = require('../lib/errors');

/**
 * Small in-memory fixed-window limiter for auth endpoints. Good enough for a
 * single Render instance; use a shared store (e.g. Redis) if you scale out.
 */
function rateLimit({ windowMs, max, key }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, Math.min(windowMs, 60_000)).unref();

  return function rateLimitMiddleware(req, res, next) {
    const k = key(req);
    const now = Date.now();
    let entry = hits.get(k);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(k, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      const retry = Math.ceil((entry.reset - now) / 1000);
      res.set('Retry-After', String(retry));
      return next(E.rateLimited(retry));
    }
    next();
  };
}

module.exports = { rateLimit };
