'use strict';
const express = require('express');
const { unwrap, E, fromSupabase } = require('../lib/errors');
const { parseRange, parsePage, assertUuid, sanitizeText, ruleReference } = require('../lib/helpers');
const { requireRole } = require('../middleware/auth');
const { getAdminClient } = require('../lib/supabase');

const router = express.Router();

/**
 * GET /api/alerts?status=active|acknowledged|all&from=&to=&page=
 * Alerts are the cycles where the official risk state changed into
 * WATCH / WARNING / CRITICAL (view public.risk_alerts). "active" = not yet
 * acknowledged and within the last 24 hours.
 */
router.get('/', async (req, res, next) => {
  try {
    const { db } = req.auth;
    const status = String(req.query.status || 'active');
    if (!['active', 'acknowledged', 'all'].includes(status)) throw E.validation('status must be active, acknowledged or all.');
    const range = status === 'active' && !req.query.from && !req.query.range
      ? parseRange({ range: '24h' }) : parseRange(req.query, { defaultHours: 24 * 7, maxDays: 92 });
    const { page, pageSize, offset } = parsePage(req.query, { defaultSize: 20, maxSize: 100 });
    let q = db.from('risk_alerts').select('*', { count: 'exact' })
      .gte('observation_timestamp_utc', range.from).lt('observation_timestamp_utc', range.to);
    if (status === 'active') q = q.is('acknowledged_at', null);
    if (status === 'acknowledged') q = q.not('acknowledged_at', 'is', null);
    const { data, error, count } = await q.order('observation_timestamp_utc', { ascending: false }).range(offset, offset + pageSize - 1);
    if (error) throw fromSupabase(error);
    const alerts = data.map((a) => ({ ...a, guidance: guidance(a.current_risk_state), rule_reference: ruleReference(a.rule_version) }));
    const highest = alerts.reduce((m, a) => Math.max(m, a.severity_rank), 0);
    res.json({ data: alerts, meta: { ...range, status, page, page_size: pageSize, total: count ?? null,
      highest_severity: ['NONE', 'WATCH', 'WARNING', 'CRITICAL'][highest] } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/alerts/test-broadcast (ADMIN) { level: "WARNING" | "CRITICAL" }
 * Every signed-in dashboard (phones included) picks this up on its next /api/live
 * refresh (within ~1 minute) and plays the alert sound / shows the notification,
 * clearly marked TEST. No observation or risk data is created or changed.
 */
router.post('/test-broadcast', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const level = String(req.body?.level || 'CRITICAL').toUpperCase();
    if (!['WARNING', 'CRITICAL'].includes(level)) throw E.validation('level must be WARNING or CRITICAL.');
    const sentBy = req.auth.profile.full_name || req.auth.user.email;
    const { data, error } = await getAdminClient().from('dashboard_audit_log').insert({
      actor_user_id: req.auth.user.id, action: 'ALERT_TEST_BROADCAST', target_table: 'dashboard', target_id: 'test-alert',
      details: { level, sent_by: sentBy, note: 'Test of the alert sound and notification on all signed-in devices' },
    }).select('audit_id, created_at').single();
    if (error) throw fromSupabase(error);
    res.status(201).json({ data: { id: data.audit_id, level, sent_at: data.created_at },
      meta: { message: `Test ${level} alert sent. Open dashboards receive it within about a minute.` } });
  } catch (err) {
    next(err);
  }
});

/** POST /api/alerts/:riskId/acknowledge { note? } - records who reviewed the alert (audit log). */
router.post('/:riskId/acknowledge', async (req, res, next) => {
  try {
    const { db } = req.auth;
    const id = assertUuid(req.params.riskId, 'riskId');
    const row = unwrap(await db.rpc('acknowledge_alert', { p_risk_id: id, p_note: sanitizeText(req.body?.note, 500) }));
    res.status(201).json({ data: { risk_id: id, acknowledged_at: row.created_at, note: row.details?.note || null },
      meta: { note: 'Acknowledgement confirms an operator reviewed the alert; it does not mean the pond condition is resolved.' } });
  } catch (err) {
    next(err);
  }
});

function guidance(state) {
  switch (state) {
    case 'CRITICAL': return { title: 'Immediate operator review', steps: [
      'Confirm the current DO reading and check for sensor or data-quality issues.',
      'Inspect current pond conditions and review recent management activities.',
      'Determine the operator response. Manual aeration remains operator-initiated from Live Status.'] };
    case 'WARNING': return { title: 'Prepare for operator response', steps: [
      'Verify the current DO reading and review the forecast progression.',
      'Check the projected timing of any critical threshold crossing.',
      'Select the appropriate management response.'] };
    case 'WATCH': return { title: 'Increase observation', steps: [
      'Monitor the next forecast cycles more closely.',
      'Review the horizon where DO first enters the suboptimal range.',
      'Check recent feeding, aeration, water exchange or maintenance records.'] };
    default: return { title: 'Continue routine monitoring', steps: [] };
  }
}

module.exports = router;
