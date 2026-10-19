'use strict';
/**
 * Checks one cycle sent by the Raspberry Pi before anything is written, with the same rules as
 * the database constraints and triggers (001_pd10_core_schema.sql). A cycle that fails here is
 * answered REJECTED with a readable reason, so the Pi can set it aside instead of retrying forever,
 * and nothing half-stored is left behind.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HORIZONS = [30, 60, 90, 120];
const SENSOR_STATUS = ['VALID', 'MISSING', 'COMMUNICATION_ERROR', 'OUT_OF_RANGE', 'CRC_ERROR', 'SENSOR_ERROR'];
const PH_STATUS = ['VALID', 'MISSING', 'COMMUNICATION_ERROR', 'OUT_OF_RANGE', 'SENSOR_ERROR'];
const FUTURE_TOLERANCE_MS = 5 * 60_000; // Pi clock may run a little ahead; more than this is a clock problem

// value column, status column, allowed statuses, check for a VALID value
const SENSORS = [
  ['do_mg_l', 'do_mg_l_status', SENSOR_STATUS, (v) => v >= 0 && v <= 20],
  ['do_saturation_pct', 'do_saturation_status', SENSOR_STATUS, (v) => v >= 0 && v <= 200],
  ['water_temp_c', 'water_temp_status', SENSOR_STATUS, (v) => v >= 0 && v <= 40],
  ['ph_value', 'ph_status', PH_STATUS, (v) => v >= 0 && v <= 14],
  ['light_lux', 'light_status', SENSOR_STATUS, (v) => v >= 0],
  ['air_temp_c', 'air_temp_status', SENSOR_STATUS, (v) => v >= -40 && v <= 125],
  ['relative_humidity_pct', 'humidity_status', SENSOR_STATUS, (v) => v >= 0 && v <= 100],
  ['atmospheric_pressure_hpa', 'pressure_status', SENSOR_STATUS, (v) => v > 0],
];

class Invalid extends Error {}
const fail = (msg) => { throw new Invalid(msg); };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v, name) => { if (v === null || v === undefined) return null; if (!isNum(v)) fail(`${name} must be a number or null`); return v; };
const intOrNull = (v, name) => { const n = numOrNull(v, name); if (n !== null && !Number.isInteger(n)) fail(`${name} must be a whole number`); return n; };
const uuid = (v, name) => { if (!UUID_RE.test(String(v || ''))) fail(`${name} must be a UUID`); return String(v).toLowerCase(); };
const oneOf = (v, list, name) => { if (!list.includes(v)) fail(`${name} must be one of ${list.join(', ')} (got ${JSON.stringify(v)})`); return v; };
const bool = (v, name) => { if (typeof v !== 'boolean') fail(`${name} must be true or false`); return v; };
function time(v, name, { optional = false } = {}) {
  if ((v === null || v === undefined) && optional) return null;
  const d = new Date(typeof v === 'string' ? v : NaN);
  if (typeof v !== 'string' || Number.isNaN(d.getTime()) || !/(Z|[+-]\d{2}:?\d{2})$/.test(v)) fail(`${name} must be an ISO 8601 time with a time zone (e.g. 2026-10-15T02:10:00Z)`);
  return d;
}

function observation(o, now) {
  if (!o || typeof o !== 'object') fail('observation is missing');
  const ts = time(o.timestamp_utc, 'observation.timestamp_utc');
  if (ts.getTime() > now + FUTURE_TOLERANCE_MS) fail(`observation.timestamp_utc ${o.timestamp_utc} is in the future: check the Raspberry Pi clock (RTC / internet time)`);
  const started = time(o.acquisition_started_at_utc, 'observation.acquisition_started_at_utc');
  const completed = time(o.acquisition_completed_at_utc, 'observation.acquisition_completed_at_utc', { optional: true });
  if (completed && completed < started) fail('acquisition_completed_at_utc is before acquisition_started_at_utc');
  const row = {
    observation_id: uuid(o.observation_id, 'observation.observation_id'),
    timestamp_utc: ts.toISOString(),
    acquisition_started_at_utc: started.toISOString(),
    acquisition_completed_at_utc: completed ? completed.toISOString() : null,
    ph_adc_raw: intOrNull(o.ph_adc_raw, 'ph_adc_raw'),
    ph_voltage_mv: numOrNull(o.ph_voltage_mv, 'ph_voltage_mv'),
    record_status: oneOf(o.record_status, ['COMPLETE', 'PARTIAL', 'FAILED'], 'record_status'),
    sync_status: 'SYNCED',
  };
  if (row.ph_voltage_mv !== null && row.ph_voltage_mv < 0) fail('ph_voltage_mv may not be negative');
  for (const [col, statusCol, statuses, ok] of SENSORS) {
    row[col] = numOrNull(o[col], col);
    row[statusCol] = oneOf(o[statusCol], statuses, statusCol);
    if (row[statusCol] === 'VALID' && (row[col] === null || !ok(row[col]))) {
      fail(`${col}=${row[col]} is marked VALID but is missing or outside the accepted range; mark it OUT_OF_RANGE instead`);
    }
  }
  // Values the Pi took from its backup reading (halfway through the previous cycle) because the sensor
  // failed in this reading: { do_mg_l: "2026-10-19T12:05:03Z", ... }. Shown as such in the dashboard.
  const fb = o.filled_from_backup;
  if (fb !== null && fb !== undefined) {
    if (typeof fb !== 'object' || Array.isArray(fb)) fail('filled_from_backup must be an object like {"do_mg_l": "<backup time>"}');
    const out = {};
    for (const [k, v] of Object.entries(fb)) {
      const s = SENSORS.find((x) => x[0] === k);
      if (!s) fail(`filled_from_backup: unknown field ${k}`);
      if (row[s[1]] !== 'VALID') fail(`filled_from_backup.${k}: only a VALID value can come from the backup reading`);
      const bt = time(v, `filled_from_backup.${k}`);
      if (bt >= ts || ts - bt > 15 * 60_000) fail(`filled_from_backup.${k}: the backup reading must be from the 15 minutes before the reading`);
      out[k] = bt.toISOString();
    }
    if (Object.keys(out).length) row.filled_from_backup = out;
  }
  return row;
}

function health(h, obs) {
  if (h === null || h === undefined) return null; // health is optional (1 : 0..1)
  const busStatus = ['OK', 'DEGRADED', 'FAILED'];
  const wifi = bool(h.wifi_connected, 'health.wifi_connected');
  const row = {
    observation_id: obs.observation_id,
    timestamp_utc: time(h.timestamp_utc, 'health.timestamp_utc').toISOString(),
    pi_cpu_temp_c: numOrNull(h.pi_cpu_temp_c, 'pi_cpu_temp_c'),
    pi_uptime_s: intOrNull(h.pi_uptime_s, 'pi_uptime_s'),
    ram_used_pct: numOrNull(h.ram_used_pct, 'ram_used_pct'),
    storage_free_mb: numOrNull(h.storage_free_mb, 'storage_free_mb'),
    wifi_connected: wifi,
    wifi_signal_rssi_dbm: wifi ? numOrNull(h.wifi_signal_rssi_dbm, 'wifi_signal_rssi_dbm') : null,
    internet_reachable: bool(h.internet_reachable, 'health.internet_reachable'),
    last_cloud_sync_at_utc: h.last_cloud_sync_at_utc ? time(h.last_cloud_sync_at_utc, 'last_cloud_sync_at_utc').toISOString() : null,
    battery_voltage_v: numOrNull(h.battery_voltage_v, 'battery_voltage_v'),
    rs485_bus_status: oneOf(h.rs485_bus_status, busStatus, 'rs485_bus_status'),
    i2c_bus_status: oneOf(h.i2c_bus_status, busStatus, 'i2c_bus_status'),
    local_database_operational: bool(h.local_database_operational, 'health.local_database_operational'),
    sync_status: 'SYNCED',
  };
  if (row.pi_uptime_s !== null && row.pi_uptime_s < 0) fail('pi_uptime_s may not be negative');
  if (row.ram_used_pct !== null && (row.ram_used_pct < 0 || row.ram_used_pct > 100)) fail('ram_used_pct must be 0-100');
  if (row.storage_free_mb !== null && row.storage_free_mb < 0) fail('storage_free_mb may not be negative');
  if (row.battery_voltage_v !== null && row.battery_voltage_v <= 0) row.battery_voltage_v = null; // no battery fitted
  return row;
}

function forecasts(list, obs, models) {
  if (list === null || list === undefined) return [];
  if (!Array.isArray(list)) fail('forecasts must be a list');
  const origin = new Date(obs.timestamp_utc).getTime();
  const seen = new Set();
  return list.map((f, i) => {
    const name = `forecasts[${i}]`;
    const hz = oneOf(f?.horizon_minutes, HORIZONS, `${name}.horizon_minutes`);
    if (seen.has(hz)) fail(`two forecasts for horizon ${hz}`);
    seen.add(hz);
    const modelId = uuid(f.model_id, `${name}.model_id`);
    if (!models.some((m) => m.model_id === modelId && m.forecast_horizon_min === hz)) {
      fail(`${name}.model_id ${modelId} is not registered for the ${hz}-minute horizon; the Pi registers its models at start-up (POST /api/edge/v1/models)`);
    }
    const generated = time(f.generated_at_utc, `${name}.generated_at_utc`);
    const target = time(f.target_timestamp_utc, `${name}.target_timestamp_utc`);
    if (target.getTime() !== origin + hz * 60_000) fail(`${name}.target_timestamp_utc must be the reading time + ${hz} min`);
    if (generated.getTime() < origin) fail(`${name}.generated_at_utc is before the reading time`);
    if (generated >= target) fail(`${name}.generated_at_utc must be before its target time`);
    const status = oneOf(f.forecast_status, ['VALID', 'INPUT_UNAVAILABLE', 'INSUFFICIENT_HISTORY', 'MODEL_ERROR'], `${name}.forecast_status`);
    const pred = numOrNull(f.predicted_do_mg_l, `${name}.predicted_do_mg_l`);
    if (status === 'VALID' && (pred === null || pred < 0)) fail(`${name} is VALID but predicted_do_mg_l is missing or negative`);
    if (status !== 'VALID' && pred !== null) fail(`${name} is ${status}, so predicted_do_mg_l must be null`);
    return {
      forecast_id: uuid(f.forecast_id, `${name}.forecast_id`), observation_id: obs.observation_id, model_id: modelId,
      generated_at_utc: generated.toISOString(), target_timestamp_utc: target.toISOString(), horizon_minutes: hz,
      predicted_do_mg_l: pred, forecast_status: status, sync_status: 'SYNCED',
    };
  });
}

function risk(r, obs) {
  if (r === null || r === undefined) return null;
  const at = time(r.assessment_timestamp_utc, 'risk.assessment_timestamp_utc');
  if (at < new Date(obs.timestamp_utc)) fail('risk.assessment_timestamp_utc is before the reading time');
  const outlook = oneOf(r.forecast_outlook, ['NO_CROSSING_EXPECTED', 'CROSSING_EXPECTED', 'DATA_UNAVAILABLE'], 'risk.forecast_outlook');
  const crossing = time(r.expected_threshold_crossing_utc, 'risk.expected_threshold_crossing_utc', { optional: true });
  if ((outlook === 'CROSSING_EXPECTED') !== !!crossing) fail('expected_threshold_crossing_utc is required for CROSSING_EXPECTED and must be null otherwise');
  if (crossing && crossing <= at) fail('expected_threshold_crossing_utc must be after the assessment time');
  const rule = String(r.rule_version || '').trim();
  if (!rule || rule.length > 60) fail('risk.rule_version is required (e.g. RISK-RULE-1.0)');
  return {
    risk_id: uuid(r.risk_id, 'risk.risk_id'), observation_id: obs.observation_id, assessment_timestamp_utc: at.toISOString(),
    current_risk_state: oneOf(r.current_risk_state, ['NORMAL', 'WATCH', 'WARNING', 'CRITICAL', 'DATA_UNAVAILABLE'], 'risk.current_risk_state'),
    forecast_outlook: outlook, expected_threshold_crossing_utc: crossing ? crossing.toISOString() : null, rule_version: rule, sync_status: 'SYNCED',
  };
}

/** Returns { ok: true, rows } or { ok: false, error }. */
function validateCycle(c, { models, now = Date.now() }) {
  try {
    if (!c || typeof c !== 'object') fail('cycle must be an object');
    const obs = observation(c.observation, now);
    return { ok: true, rows: { obs, health: health(c.health, obs), forecasts: forecasts(c.forecasts, obs, models), risk: risk(c.risk, obs) } };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, error: err.message, observation_id: c?.observation?.observation_id || null };
    throw err;
  }
}

module.exports = { validateCycle, UUID_RE, HORIZONS };
