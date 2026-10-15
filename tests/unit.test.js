'use strict';
// Unit tests: no network needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyFreshness } = require('../src/lib/helpers');
const { fromSupabase } = require('../src/lib/errors');
const G = require('../src/mock/generator');

const now = new Date('2026-10-05T12:00:00Z');
const ago = (m) => new Date(now.getTime() - m * 60000).toISOString();

test('freshness states', () => {
  assert.equal(classifyFreshness(null, null, now).state, 'NO_DATA');
  assert.equal(classifyFreshness(ago(8), { internet_reachable: true }, now).state, 'LIVE');
  assert.equal(classifyFreshness(ago(30), null, now).state, 'SYNC_DELAYED');
  assert.equal(classifyFreshness(ago(90), null, now).state, 'OFFLINE');
  assert.equal(classifyFreshness(ago(5), { internet_reachable: false }, now).state, 'SYNC_DELAYED');
});

test('Supabase errors map to stable API codes', () => {
  assert.equal(fromSupabase({ message: 'TypeError: fetch failed' }).code, 'SUPABASE_UNAVAILABLE');
  assert.equal(fromSupabase({ message: 'AERATOR_NOT_IN_MANUAL_MODE', code: '55000' }).status, 409);
  assert.equal(fromSupabase({ message: 'JWT expired', code: 'PGRST301' }).code, 'SESSION_EXPIRED');
  assert.equal(fromSupabase({ message: 'boom', code: 'XX000' }).code, 'SUPABASE_REQUEST_FAILED');
});

test('risk rules match the frontend decision table', () => {
  const fc = (...v) => v.map((p, i) => ({ forecast_status: p === null ? 'MODEL_ERROR' : 'VALID', predicted_do_mg_l: p, target_timestamp_utc: `t${i}` }));
  assert.equal(G.riskFor(2.9, fc(3, 3, 3, 3)).state, 'CRITICAL');
  assert.equal(G.riskFor(4.2, fc(6, 6, 6, 6)).state, 'WARNING');
  assert.equal(G.riskFor(6.0, fc(6, 5, 4, 2.8)).state, 'WARNING');
  assert.equal(G.riskFor(6.0, fc(6, 5, 4.5, 4)).state, 'WATCH');
  assert.equal(G.riskFor(6.0, fc(6, 5.5, 5.2, 5.0)).state, 'NORMAL');
  assert.equal(G.riskFor(6.0, fc(6, null, 5.2, 5.0)).state, 'DATA_UNAVAILABLE');
  assert.equal(G.riskFor(null, fc(6, 6, 6, 6)).state, 'DATA_UNAVAILABLE');
  const r = G.riskFor(6.0, fc(6, 2.9, 2.5, 2.0));
  assert.equal(r.outlook, 'CROSSING_EXPECTED'); assert.equal(r.crossingUtc, 't1');
});

test('mock cycle is deterministic and internally consistent', () => {
  const models = Object.fromEntries(G.HORIZONS.map((h) => [h, { model_id: `m${h}` }]));
  const a = G.buildCycle(now, { models, deploymentStart: ago(600) });
  const b = G.buildCycle(now, { models, deploymentStart: ago(600) });
  assert.deepEqual(a, b);
  for (const f of a.forecasts) {
    assert.equal(new Date(f.target_timestamp_utc) - new Date(a.obs.timestamp_utc), f.horizon_minutes * 60000);
    assert.ok(new Date(f.generated_at_utc) >= new Date(a.obs.timestamp_utc));
  }
  assert.ok(new Date(a.risk.assessment_timestamp_utc) >= new Date(a.obs.timestamp_utc));
});

// ---------------- early-warning performance ----------------
test('warning performance: lead time, missed event, false alarm, acted-on warning, baseline', () => {
  const { computeWarningMetrics, computeResponse } = require('../src/services/warning-eval');
  const M = 60000; const t0 = Date.UTC(2026, 9, 1, 0, 0);
  const obs = []; const risks = [];
  // 24 h of 10-minute readings at 6 mg/L, with two low periods
  for (let i = 0; i < 144; i += 1) {
    const t = t0 + i * 10 * M;
    const low1 = i >= 30 && i < 34; // 05:00-05:30, warned at 03:20 (100 min ahead)
    const low2 = i >= 100 && i < 103; // 16:40-17:10, never warned -> missed
    obs.push({ t, do: low1 || low2 ? 2.5 : 6 });
    const predicted = (i >= 20 && i < 30) // early warning for event 1
      || (i >= 60 && i < 63) // warning with nothing after it, nobody acted -> false alarm
      || (i >= 120 && i < 122); // warning with nothing after it, but aeration was switched on -> acted on
    risks.push({ t, state: low1 || low2 ? 'CRITICAL' : predicted ? 'WARNING' : 'NORMAL', outlook: predicted ? 'CROSSING_EXPECTED' : 'NO_CROSSING', rule_version: null });
  }
  const m = computeWarningMetrics(obs, risks, [t0 + 125 * 10 * M]);
  assert.equal(m.critical_events, 2);
  assert.equal(m.detected, 1);
  assert.equal(m.missed, 1);
  assert.equal(m.median_lead_minutes, 100);
  assert.equal(m.early_warnings, 3);
  assert.equal(m.not_followed_but_acted_on, 1);
  assert.equal(m.false_alarms, 1);
  const { computeSkill } = require('../src/services/warning-eval');
  const sk = computeSkill([{ t: 0, do: 6 }, { t: 30 * M, do: 5 }], [{ h: 30, t: 30 * M, p: 5.2 }]);
  assert.deepEqual(sk[0], { horizon_minutes: 30, samples: 1, model_mae: 0.2, baseline_mae: 1, skill: 0.8 });
  const r = computeResponse([{ t: t0, acknowledged_at: t0 + 6 * M }, { t: t0 + 60 * M, acknowledged_at: null }], [t0 + 20 * M], t0 + 200 * M);
  assert.equal(r.acknowledged, 1);
  assert.equal(r.median_minutes_to_acknowledge, 6);
  assert.equal(r.acknowledged_within_15_min, 1);
  assert.equal(r.not_acknowledged, 1);
  assert.equal(r.with_action_within_2h, 1);
});

test('edge cycle validation mirrors the database rules', () => {
  const { validateCycle } = require('../src/services/edge-validate');
  const id = () => require('crypto').randomUUID();
  const models = [30, 60, 90, 120].map((h) => ({ model_id: `00000000-0000-4000-8000-0000000000${h === 120 ? '12' : h}`.slice(0, 36), forecast_horizon_min: h }));
  const t0 = '2026-10-05T11:50:00.000Z';
  const plus = (m) => new Date(new Date(t0).getTime() + m * 60000).toISOString();
  const sensors = { do_mg_l: 5.8, do_mg_l_status: 'VALID', do_saturation_pct: 75, do_saturation_status: 'VALID', water_temp_c: 28, water_temp_status: 'VALID',
    ph_value: 7.4, ph_status: 'VALID', light_lux: 100, light_status: 'VALID', air_temp_c: 29, air_temp_status: 'VALID',
    relative_humidity_pct: 80, humidity_status: 'VALID', atmospheric_pressure_hpa: 1010, pressure_status: 'VALID' };
  const make = () => ({
    observation: { observation_id: id(), timestamp_utc: t0, acquisition_started_at_utc: plus(0.05), acquisition_completed_at_utc: plus(0.2), record_status: 'COMPLETE', ...sensors },
    health: { timestamp_utc: plus(0.3), wifi_connected: true, wifi_signal_rssi_dbm: -60, internet_reachable: true, rs485_bus_status: 'OK', i2c_bus_status: 'OK', local_database_operational: true },
    forecasts: models.map((m) => ({ forecast_id: id(), model_id: m.model_id, generated_at_utc: plus(0.4), target_timestamp_utc: plus(m.forecast_horizon_min),
      horizon_minutes: m.forecast_horizon_min, predicted_do_mg_l: 5.5, forecast_status: 'VALID' })),
    risk: { risk_id: id(), assessment_timestamp_utc: plus(0.5), current_risk_state: 'NORMAL', forecast_outlook: 'NO_CROSSING_EXPECTED', expected_threshold_crossing_utc: null, rule_version: 'RISK-RULE-1.0' },
  });
  const check = (c) => validateCycle(c, { models, now: now.getTime() });
  const ok = check(make());
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.rows.obs.sync_status, 'SYNCED');
  assert.equal(ok.rows.forecasts.length, 4);

  const bad = (mut, pattern) => { const c = make(); mut(c); const r = check(c); assert.equal(r.ok, false); assert.match(r.error, pattern); };
  bad((c) => { c.observation.timestamp_utc = '2026-10-05T13:00:00Z'; }, /future/);
  bad((c) => { c.observation.do_mg_l = 25; }, /outside the accepted range/);
  bad((c) => { c.observation.timestamp_utc = '2026-10-05 11:50'; }, /ISO 8601/);
  bad((c) => { c.forecasts[0].target_timestamp_utc = plus(31); }, /reading time \+ 30/);
  bad((c) => { c.forecasts[1].model_id = id(); }, /not registered/);
  bad((c) => { c.forecasts[2].forecast_status = 'MODEL_ERROR'; }, /must be null/);
  bad((c) => { c.risk.forecast_outlook = 'CROSSING_EXPECTED'; }, /expected_threshold_crossing_utc/);
  bad((c) => { c.risk.current_risk_state = 'DANGER'; }, /current_risk_state/);
  const noWifi = make(); noWifi.health.wifi_connected = false;
  assert.equal(check(noWifi).rows.health.wifi_signal_rssi_dbm, null); // RSSI dropped when Wi-Fi is off (database rule)
});
