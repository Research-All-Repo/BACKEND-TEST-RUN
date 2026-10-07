'use strict';
const express = require('express');
const S = require('../services/dashboard');
const { unwrap, E } = require('../lib/errors');
const { assertUuid, parseRange, classifyFreshness } = require('../lib/helpers');

const router = express.Router();

// sensor_registry.sensor_type is free TEXT in LS-1.0 (no enum), so the link to the
// observation columns is a keyword match. Unknown types still list, just without a live reading.
const TYPE_MAP = [
  { match: /dissolved|(^|_)do($|_)|oxygen/i, variables: ['do_mg_l', 'do_saturation_pct', 'water_temp_c'], bus: 'rs485_bus_status' },
  { match: /ph/i, variables: ['ph_value'], bus: 'i2c_bus_status' },
  { match: /light|lux/i, variables: ['light_lux'], bus: 'rs485_bus_status' },
  { match: /humid|air_temp|sht/i, variables: ['air_temp_c', 'relative_humidity_pct'], bus: 'i2c_bus_status' },
  { match: /pressure|baro|bmp/i, variables: ['atmospheric_pressure_hpa'], bus: 'i2c_bus_status' },
];

function variablesFor(sensorType) {
  return TYPE_MAP.find((t) => t.match.test(sensorType || '')) || { variables: [], bus: null };
}

/**
 * GET /api/sensors
 * Sensor registry + latest calibration per sensor + each sensor's latest
 * reading/quality flag from the newest observation + latest system health.
 */
router.get('/', async (req, res, next) => {
  try {
    const { db } = req.auth;
    const [sensors, calibrations, obs, health] = await Promise.all([
      db.from('sensor_registry').select('*').order('created_at_utc').then(unwrap),
      db.from('sensor_calibrations').select('*').order('calibration_started_at_utc', { ascending: false }).limit(500).then(unwrap),
      S.getLatestObservation(db),
      S.getLatestHealth(db),
    ]);
    const shaped = S.shapeObservation(obs);
    const list = sensors.map((s) => {
      const map = variablesFor(s.sensor_type);
      const cal = calibrations.filter((c) => c.sensor_id === s.sensor_id);
      const lastPassed = cal.find((c) => c.result === 'PASSED');
      const readings = shaped ? map.variables.map((v) => ({ variable: v, ...shaped.readings[v] })) : [];
      const statuses = readings.map((r) => r.quality_status);
      let dataStatus = 'NO_DATA';
      if (statuses.length) dataStatus = statuses.every((x) => x === 'VALID') ? 'OK' : statuses.some((x) => x === 'VALID') ? 'DEGRADED' : 'FAULT';
      if (!map.variables.length) dataStatus = 'NOT_MAPPED';
      return {
        ...s,
        monitored_variables: map.variables,
        bus: map.bus ? { name: map.bus.replace('_bus_status', '').toUpperCase(), status: health?.[map.bus] ?? null } : null,
        latest_readings: readings,
        latest_reading_at_utc: shaped?.timestamp_utc || null,
        data_status: dataStatus,
        latest_calibration: cal[0] || null,
        last_passed_calibration_at_utc: lastPassed?.calibration_completed_at_utc || null,
        calibration_count: cal.length,
      };
    });
    res.json({
      data: { sensors: list, system_health: health, latest_observation_utc: obs?.timestamp_utc || null },
      meta: { freshness: classifyFreshness(obs?.timestamp_utc || null, health) },
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/sensors/:sensorId/calibrations - full calibration history for one sensor. */
router.get('/:sensorId/calibrations', async (req, res, next) => {
  try {
    const { db } = req.auth;
    const id = assertUuid(req.params.sensorId, 'sensorId');
    const sensor = unwrap(await db.from('sensor_registry').select('*').eq('sensor_id', id).maybeSingle());
    if (!sensor) throw E.notFound('Sensor not found.');
    const rows = unwrap(await db.from('sensor_calibrations').select('*').eq('sensor_id', id).order('calibration_started_at_utc', { ascending: false }));
    res.json({ data: { sensor, calibrations: rows } });
  } catch (err) {
    next(err);
  }
});

/** GET /api/sensors/health?from=&to= - Raspberry Pi health history (CPU, RAM, storage, Wi-Fi, buses). */
router.get('/health', async (req, res, next) => {
  try {
    const { db } = req.auth;
    const { from, to } = parseRange(req.query, { defaultHours: 24, maxDays: 7 });
    const rows = unwrap(await db.from('system_health').select('*').gte('timestamp_utc', from).lt('timestamp_utc', to)
      .order('timestamp_utc').limit(1100));
    res.json({ data: rows, meta: { from, to, count: rows.length } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
