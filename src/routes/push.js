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
const { escalateUnacknowledged } = require('../services/escalation');
const { sendAlert, confirmReceipt } = require('../services/notify');

/** Signed-in routes: a device registers / removes its push subscription. */
const router = express.Router();

router.get('/public-key', (_req, res) => res.json({ data: { enabled: push.enabled(), public_key: config.push.publicKey || null } }));

router.post('/subscribe', async (req, res, next) => {
  try {
    if (!push.enabled()) throw E.validation('Instant phone alerts are not configured on the server yet (VAPID keys missing).');
    await push.saveSubscription(req.auth.user.id, req.body?.subscription, req.get('user-agent'), req.body?.lang);
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
      .then(() => sendAlert({
        kind: 'TEST', level: 'CRITICAL', test: true, tag: 'aquacast-device-test', url: '/#live', userIds: [req.auth.user.id], endpoint,
        title: 'TEST: AquaCast alert on this phone', body: 'If you can read this with AquaCast closed, Warning and Critical alerts will reach this phone.',
        fil: { title: 'PAGSUBOK: AquaCast alerto sa phone na ito', body: 'Kung nababasa mo ito habang sarado ang AquaCast, matatanggap ng phone na ito ang Babala at Kritikal na alerto.' },
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
    const [subs, beat, recent, coverage, alerts] = await Promise.all([
      push.listSubscriptions().catch(() => []),
      db.from('dashboard_settings').select('value, updated_at').eq('setting_key', 'background_check').maybeSingle().then((r) => r.data, () => null),
      db.from('dashboard_audit_log').select('action, created_at, details').in('action', ['PUSH_RISK_SENT', 'PUSH_RISK_FAILED', 'ALERT_TEST_BROADCAST', 'PUSH_STALE_SENT', 'ALERT_ESCALATED'])
        .order('created_at', { ascending: false }).limit(8).then((r) => r.data || []),
      alertCoverage(db),
      recentAlerts(db),
    ]);
    res.json({ data: {
      vapid_configured: push.enabled() && !push.configError(),
      vapid_error: push.configError(),
      hook_secret_configured: !!config.push.hookSecret,
      simulator_enabled: !!config.mockEdge?.enabled,
      background_check: beat ? { at: beat.updated_at, ...beat.value } : null,
      subscriptions: subs,
      recent_pushes: recent,
      escalate_after_minutes: config.escalateAfterMinutes,
      coverage,
      alerts,
    } });
  } catch (err) { next(err); }
});

/** Who can be reached: registered devices per active user and when a phone last confirmed an alert. */
async function alertCoverage(db) {
  const { data: people } = await db.from('user_access_profiles').select('user_id, full_name, email, role').eq('status', 'ACTIVE').order('full_name');
  const ids = (people || []).map((p) => p.user_id);
  if (!ids.length) return [];
  const [{ data: subs }, confirms] = await Promise.all([
    db.from('push_subscriptions').select('user_id, last_error').in('user_id', ids),
    db.from('alert_deliveries').select('user_id, confirmed_at').eq('status', 'CONFIRMED').in('user_id', ids)
      .gte('confirmed_at', new Date(Date.now() - 14 * 86400_000).toISOString()).order('confirmed_at', { ascending: false }).limit(500),
  ]);
  const lastConfirm = new Map();
  (confirms.data || []).forEach((x) => { if (!lastConfirm.has(x.user_id)) lastConfirm.set(x.user_id, x.confirmed_at); });
  return people.map((p) => {
    const mine = (subs || []).filter((x) => x.user_id === p.user_id);
    return { user_id: p.user_id, name: p.full_name || p.email, role: p.role, devices: mine.length,
      devices_with_errors: mine.filter((x) => x.last_error).length, last_confirmed_at: lastConfirm.get(p.user_id) || null, reachable: mine.length > 0 };
  });
}

/** Last alerts with what happened to each: pushes sent / confirmed by the phone / failed. */
async function recentAlerts(db) {
  const { data: ds, error } = await db.from('alert_dispatches').select('dispatch_id, kind, level, title, created_at').order('created_at', { ascending: false }).limit(8);
  if (error || !ds?.length) return [];
  const { data: rows } = await db.from('alert_deliveries').select('dispatch_id, status').in('dispatch_id', ds.map((d) => d.dispatch_id));
  return ds.map((d) => {
    const mine = (rows || []).filter((r) => r.dispatch_id === d.dispatch_id);
    const count = (st) => mine.filter((r) => st.includes(r.status)).length;
    return { ...d, push_sent: count(['SENT', 'CONFIRMED']), push_confirmed: count(['CONFIRMED']), push_failed: count(['FAILED']) };
  });
}

/** POST /api/push/language { endpoint, lang } - notifications for this device in English ('en') or Filipino ('fil'). */
router.post('/language', async (req, res, next) => {
  try {
    const lang = req.body?.lang === 'fil' ? 'fil' : 'en';
    const endpoint = String(req.body?.endpoint || '');
    const saved = endpoint ? await push.setLanguage(endpoint, req.auth.user.id, lang) : false;
    res.json({ data: { lang, saved } });
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
 * POST /api/push/receipt { id, sig }  (called by the phone's service worker when it shows an alert)
 * No session needed: the id is signed by the server, so only a phone that received that push can
 * confirm it. Confirmations show in diagnostics and in the delivery numbers on Model Evaluation.
 */
async function receiptHook(req, res) {
  try {
    const ok = await confirmReceipt(String(req.body?.id || ''), req.body?.sig);
    res.status(ok ? 204 : 400).end();
  } catch {
    res.status(204).end(); // never make the phone retry; the 5-minute check covers it
  }
}

/**
 * POST /api/push/stale-check  (Supabase pg_cron every 5 min, migration 005; same secret header)
 * The background safety net, run every 5 minutes:
 *   - moves the simulator forward (Vercel has no timers)
 *   - retries a risk alert that reached nobody
 *   - "no new readings" / "readings are back" alerts
 *   - escalates CRITICAL alerts nobody acknowledged
 */
async function staleHook(req, res, next) {
  try {
    if (!hookSecretOk(req)) throw E.forbidden();
    let simulator = null;
    const edge = req.app.locals.mockEdge;
    if (edge?.tick) {
      try { await edge.tick(); simulator = 'ticked'; } catch (e) { simulator = `error: ${e.message}`; }
    }
    const step = (fn) => fn().catch((e) => ({ error: e.message }));
    const risk = await step(evaluateAndNotify);
    const result = await step(checkStaleAndNotify);
    const escalation = await step(escalateUnacknowledged);
    const summary = [result.sent ? 'no-data alert sent' : result.recovered ? 'readings-back alert sent' : (result.skipped || result.error || 'ok')];
    if (risk.sent) summary.push('risk alert sent');
    if (escalation.escalated) summary.push('escalation sent');
    // heartbeat for the diagnostics panel: proves Supabase's 5-minute job reaches the server
    await getAdminClient().from('dashboard_settings').upsert({ setting_key: 'background_check', updated_at: new Date().toISOString(),
      value: { simulator, result: summary.join(' · ') } }, { onConflict: 'setting_key' })
      .then(() => null, () => null);
    res.json({ data: { ...result, simulator, risk, escalation } });
  } catch (err) { next(err); }
}

module.exports = { router, riskHook, staleHook, receiptHook };
