'use strict';
const express = require('express');
const S = require('../services/dashboard');
const { classifyFreshness, ruleReference } = require('../lib/helpers');

const router = express.Router();

/**
 * GET /api/live
 * Everything the Live Status page needs in one request:
 * latest observation (7 variables + quality flags), official risk, the four
 * forecasts of that cycle, DO trend, system health, aerator status, alert count,
 * and a freshness block (LIVE / SYNC_DELAYED / OFFLINE / NO_DATA).
 */
router.get('/', async (req, res, next) => {
  try {
    const { db } = req.auth;
    const [obs, health, aerator, activeAlerts, study, testAlert] = await Promise.all([
      S.getLatestObservation(db), S.getLatestHealth(db), S.getAeratorSummary(db), S.countActiveAlerts(db), S.getStudy(db), S.getTestAlert(db),
    ]);
    const freshness = classifyFreshness(obs?.timestamp_utc || null, health);
    if (!obs) {
      return res.json({
        data: { observation: null, risk: null, forecasts: S.HORIZONS.map((h) => ({ horizon_minutes: h, forecast_status: 'NOT_GENERATED', predicted_do_mg_l: null })),
          trend: null, system_health: health ? { ...health, matches_latest_observation: false } : null, aerator, active_alerts: activeAlerts,
          rule_reference: ruleReference(), station: stationInfo(study), test_alert: testAlert },
        meta: { freshness, generated_at: new Date().toISOString() },
      });
    }
    const [forecasts, risk, trend] = await Promise.all([
      S.getForecastsForObservation(db, obs.observation_id),
      S.getRiskForObservation(db, obs.observation_id),
      S.getDoTrend(db, obs.timestamp_utc),
    ]);
    const critical = forecasts.find((f) => f.forecast_status === 'VALID' && ruleReference(risk?.rule_version).critical_do_mg_l !== null
      && f.predicted_do_mg_l <= ruleReference(risk?.rule_version).critical_do_mg_l);

    res.json({
      data: {
        observation: S.shapeObservation(obs),
        risk: risk ? { ...risk, available: true } : { available: false, current_risk_state: 'DATA_UNAVAILABLE',
          message: 'No official risk assessment has been synced for this observation cycle yet.' },
        forecasts,
        critical_outlook: risk?.forecast_outlook === 'CROSSING_EXPECTED'
          ? { crossing_expected: true, expected_threshold_crossing_utc: risk.expected_threshold_crossing_utc, first_horizon_minutes: critical?.horizon_minutes ?? null }
          : { crossing_expected: false, forecast_outlook: risk?.forecast_outlook || 'DATA_UNAVAILABLE' },
        trend,
        system_health: health ? { ...health, matches_latest_observation: health.observation_id === obs.observation_id } : null,
        aerator,
        active_alerts: activeAlerts,
        rule_reference: ruleReference(risk?.rule_version),
        station: stationInfo(study),
        test_alert: testAlert, // admin-sent test of the alert sound/notification path; not a real reading
      },
      meta: { freshness, generated_at: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

function stationInfo(study) {
  if (!study) return null;
  return { site_description: study.site_description, culture_species: study.culture_species, culture_stage: study.culture_stage,
    culture_system: study.culture_system, timezone: study.timezone, sampling_interval_min: study.sampling_interval_min };
}

module.exports = router;
