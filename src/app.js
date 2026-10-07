'use strict';
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const config = require('./config');
const { ApiError, E } = require('./lib/errors');
const { requireAuth, requireRole } = require('./middleware/auth');

/**
 * Builds the Express app without listening, so the same app can run on
 * Render (src/server.js) or be wrapped as a Vercel function (api/index.js).
 */
function createApp({ mockEdge = null } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        'img-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
        'frame-ancestors': ["'none'"],
        'upgrade-insecure-requests': config.isProduction ? [] : null,
      },
    },
  }));
  app.use(express.json({ limit: '64kb' }));
  app.use(cookieParser());

  // Liveness probe for Render (no auth, no database secrets)
  app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'aquacast-backend', time: new Date().toISOString() }));

  // CSRF defence for cookie sessions: state-changing API calls must carry a custom
  // header (browsers cannot add it cross-site without CORS, which is not enabled)
  // and, when present, an Origin matching this host.
  app.use('/api', (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('X-AquaCast-Client') !== 'dashboard') return next(new ApiError(403, 'CSRF_REJECTED', 'Missing dashboard request header.'));
    const origin = req.get('Origin');
    if (origin) {
      let host = null;
      try { host = new URL(origin).host; } catch { /* invalid origin */ }
      if (host !== req.get('host')) return next(new ApiError(403, 'CSRF_REJECTED', 'Cross-site request rejected.'));
    }
    next();
  });
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  // Public (no session)
  app.use('/api/auth', require('./routes/auth'));

  // Every route below requires a verified email + ACTIVE profile
  const authed = requireAuth();
  const admin = requireRole('ADMIN');
  app.use('/api/live', authed, require('./routes/live'));
  app.use('/api/forecast', authed, require('./routes/forecast'));
  app.use('/api/history', authed, require('./routes/history'));
  app.use('/api/sensors', authed, require('./routes/sensors'));
  app.use('/api/activities', authed, require('./routes/activities'));
  app.use('/api/alerts', authed, require('./routes/alerts'));
  app.use('/api/aerator', authed, require('./routes/aerator'));
  app.use('/api/settings', authed, admin, require('./routes/settings'));
  app.use('/api/evaluation', authed, admin, require('./routes/evaluation'));
  app.use('/api/users', authed, admin, require('./routes/users'));
  if (mockEdge) app.use('/api/dev/mock-edge', authed, admin, require('./routes/dev')(mockEdge));

  app.use('/api', (_req, _res, next) => next(E.notFound('Unknown API route.')));

  // Placeholder frontend (replace with the real frontend build later)
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'], index: 'index.html' }));

  // Error handler: consistent JSON, no stack traces or secrets to the client
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err?.type === 'entity.parse.failed') err = E.validation('Request body is not valid JSON.');
    const apiErr = err instanceof ApiError ? err : null;
    if (!apiErr) console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`, err?.stack || err);
    else if (apiErr.status >= 500) console.warn(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${apiErr.code}`);
    const status = apiErr ? apiErr.status : 500;
    res.status(status).json({ error: {
      code: apiErr ? apiErr.code : 'INTERNAL_ERROR',
      message: apiErr ? apiErr.message : 'Something went wrong on the AquaCast server.',
      ...(apiErr?.details ? { details: apiErr.details } : {}),
    } });
  });

  return app;
}

module.exports = { createApp };
