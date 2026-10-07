'use strict';
// Shared read queries. Every function takes the USER-scoped client (RLS applies).
const config = require('../config');
const { unwrap } = require('../lib/errors');
const { classifyFreshness, minutesBetween } = require('../lib/helpers');

const HORIZONS = [30, 60, 90, 120];

const READINGS = [
  { key: 'do_mg_l', status: 'do_mg_l_status', label: 'Dissolved Oxygen', unit: 'mg/L' },
  { key: 'do_saturation_pct', status: 'do_saturation_status', label: 'DO Saturation', unit: '%' },
  { key: 'water_temp_c', status: 'water_temp_status', label: 'Water Temperature', unit: '°C' },
  { key: 'ph_value', status: 'ph_status', label: 'pH', unit: 'pH' },
  { key: 'light_lux', status: 'light_status', label: 'Light Intensity', unit: 'lux' },
  { key: 'air_temp_c', status: 'air_temp_status', label: 'Air Temperature', unit: '°C' },
  { key: 'relative_humidity_pct', status: 'humidity_status', label: 'Relative Humidity', unit: '%' },
  { key: 'atmospheric_pressure_hpa', status: 'pressure_status', label: 'Atmospheric Pressure', unit: 'hPa' },
];

/** Shape one raw_observations row for the dashboard. Non-VALID values are flagged, not hidden. */
function shapeObservation(o) {
  if (!o) return null;
  const readings = {};
  for (const r of READINGS) {
    readings[r.key] = { label: r.label, value: o[r.key], unit: r.unit, quality_status: o[r.status],
      usable: o[r.status] === 'VALID' && o[r.key] !== null };
  }
  return {
    observation_id: o.observation_id,
    timestamp_utc: o.timestamp_utc,
    acquisition_started_at_utc: o.acquisition_started_at_utc,
    acquisition_completed_at_utc: o.acquisition_completed_at_utc,
    record_status: o.record_status,
    readings,
    ph_diagnostics: { ph_adc_raw: o.ph_adc_raw, ph_voltage_mv: o.ph_voltage_mv },
  };
}

async function getLatestObservation(db) {
  return unwrap(await db.from('raw_observations').select('*').order('timestamp_utc', { ascending: false }).limit(1).maybeSingle());
}

async function getLatestHealth(db) {
  return unwrap(await db.from('system_health').select('*').order('timestamp_utc', { ascending: false }).limit(1).maybeSingle());
}

async function getFreshness(db) {
  const [obs, health] = await Promise.all([
    db.from('raw_observations').select('timestamp_utc').order('timestamp_utc', { ascending: false }).limit(1).maybeSingle().then(unwrapRaw),
    getLatestHealth(db),
  ]);
  return { freshness: classifyFreshness(obs?.timestamp_utc || null, health), latestHealth: health };
}

function unwrapRaw(r) { return unwrap(r); }

/** Forecast rows for one origin observation, always returned as the 4 official horizons. */
async function getForecastsForObservation(db, observationId) {
  const rows = observationId
    ? unwrap(await db.from('forecast_details').select('*').eq('observation_id', observationId))
    : [];
  return HORIZONS.map((h) => {
    const f = rows.find((r) => r.horizon_minutes === h);
    if (!f) {
      return { horizon_minutes: h, forecast_status: 'NOT_GENERATED', predicted_do_mg_l: null, target_timestamp_utc: null,
        generated_at_utc: null, model: null, forecast_id: null };
    }
    return {
      forecast_id: f.forecast_id, horizon_minutes: h, forecast_status: f.forecast_status,
      predicted_do_mg_l: f.predicted_do_mg_l, target_timestamp_utc: f.target_timestamp_utc,
      forecast_origin_utc: f.forecast_origin_utc, generated_at_utc: f.generated_at_utc,
      model: { model_id: f.model_id, model_name: f.model_name, version: f.model_version, deployment_status: f.model_deployment_status },
    };
  });
}

async function getRiskForObservation(db, observationId) {
  if (!observationId) return null;
  return unwrap(await db.from('risk_assessments').select('*').eq('observation_id', observationId).maybeSingle());
}

/** DO trend over the last hour of VALID readings (least-squares slope, mg/L per hour). */
async function getDoTrend(db, latestTimestamp) {
  if (!latestTimestamp) return null;
  const from = new Date(new Date(latestTimestamp).getTime() - 60 * 60000).toISOString();
  const rows = unwrap(await db.from('raw_observations').select('timestamp_utc, do_mg_l, do_mg_l_status')
    .gte('timestamp_utc', from).lte('timestamp_utc', latestTimestamp).order('timestamp_utc'));
  const pts = rows.filter((r) => r.do_mg_l_status === 'VALID' && r.do_mg_l !== null)
    .map((r) => ({ t: new Date(r.timestamp_utc).getTime() / 3600000, y: r.do_mg_l }));
  if (pts.length < 3) return { slope_mg_l_per_hr: null, label: 'Insufficient data', window_minutes: 60, points: pts.length };
  const mt = pts.reduce((s, p) => s + p.t, 0) / pts.length;
  const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const num = pts.reduce((s, p) => s + (p.t - mt) * (p.y - my), 0);
  const den = pts.reduce((s, p) => s + (p.t - mt) ** 2, 0);
  const slope = den ? num / den : 0;
  const label = slope <= -0.3 ? 'Rapidly decreasing' : slope < -0.05 ? 'Decreasing'
    : slope >= 0.3 ? 'Rapidly recovering' : slope > 0.05 ? 'Recovering' : 'Stable';
  return { slope_mg_l_per_hr: Math.round(slope * 1000) / 1000, label, window_minutes: 60, points: pts.length };
}

/**
 * Aerator status. Keeps three things separate:
 *   requested (dashboard)  vs  controller acknowledgement (Pi)  vs  physical motor (not measured).
 */
async function getAeratorSummary(db, now = new Date()) {
  const [settings, recent] = await Promise.all([
    db.from('aerator_control_settings').select('*').eq('singleton_slot', 1).maybeSingle().then(unwrapRaw),
    db.from('aerator_commands').select('*').order('requested_at_utc', { ascending: false }).limit(10).then(unwrapRaw),
  ]);
  if (!settings) {
    return { initialized: false, message: 'The aerator settings row has not been created yet (edge initialization pending).', recent_commands: recent || [] };
  }
  const commands = (recent || []).map((c) => decorateCommand(c, now));
  const pending = commands.find((c) => c.command_status === 'PENDING' && c.command_source === 'MANUAL_DASHBOARD');
  const lastApplied = commands.find((c) => c.command_status === 'APPLIED');
  const reportAge = settings.output_reported_at_utc ? minutesBetween(settings.output_reported_at_utc, now) : null;
  const modeInSync = settings.applied_revision !== null && settings.applied_revision === settings.settings_revision;
  const manualReady = settings.requested_mode === 'MANUAL' && settings.applied_mode === 'MANUAL';
  const pendingLive = pending && pending.effective_status === 'PENDING';

  return {
    initialized: true,
    settings_id: settings.settings_id,
    mode: {
      requested_mode: settings.requested_mode,
      applied_mode: settings.applied_mode,
      settings_revision: settings.settings_revision,
      applied_revision: settings.applied_revision,
      acknowledged: modeInSync,
      mode_requested_at_utc: settings.mode_requested_at_utc,
      mode_applied_at_utc: settings.mode_applied_at_utc,
      automatic_rule_version: settings.automatic_rule_version,
      status_text: modeInSync ? `Controller is running in ${settings.applied_mode} mode.`
        : `Mode change to ${settings.requested_mode} requested; waiting for controller acknowledgement (revision ${settings.settings_revision}).`,
    },
    controller: {
      output_state: settings.controller_output_state,
      output_reported_at_utc: settings.output_reported_at_utc,
      report_age_minutes: reportAge === null ? null : Math.round(reportAge * 10) / 10,
      stale: reportAge === null ? true : reportAge > config.aeratorReportStaleMinutes,
      note: 'Controller-reported relay output. This is an acknowledgement, not independent proof that the aerator motor is running.',
    },
    physical_feedback: { available: false, note: 'No physical aerator feedback sensor is part of the approved design.' },
    pending_command: pending || null,
    last_applied_command: lastApplied || null,
    can_request_manual_command: manualReady && !pendingLive,
    manual_command_blocked_reason: !manualReady
      ? `Manual ON/OFF needs MANUAL mode acknowledged by the controller (requested=${settings.requested_mode}, applied=${settings.applied_mode}).`
      : pendingLive ? 'A previous command is still waiting for the controller.' : null,
    recent_commands: commands,
  };
}

function decorateCommand(c, now = new Date()) {
  let effective = c.command_status;
  if (c.command_status === 'PENDING' && c.expires_at_utc && new Date(c.expires_at_utc) <= now) {
    // The cloud never rewrites edge-owned lifecycle fields; it only reports that
    // this request can no longer execute.
    effective = 'EXPIRED_NOT_ACKNOWLEDGED';
  }
  const explain = {
    PENDING: 'Sent. Waiting for the Raspberry Pi to validate and apply it.',
    EXPIRED_NOT_ACKNOWLEDGED: 'The controller did not acknowledge this request before it expired; it will not be executed.',
    APPLIED: 'The controller acknowledged applying this output state.',
    REJECTED: 'The controller rejected this request.',
    FAILED: 'The controller tried but failed to apply this request.',
    EXPIRED: 'The request expired before it could be applied.',
    CANCELLED: 'Cancelled (made obsolete by a newer mode revision).',
  };
  return { ...c, effective_status: effective, status_text: explain[effective] || effective };
}

async function getStudy(db) {
  return unwrap(await db.from('study_metadata').select('*').order('deployment_start_utc', { ascending: false }).limit(1).maybeSingle());
}

async function countActiveAlerts(db, now = new Date()) {
  const since = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  const { count, error } = await db.from('risk_alerts').select('risk_id', { count: 'exact', head: true })
    .gte('observation_timestamp_utc', since).is('acknowledged_at', null);
  if (error) throw require('../lib/errors').fromSupabase(error);
  return count || 0;
}

module.exports = {
  HORIZONS, READINGS, shapeObservation, getLatestObservation, getLatestHealth, getFreshness,
  getForecastsForObservation, getRiskForObservation, getDoTrend, getAeratorSummary, decorateCommand,
  getStudy, countActiveAlerts,
};
