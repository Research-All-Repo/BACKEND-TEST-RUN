'use strict';
const express = require('express');
const S = require('../services/dashboard');
const { unwrap, E } = require('../lib/errors');
const { ruleReference, sanitizeText } = require('../lib/helpers');
const { requireRole } = require('../middleware/auth');
const { getAdminClient } = require('../lib/supabase');
const { getCalibration, setCalibration } = require('../lib/dashboard-settings');

const router = express.Router();

// Only fields that exist in the LS-1.0 tables are exposed. Locked study design
// values (sampling interval, horizons, risk thresholds) are read-only.
const EDITABLE_TEXT = ['site_description', 'culture_species', 'culture_stage', 'culture_system', 'timezone', 'notes'];
const EDITABLE_NUM = ['pond_length_m', 'pond_width_m', 'pond_depth_m', 'probe_depth_m'];

/** GET /api/settings - study_metadata + aerator_control_settings + locked study parameters. */
router.get('/', async (req, res, next) => {
  try {
    const { db } = req.auth;
    const [study, aerator, latestRisk, models] = await Promise.all([
      S.getStudy(db), S.getAeratorSummary(db),
      db.from('risk_assessments').select('rule_version').order('assessment_timestamp_utc', { ascending: false }).limit(1).maybeSingle().then(unwrap),
      db.from('forecast_models').select('forecast_horizon_min, model_name, version, algorithm').eq('deployment_status', 'DEPLOYED').order('forecast_horizon_min').then(unwrap),
    ]);
    res.json({
      data: {
        study: study ? { ...study, editable_fields: [...EDITABLE_TEXT, ...EDITABLE_NUM, 'deployment_end_utc'] } : null,
        aerator,
        locked: {
          sampling_interval_min: study?.sampling_interval_min ?? null,
          forecast_horizons_min: [30, 60, 90, 120],
          deployed_models: models,
          risk_rule: ruleReference(latestRisk?.rule_version),
          note: 'Study guardrails are not editable from the dashboard.',
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/settings/study  (ADMIN) - body contains only the fields to change. */
router.patch('/study', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const { db } = req.auth;
    const study = await S.getStudy(db);
    if (!study) throw E.notFound('No study_metadata row exists yet.');
    const patch = {};
    for (const k of EDITABLE_TEXT) {
      if (req.body?.[k] !== undefined) {
        const v = sanitizeText(req.body[k], k === 'notes' || k === 'site_description' ? 2000 : 200);
        if (!v && k !== 'notes') throw E.validation(`${k} cannot be empty.`);
        patch[k] = v ?? '';
      }
    }
    for (const k of EDITABLE_NUM) {
      if (req.body?.[k] !== undefined) {
        const n = Number(req.body[k]);
        if (!Number.isFinite(n) || n <= 0) throw E.validation(`${k} must be a positive number.`);
        patch[k] = n;
      }
    }
    if (req.body?.deployment_end_utc !== undefined) {
      const v = req.body.deployment_end_utc;
      if (v && Number.isNaN(new Date(v).getTime())) throw E.validation('deployment_end_utc must be an ISO date-time or empty.');
      patch.deployment_end_utc = v ? new Date(v).toISOString() : '';
    }
    if (!Object.keys(patch).length) throw E.validation('Nothing to update.');
    const row = unwrap(await db.rpc('update_study_metadata', { p_study_id: study.study_id, p_patch: patch }));
    res.json({ data: row });
  } catch (err) {
    next(err);
  }
});

/**
 * GET/PUT /api/settings/calibration  (ADMIN)
 * Calibration mode: while the DO probe is being calibrated, readings are labelled
 * "uncalibrated" on every dashboard and no risk / data-stopped phone alerts are sent.
 */
router.get('/calibration', requireRole('ADMIN'), async (_req, res, next) => {
  try { res.json({ data: await getCalibration({ fresh: true }) }); } catch (err) { next(err); }
});
router.put('/calibration', requireRole('ADMIN'), async (req, res, next) => {
  try {
    if (typeof req.body?.enabled !== 'boolean') throw E.validation('enabled must be true or false.');
    const note = sanitizeText(req.body.note || '', 300) || null;
    const { user, profile } = req.auth;
    const hours = req.body.hours === undefined ? undefined : Number(req.body.hours);
    if (hours !== undefined && !(hours >= 0.25 && hours <= 24)) throw E.validation('hours must be between 0.25 and 24.');
    const value = await setCalibration(req.body.enabled, { userId: user.id, byName: profile.full_name || user.email, note, hours });
    await getAdminClient().from('dashboard_audit_log').insert({
      actor_user_id: user.id, action: 'CALIBRATION_MODE_CHANGED', target_table: 'dashboard_settings', target_id: 'calibration_mode',
      details: { enabled: req.body.enabled, note, ...(value.until ? { until: value.until } : {}) },
    });
    res.json({ data: value, meta: { message: req.body.enabled
      ? `Calibration mode is on until ${new Date(value.until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Manila' })}: readings are marked uncalibrated and risk alerts are paused. It switches itself off then.`
      : 'Calibration mode is off: alerts are active again.' } });
  } catch (err) {
    if (/dashboard_settings/.test(err?.message || '')) return next(E.validation('Run migration 004_reliability.sql in Supabase first.'));
    next(err);
  }
});

module.exports = router;
