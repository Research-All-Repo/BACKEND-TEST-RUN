'use strict';
const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const push = require('../lib/push');
const { E } = require('../lib/errors');
const { requireRole } = require('../middleware/auth');
const { getAdminClient } = require('../lib/supabase');
const { waitUntil } = require('@vercel/functions');
const { evaluateAndNotify } = require('../services/risk-push');
const { checkStaleAndNotify } = require('../services/stale-push');

/** Signed-in routes: a device registers / removes its push subscription. */
const router = express.Router();

router.get('/public-key', (_req, res) => res.json({ data: { enabled: push.enabled(), public_key: config.push.publicKey || null } }));

router.post('/subscribe', async (req, res, next) => {
  try {
    if (!push.enabled()) throw E.validation('Instant phone alerts are not configured on the server yet (VAPID keys missing).');
    await push.saveSubscription(req.auth.user.id, req.body?.subscription, req.get('user-agent'));
    res.status(201).json({ data: { subscribed: true } });
  } catch (err) {
    next(err.code ? err : E.validation(err.message));
  }
});

/**
 * POST /api/push/test-me { endpoint, delay_seconds } - sends a test notification to THIS device only,
 * after a short delay so the user can close AquaCast or lock the phone first.
 */
router.post('/test-me', async (req, res, next) => {
  try {
    const endpoint = String(req.body?.endpoint || '');
    if (!/^https:\/\//.test(endpoint)) throw E.validation('This device is not registered for instant alerts yet.');
    const delay = Math.max(0, Math.min(15, Number(req.body?.delay_seconds) || 0));
    if (!push.enabled()) return res.json({ data: { disabled: true } });
    if (!(await push.hasSubscription(endpoint, req.auth.user.id))) return res.json({ data: { not_registered: true } });
    // Answer straight away: the phone closes AquaCast during the wait, which would cut a long request
    // ("server cannot be reached"). The send runs after the response; waitUntil keeps the Vercel
    // function alive for it (on a normal server the promise simply runs).
    const job = new Promise((r) => setTimeout(r, delay * 1000))
      .then(() => push.sendToEndpoint(endpoint, req.auth.user.id, {
        level: 'CRITICAL', test: true, tag: 'aquacast-device-test', url: '/#live',
        title: 'TEST: AquaCast alert on this phone', body: 'If you can read this with AquaCast closed, Warning and Critical alerts will reach this phone.',
      }))
      .catch((e) => console.warn('[push] device test failed:', e.message));
    waitUntil(job);
    res.status(202).json({ data: { scheduled: true, delay_seconds: delay } });
  } catch (err) { next(err); }
});

/** GET /api/push/diagnostics (ADMIN) - every link of the phone-alert chain in one view. */
router.get('/diagnostics', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const db = getAdminClient();
    const [subs, beat, recent] = await Promise.all([
      push.listSubscriptions().catch(() => []),
      db.from('dashboard_settings').select('value, updated_at').eq('setting_key', 'background_check').maybeSingle().then((r) => r.data).catch(() => null),
      db.from('dashboard_audit_log').select('action, created_at, details').in('action', ['PUSH_RISK_SENT', 'ALERT_TEST_BROADCAST', 'PUSH_STALE_SENT'])
        .order('created_at', { ascending: false }).limit(8).then((r) => r.data || []),
    ]);
    res.json({ data: {
      vapid_configured: push.enabled(),
      hook_secret_configured: !!config.push.hookSecret,
      simulator_enabled: !!config.mockEdge?.enabled,
      background_check: beat ? { at: beat.updated_at, ...beat.value } : null,
      subscriptions: subs,
      recent_pushes: recent,
    } });
  } catch (err) { next(err); }
});

router.post('/unsubscribe', async (req, res, next) => {
  try {
    if (req.body?.endpoint) await push.removeSubscription(String(req.body.endpoint));
    res.json({ data: { subscribed: false } });
  } catch (err) { next(err); }
});

/**
 * POST /api/push/risk-hook  (Supabase Database Webhook on risk_assessments INSERT)
 * Header x-aquacast-hook-secret must equal PUSH_HOOK_SECRET. No session, no CSRF header
 * (it is called server-to-server by Supabase). It only re-reads the latest risk from the
 * database and decides; the request body is ignored, so it cannot inject alerts.
 */
function hookSecretOk(req) {
  const given = String(req.get('x-aquacast-hook-secret') || '');
  const want = config.push.hookSecret;
  return !!want && given.length === want.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want));
}

async function riskHook(req, res, next) {
  try {
    if (!hookSecretOk(req)) throw E.forbidden();
    const risk = await evaluateAndNotify();
    const stale = await checkStaleAndNotify().catch((e) => ({ error: e.message })); // "readings are back"
    res.json({ data: { ...risk, stale } });
  } catch (err) { next(err); }
}

/**
 * POST /api/push/stale-check  (Supabase pg_cron every 5 min, migration 005; same secret header)
 * Sends one "no new readings" alert per outage and one "readings are back" alert after it.
 */
async function staleHook(req, res, next) {
  try {
    if (!hookSecretOk(req)) throw E.forbidden();
    // Simulator on Vercel only moves forward on requests. Running it here every 5 minutes means
    // simulated readings (and their Warning / Critical phone alerts) keep coming while every app is closed.
    let simulator = null;
    const edge = req.app.locals.mockEdge;
    if (edge?.tick) {
      try { await edge.tick(); simulator = 'ticked'; } catch (e) { simulator = `error: ${e.message}`; }
    }
    const result = await checkStaleAndNotify();
    // heartbeat for the diagnostics panel: proves Supabase's 5-minute job reaches the server
    await getAdminClient().from('dashboard_settings').upsert({ setting_key: 'background_check', updated_at: new Date().toISOString(),
      value: { simulator, result: result.sent ? 'no-data alert sent' : result.recovered ? 'readings-back alert sent' : (result.skipped || 'ok') } }, { onConflict: 'setting_key' })
      .then(() => null, () => null);
    res.json({ data: { ...result, simulator } });
  } catch (err) { next(err); }
}

module.exports = { router, riskHook, staleHook };
