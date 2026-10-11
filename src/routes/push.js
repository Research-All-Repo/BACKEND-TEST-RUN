'use strict';
const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const push = require('../lib/push');
const { E } = require('../lib/errors');
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
    res.json({ data: await checkStaleAndNotify() });
  } catch (err) { next(err); }
}

module.exports = { router, riskHook, staleHook };
