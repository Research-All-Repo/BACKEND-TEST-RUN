'use strict';
const express = require('express');
const { logError, recentErrors } = require('../lib/error-log');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

/** POST /api/errors - a signed-in browser reports a JavaScript error (message/stack/page only). */
router.post('/', async (req, res) => {
  const b = req.body || {};
  if (typeof b.message === 'string' && b.message.trim()) {
    await logError({ source: 'BROWSER', message: b.message, detail: typeof b.detail === 'string' ? b.detail : null,
      path: typeof b.path === 'string' ? b.path : null, userId: req.auth?.user?.id, userAgent: req.get('user-agent') });
  }
  res.status(202).json({ data: { received: true } });
});

/** GET /api/errors - the 50 most recent server and browser errors (Administrators). */
router.get('/', requireRole('ADMIN'), async (_req, res, next) => {
  try { res.json({ data: await recentErrors(50) }); } catch (err) {
    if (err?.code === '42P01' || /app_error_log/.test(err?.message || '')) return res.json({ data: [], meta: { installed: false } });
    next(err);
  }
});

module.exports = router;
