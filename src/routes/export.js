'use strict';
/**
 * Research data export (ADMIN): one CSV per table for a chosen period (max 31 days per file,
 * so every download stays small enough for the hosting limits). Each file has exactly the table's
 * structure, the same as Supabase's own CSV export (see lib/table-csv.js). Used for thesis analysis and as a
 * regular backup outside the cloud database.
 *
 *   GET /api/export/datasets                      - list of datasets
 *   GET /api/export/:dataset.csv?from=&to=        - download
 */
const express = require('express');
const { E } = require('../lib/errors');
const { parseRange } = require('../lib/helpers');

const { tableCsv, sendCsv } = require('../lib/table-csv');

const router = express.Router();

/**
 * Each download is one table (or the alerts view) exactly as stored: all columns, in the table's
 * order, values as PostgreSQL writes them. The same structure as Supabase's own CSV export.
 * time = the column that decides which month a row belongs to (null = the whole table).
 */
const DATASETS = {
  observations: { label: 'Sensor readings (raw_observations)', table: 'raw_observations', time: 'timestamp_utc' },
  health: { label: 'Raspberry Pi health per reading (system_health)', table: 'system_health', time: 'timestamp_utc' },
  forecasts: { label: 'Forecasts (forecasts)', table: 'forecasts', time: 'generated_at_utc' },
  risk: { label: 'Risk assessments (risk_assessments)', table: 'risk_assessments', time: 'assessment_timestamp_utc' },
  alerts: { label: 'Alerts with acknowledgements (risk_alerts view)', table: 'risk_alerts', time: 'observation_timestamp_utc' },
  activities: { label: 'Pond activity log (management_events)', table: 'management_events', time: 'event_start_utc' },
  aerator: { label: 'Aerator requests (aerator_commands)', table: 'aerator_commands', time: 'requested_at_utc' },
  dispatches: { label: 'Phone alerts sent (alert_dispatches)', table: 'alert_dispatches', time: 'created_at' },
  deliveries: { label: 'Phone alert delivery per device (alert_deliveries)', table: 'alert_deliveries', time: 'created_at' },
  audit: { label: 'Audit log (dashboard_audit_log)', table: 'dashboard_audit_log', time: 'created_at' },
  models: { label: 'Forecast models, all (forecast_models)', table: 'forecast_models', time: null },
  sensors: { label: 'Sensors, all (sensor_registry)', table: 'sensor_registry', time: null },
  calibrations: { label: 'Sensor calibrations, all (sensor_calibrations)', table: 'sensor_calibrations', time: null },
};

router.get('/datasets', (_req, res) => {
  res.json({ data: Object.entries(DATASETS).map(([id, d]) => ({ id, label: d.label })) });
});

router.get('/:dataset.csv', async (req, res, next) => {
  try {
    const ds = DATASETS[req.params.dataset];
    if (!ds) throw E.validation(`Unknown dataset. Use one of: ${Object.keys(DATASETS).join(', ')}.`);
    const { from, to } = parseRange(req.query, { defaultHours: 24 * 7, maxDays: 31 });
    const csv = await tableCsv(ds.table, ds.time, from, to);
    // name the file by the dates as requested (Philippine time), not the UTC conversion
    const day = (raw, iso) => (/^\d{4}-\d{2}-\d{2}/.test(String(raw || '')) ? String(raw).slice(0, 10) : iso.slice(0, 10));
    const a = day(req.query.from, from); const b = day(req.query.to, to);
    const name = !ds.time ? 'all' : /-01$/.test(a) && /-01$/.test(b) && (new Date(to) - new Date(from)) / 86400000 >= 28 ? a.slice(0, 7) : `${a}-to-${b}`;
    sendCsv(res, `${ds.table}-${name}.csv`, csv);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
