'use strict';
const express = require('express');
const S = require('../services/dashboard');
const { unwrap, E } = require('../lib/errors');
const { classifyFreshness, ruleReference, parseRange, assertUuid } = require('../lib/helpers');

const router = express.Router();

/**
 * GET /api/forecast/latest
 * The latest cycle's +30/+60/+90/+120 min forecasts and the official risk
 * assessment built from them. Optional ?observation_id= to open an older cycle.
 */
router.get('/latest', async (req, res, next) => {
  try {
    const { db } = req.auth;
    const health = await S.getLatestHealth(db);
    let obs;
    if (req.query.observation_id) {
      const id = assertUuid(req.query.observation_id, 'observation_id');
      obs = unwrap(await db.from('raw_observations').select('*').eq('observation_id', id).maybeSingle());
      if (!obs) throw E.notFound('Observation not found.');
    } else {
      obs = await S.getLatestObservation(db);
    }
    const latestTs = req.query.observation_id ? (await S.getLatestObservation(db))?.timestamp_utc : obs?.timestamp_utc;
    const freshness = classifyFreshness(latestTs || null, health);
    if (!obs) return res.json({ data: null, meta: { freshness } });

    const [forecasts, risk] = await Promise.all([S.getForecastsForObservation(db, obs.observation_id), S.getRiskForObservation(db, obs.observation_id)]);
    const rule = ruleReference(risk?.rule_version);
    const origin = obs.do_mg_l_status === 'VALID' ? obs.do_mg_l : null;
    const horizons = forecasts.map((f) => ({
      ...f,
      change_from_origin_mg_l: f.forecast_status === 'VALID' && origin !== null ? round(f.predicted_do_mg_l - origin, 3) : null,
      threshold_status: thresholdStatus(f, rule),
    }));
    const valid = horizons.filter((h) => h.forecast_status === 'VALID');
    const last = horizons.find((h) => h.horizon_minutes === 120);

    res.json({
      data: {
        origin: { observation_id: obs.observation_id, forecast_origin_utc: obs.timestamp_utc, do_mg_l: obs.do_mg_l, do_mg_l_status: obs.do_mg_l_status },
        horizons,
        summary: {
          valid_horizons: valid.length,
          earliest_critical_horizon_minutes: valid.find((h) => h.threshold_status === 'AT_OR_BELOW_CRITICAL')?.horizon_minutes ?? null,
          earliest_suboptimal_horizon_minutes: valid.find((h) => h.threshold_status !== 'ABOVE_WATCH_BOUNDARY')?.horizon_minutes ?? null,
          projected_change_120_mg_l: last?.change_from_origin_mg_l ?? null,
        },
        risk: risk || { current_risk_state: 'DATA_UNAVAILABLE', forecast_outlook: 'DATA_UNAVAILABLE', available: false,
          message: 'No official risk assessment exists for this cycle.' },
        rule_reference: rule,
      },
      meta: { freshness, generated_at: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/forecast/history?from=&to=&horizon=60
 * Forecast vs the observation actually measured at the target time
 * (for "how did the forecasts do" charts). Max 7 days per request.
 */
router.get('/history', async (req, res, next) => {
  try {
    const { db } = req.auth;
    const { from, to } = parseRange(req.query, { defaultHours: 24, maxDays: 7 });
    const horizon = Number(req.query.horizon || 60);
    if (!S.HORIZONS.includes(horizon)) throw E.validation('horizon must be 30, 60, 90 or 120.');
    const fc = unwrap(await db.from('forecast_details')
      .select('forecast_id, forecast_origin_utc, target_timestamp_utc, predicted_do_mg_l, forecast_status, model_version')
      .eq('horizon_minutes', horizon).gte('target_timestamp_utc', from).lt('target_timestamp_utc', to)
      .order('target_timestamp_utc').limit(1100));
    const obs = unwrap(await db.from('raw_observations').select('timestamp_utc, do_mg_l, do_mg_l_status')
      .gte('timestamp_utc', from).lt('timestamp_utc', to).order('timestamp_utc').limit(1100));
    const actual = new Map(obs.map((o) => [new Date(o.timestamp_utc).getTime(), o]));
    const points = fc.map((f) => {
      const a = actual.get(new Date(f.target_timestamp_utc).getTime());
      return { ...f, observed_do_mg_l: a && a.do_mg_l_status === 'VALID' ? a.do_mg_l : null,
        error_mg_l: a && a.do_mg_l_status === 'VALID' && f.forecast_status === 'VALID' ? round(f.predicted_do_mg_l - a.do_mg_l, 3) : null };
    });
    res.json({ data: { horizon_minutes: horizon, from, to, points }, meta: { count: points.length } });
  } catch (err) {
    next(err);
  }
});

function thresholdStatus(f, rule) {
  if (f.forecast_status !== 'VALID' || f.predicted_do_mg_l === null) return 'DATA_UNAVAILABLE';
  if (rule.critical_do_mg_l === null) return 'UNKNOWN_RULE';
  if (f.predicted_do_mg_l <= rule.critical_do_mg_l) return 'AT_OR_BELOW_CRITICAL';
  if (f.predicted_do_mg_l < rule.watch_boundary_do_mg_l) return 'SUBOPTIMAL';
  return 'ABOVE_WATCH_BOUNDARY';
}

function round(v, d) { const k = 10 ** d; return Math.round(v * k) / k; }

module.exports = router;
