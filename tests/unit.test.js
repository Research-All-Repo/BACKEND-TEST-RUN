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
