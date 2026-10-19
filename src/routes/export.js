'use strict';
/**
 * Research data export (ADMIN): one CSV per dataset for a chosen period (max 31 days per file,
 * so every download stays small enough for the hosting limits). Used for thesis analysis and as a
 * regular backup outside the cloud database.
 *
 *   GET /api/export/datasets                      - list of datasets
 *   GET /api/export/:dataset.csv?from=&to=        - download
 */
const express = require('express');
const { E, unwrap } = require('../lib/errors');
const { parseRange } = require('../lib/helpers');
const { getAdminClient } = require('../lib/supabase');

const { backupColumn } = require('../lib/backup-column');

const router = express.Router();

/** Each dataset: table/view, columns, time column, optional row mapper. */
const DATASETS = {
  observations: {
    label: 'Sensor readings (every 10 min) + recorded risk level',
    table: 'raw_observations', time: 'timestamp_utc',
    select: 'observation_id, timestamp_utc, record_status, do_mg_l, do_mg_l_status, do_saturation_pct, do_saturation_status, water_temp_c, water_temp_status, ph_value, ph_status, light_lux, light_status, air_temp_c, air_temp_status, relative_humidity_pct, humidity_status, atmospheric_pressure_hpa, pressure_status, risk_assessments(current_risk_state)',
    map: (r) => {
      const { risk_assessments: ra, ...rest } = r;
      if ('filled_from_backup' in rest) rest.filled_from_backup = rest.filled_from_backup ? JSON.stringify(rest.filled_from_backup) : null;
      return { ...rest, recorded_risk_state: (Array.isArray(ra) ? ra[0] : ra)?.current_risk_state ?? null };
    },
    backupColumn: true,
  },
  forecasts: {
    label: 'Forecasts (4 horizons per reading)',
    table: 'forecasts', time: 'target_timestamp_utc',
    select: 'forecast_id, observation_id, model_id, generated_at_utc, target_timestamp_utc, horizon_minutes, predicted_do_mg_l, forecast_status',
  },
  risk: {
    label: 'Risk assessments',
    table: 'risk_assessments', time: 'assessment_timestamp_utc',
    select: 'risk_id, observation_id, assessment_timestamp_utc, current_risk_state, forecast_outlook, expected_threshold_crossing_utc, rule_version, raw_observations(timestamp_utc)',
    map: (r) => { const { raw_observations: ro, ...rest } = r; return { ...rest, observation_timestamp_utc: (Array.isArray(ro) ? ro[0] : ro)?.timestamp_utc ?? null }; },
  },
  alerts: {
    label: 'Alerts with acknowledgements',
    table: 'risk_alerts', time: 'observation_timestamp_utc',
    select: 'risk_id, observation_timestamp_utc, previous_risk_state, current_risk_state, do_mg_l, forecast_outlook, expected_threshold_crossing_utc, min_forecast_do_mg_l, acknowledged_at, acknowledged_by_name, acknowledgement_note',
  },
  activities: {
    label: 'Pond activity log',
    table: 'management_events', time: 'event_start_utc',
    select: 'event_id, event_type, event_start_utc, event_end_utc, reason, related_risk_id, notes, recorded_at_utc',
  },
  aerator: {
    label: 'Aerator requests and controller answers',
    table: 'aerator_commands', time: 'requested_at_utc',
    select: 'command_id, requested_state, command_source, requested_at_utc, command_status, applied_at_utc, status_updated_at_utc, failure_reason',
  },
  deliveries: {
    label: 'Phone alert delivery (sent / confirmed per alert)',
    table: 'alert_dispatches', time: 'created_at',
    select: 'dispatch_id, kind, level, title, created_at, alert_deliveries(status, confirmed_at)',
    map: (r) => {
      const d = r.alert_deliveries || [];
      const delays = d.filter((x) => x.confirmed_at).map((x) => (new Date(x.confirmed_at) - new Date(r.created_at)) / 1000).sort((a, b) => a - b);
      return { dispatch_id: r.dispatch_id, kind: r.kind, level: r.level, title: r.title, created_at: r.created_at,
        devices_sent: d.filter((x) => x.status !== 'FAILED').length, devices_confirmed: d.filter((x) => x.status === 'CONFIRMED').length,
        devices_failed: d.filter((x) => x.status === 'FAILED').length, median_seconds_to_phone: delays.length ? delays[Math.floor(delays.length / 2)] : null };
    },
  },
  audit: {
    label: 'Audit log (who did what)',
    table: 'dashboard_audit_log', time: 'created_at',
    select: 'audit_id, created_at, actor_user_id, action, target_table, target_id, details',
    map: (r) => ({ ...r, details: JSON.stringify(r.details || {}) }),
  },
};

router.get('/datasets', (_req, res) => {
  res.json({ data: Object.entries(DATASETS).map(([id, d]) => ({ id, label: d.label })) });
});

router.get('/:dataset.csv', async (req, res, next) => {
  try {
    const ds = DATASETS[req.params.dataset];
    if (!ds) throw E.validation(`Unknown dataset. Use one of: ${Object.keys(DATASETS).join(', ')}.`);
    const { from, to } = parseRange(req.query, { defaultHours: 24 * 7, maxDays: 31 });
    const db = getAdminClient();
    // which sensor values came from the Pi's backup reading (column from migration 010, if run)
    const select = ds.backupColumn ? ds.select.replace('pressure_status,', `pressure_status${await backupColumn()},`) : ds.select;
    const rows = [];
    for (let offset = 0; offset < 60_000; offset += 1000) {
      const batch = unwrap(await db.from(ds.table).select(select).gte(ds.time, from).lt(ds.time, to).order(ds.time).range(offset, offset + 999));
      rows.push(...(ds.map ? batch.map(ds.map) : batch));
      if (batch.length < 1000) break;
    }
    const cols = rows.length ? Object.keys(rows[0]) : select.split(',').map((c) => c.trim()).filter((c) => !c.includes('('));
    const esc = (v) => (v === null || v === undefined ? '' : /[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    // name the file by the dates as requested (Philippine time), not the UTC conversion
    const day = (raw, iso) => (/^\d{4}-\d{2}-\d{2}/.test(String(raw || '')) ? String(raw).slice(0, 10) : iso.slice(0, 10));
    const a = day(req.query.from, from); const b = day(req.query.to, to);
    const name = /-01$/.test(a) && /-01$/.test(b) && (new Date(to) - new Date(from)) / 86400000 >= 28 ? a.slice(0, 7) : `${a}-to-${b}`;
    res.set('Content-Disposition', `attachment; filename="aquacast-${req.params.dataset}-${name}.csv"`);
    res.send(`\uFEFF${csv}`); // BOM so Excel opens it as UTF-8
  } catch (err) {
    if (/alert_dispatches|alert_deliveries/.test(err?.message || '')) return next(E.validation('Run migration 006 in Supabase first.'));
    next(err);
  }
});

module.exports = router;
