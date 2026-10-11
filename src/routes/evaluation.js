'use strict';
const express = require('express');
const { unwrap, E } = require('../lib/errors');
const { parseRange } = require('../lib/helpers');
const { getAdminClient } = require('../lib/supabase');
const { loadWarningPerformance } = require('../services/warning-eval');

const router = express.Router();

/**
 * GET /api/evaluation  (ADMIN)
 * Registered forecast models + operational accuracy per horizon, computed from
 * VALID forecasts matched to the VALID observation at their target time.
 * These are live operational metrics from whatever data is in the database.
 * With mock data they are NOT thesis results.
 */
router.get('/', async (req, res, next) => {
  try {
    const { db } = req.auth;
    const [models, metrics, sample] = await Promise.all([
      db.from('forecast_models').select('*').order('forecast_horizon_min').order('created_at_utc', { ascending: false }).then(unwrap),
      db.from('forecast_evaluation').select('*').order('horizon_minutes').then(unwrap),
      db.from('raw_observations').select('timestamp_utc').order('timestamp_utc').limit(1).maybeSingle().then(unwrap),
    ]);
    const horizons = [30, 60, 90, 120].map((h) => {
      const m = metrics.find((x) => x.horizon_minutes === h);
      const deployed = models.find((x) => x.forecast_horizon_min === h && x.deployment_status === 'DEPLOYED');
      return {
        horizon_minutes: h,
        lead_steps: h / 10,
        deployed_model: deployed ? { model_id: deployed.model_id, model_name: deployed.model_name, version: deployed.version, algorithm: deployed.algorithm } : null,
        samples: m?.samples || 0,
        mae: m?.mae ?? null,
        rmse: m?.rmse ?? null,
        r2: m?.r2 ?? null,
        mean_bias: m?.mean_bias ?? null,
        status: m?.samples ? 'OPERATIONAL_METRICS_AVAILABLE' : 'NO_MATCHED_SAMPLES',
      };
    });
    res.json({
      data: { models, horizons, data_since_utc: sample?.timestamp_utc || null },
      meta: {
        basis: 'Stored VALID forecasts vs the VALID observed DO at each target timestamp (view public.forecast_evaluation).',
        caution: 'Operational monitoring metrics only. The thesis evaluation must use the finalized held-out dataset; do not report these numbers as model accuracy when the data are simulated.',
      },
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/evaluation/series?horizon=60&from=&to= - actual vs predicted pairs for one horizon (max 7 days). */
router.get('/series', async (req, res, next) => {
  try {
    const { db } = req.auth;
    const horizon = Number(req.query.horizon || 60);
    if (![30, 60, 90, 120].includes(horizon)) throw E.validation('horizon must be 30, 60, 90 or 120.');
    const { from, to } = parseRange(req.query, { defaultHours: 48, maxDays: 7 });
    const fc = unwrap(await db.from('forecasts').select('target_timestamp_utc, predicted_do_mg_l')
      .eq('horizon_minutes', horizon).eq('forecast_status', 'VALID').gte('target_timestamp_utc', from).lt('target_timestamp_utc', to)
      .order('target_timestamp_utc').limit(1100));
    const obs = unwrap(await db.from('raw_observations').select('timestamp_utc, do_mg_l').eq('do_mg_l_status', 'VALID')
      .gte('timestamp_utc', from).lt('timestamp_utc', to).limit(1100));
    const actual = new Map(obs.map((o) => [new Date(o.timestamp_utc).getTime(), o.do_mg_l]));
    const points = fc.map((f) => ({ target_timestamp_utc: f.target_timestamp_utc, predicted: f.predicted_do_mg_l,
      observed: actual.get(new Date(f.target_timestamp_utc).getTime()) ?? null })).filter((p) => p.observed !== null);
    res.json({ data: { horizon_minutes: horizon, points }, meta: { from, to, count: points.length } });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/evaluation/warning-performance?days=7  (max 31)
 * Early-warning lead time, missed events, false alarms, "no change" baseline, operator response
 * times and phone delivery, from the system's own logs. Definitions in src/services/warning-eval.js.
 */
router.get('/warning-performance', async (req, res, next) => {
  try {
    const days = Math.min(31, Math.max(1, Number(req.query.days) || 7));
    const to = new Date().toISOString();
    const from = new Date(Date.now() - days * 86400_000).toISOString();
    const data = await loadWarningPerformance(getAdminClient(), { from, to });
    res.json({ data: { ...data, days }, meta: { from, to,
      definitions: {
        critical_event: 'Observed DO at or below the critical threshold after at least 30 minutes above it.',
        early_warning: 'The forecast predicted DO would cross the critical threshold while it was still above it (one per continuous prediction period).',
        detected: 'An early warning was active within 130 minutes (the 120-minute forecast window + 10) before the event started.',
        lead_time: 'Minutes from the start of that early warning to the start of the critical event.',
        false_alarm: 'An early warning not followed by a critical event within 130 minutes, and with no aeration or recorded action within 120 minutes. Warnings that were acted on are counted separately: the action may have prevented the event.',
        skill: 'Forecast error compared with simply assuming DO stays the same (no-change baseline), on the same readings. Skill above 0 means the model adds value; 0.30 means 30% smaller error.',
      },
      caution: 'Computed from the data in the database. With the simulator on these describe simulated data, not the thesis results.' } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
