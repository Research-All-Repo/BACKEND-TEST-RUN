'use strict';
/**
 * Deterministic mock data for AquaCast. Every value is a pure function of the
 * timestamp (plus a seeded hash), so re-running the seed or the simulator
 * produces the same rows and inserts are idempotent.
 *
 * The DO curve imitates a tilapia pond: daytime photosynthesis peak (~16:00
 * Manila), pre-dawn trough (~04:00), some nights with deeper dips that reach
 * the critical range, plus aeration boost when the controller reports ON.
 */
const crypto = require('crypto');

const CYCLE_MIN = 10;
const CYCLE_MS = CYCLE_MIN * 60_000;
const TZ_OFFSET_H = 8; // Asia/Manila (no DST)
const RULE_VERSION = 'RISK-RULE-1.0';
const CRITICAL = 3.0;
const WATCH = 5.0;
const HORIZONS = [30, 60, 90, 120];
const POND = { length: 20, width: 10, depth: 1.2 };

function uuidFromName(name) {
  const h = crypto.createHash('sha1').update(`aquacast-mock:${name}`).digest();
  h[6] = (h[6] & 0x0f) | 0x50; // version 5
  h[8] = (h[8] & 0x3f) | 0x80; // RFC 4122 variant
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** Seeded uniform random in [0, 1). */
function rnd(key) {
  return crypto.createHash('md5').update(key).digest().readUInt32BE(0) / 2 ** 32;
}

/** Seeded standard normal. */
function gauss(key) {
  const u = Math.max(rnd(`${key}:u`), 1e-9);
  const v = rnd(`${key}:v`);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function floorToCycle(date) {
  return new Date(Math.floor(new Date(date).getTime() / CYCLE_MS) * CYCLE_MS);
}

function localHour(t) {
  const d = new Date(t.getTime() + TZ_OFFSET_H * 3600_000);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

function localDayKey(t) {
  return new Date(t.getTime() + TZ_OFFSET_H * 3600_000).toISOString().slice(0, 10);
}

const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** "True" dissolved oxygen (mg/L) at time t, without aeration. */
function trueDo(t) {
  const day = localDayKey(t);
  const h = localHour(t);
  const mean = 5.7 + (rnd(`mean:${day}`) - 0.5) * 1.0;
  const amp = 1.9 + rnd(`amp:${day}`) * 0.9;
  const diurnal = Math.sin((2 * Math.PI * (h - 10)) / 24);
  const ms = t.getTime();
  const wobble = 0.14 * Math.sin(ms / (37 * 60_000) + rnd(`ph1:${day}`) * 6.28)
    + 0.08 * Math.sin(ms / (91 * 60_000) + rnd(`ph2:${day}`) * 6.28);
  let dip = 0;
  if (rnd(`dip:${day}`) < 0.4) {
    const center = 1.5 + rnd(`dipc:${day}`) * 4; // 01:30-05:30 local
    const depth = 0.7 + rnd(`dipd:${day}`) * 1.0;
    const hh = h > 12 ? h - 24 : h;
    dip = -depth * Math.exp(-((hh - center) ** 2) / (2 * 1.3 ** 2));
  }
  return mean + amp * diurnal + wobble + dip;
}

/** Aeration adds up to +1.3 mg/L, ramping in over ~45 minutes after the controller turned ON. */
function aerationBoost(t, aerationStarts = []) {
  let boost = 0;
  for (const s of aerationStarts) {
    if (!s) continue;
    const start = new Date(s.start).getTime();
    const end = s.end ? new Date(s.end).getTime() : Infinity;
    const ms = t.getTime();
    if (ms >= start && ms < end) boost = Math.max(boost, 1.3 * Math.min(1, (ms - start) / (45 * 60_000)));
  }
  return boost;
}

function doSaturation(tempC) {
  return 14.62 - 0.3898 * tempC + 0.006969 * tempC ** 2 - 0.00005897 * tempC ** 3;
}

function riskFor(currentDo, forecasts) {
  const preds = forecasts.map((f) => (f.forecast_status === 'VALID' ? f.predicted_do_mg_l : null));
  const valid = preds.filter((p) => p !== null);
  let state;
  if (currentDo === null) state = 'DATA_UNAVAILABLE';
  else if (currentDo <= CRITICAL) state = 'CRITICAL';
  else if (currentDo < WATCH) state = 'WARNING';
  else if (valid.some((p) => p <= CRITICAL)) state = 'WARNING';
  else if (valid.some((p) => p > CRITICAL && p < WATCH)) state = 'WATCH';
  else if (valid.length === HORIZONS.length) state = 'NORMAL';
  else state = 'DATA_UNAVAILABLE';

  const crossing = forecasts.find((f) => f.forecast_status === 'VALID' && f.predicted_do_mg_l <= CRITICAL);
  let outlook;
  if (crossing) outlook = 'CROSSING_EXPECTED';
  else if (valid.length === HORIZONS.length) outlook = 'NO_CROSSING_EXPECTED';
  else outlook = 'DATA_UNAVAILABLE';
  return { state, outlook, crossingUtc: crossing ? crossing.target_timestamp_utc : null };
}

/**
 * Build every row of one 10-minute cycle: observation, system health,
 * four forecasts and the official risk assessment.
 */
function buildCycle(slot, { models, aeration = [], deploymentStart, syncStatus = 'SYNCED' }) {
  const t = floorToCycle(slot);
  const iso = t.toISOString();
  const key = `cycle:${iso}`;
  const h = localHour(t);
  const day = localDayKey(t);
  const observationId = uuidFromName(`obs:${iso}`);

  const fault = rnd(`${key}:fault`);
  const doFault = fault < 0.003;
  const phFault = !doFault && fault >= 0.003 && fault < 0.008;
  const lightFault = fault >= 0.008 && fault < 0.018;

  const waterTemp = 28.0 + 1.6 * Math.sin((2 * Math.PI * (h - 9)) / 24) + 0.1 * gauss(`${key}:wt`);
  const measuredDo = clamp(trueDo(t) + aerationBoost(t, aeration) + 0.04 * gauss(`${key}:do`), 0.2, 14);
  const ph = 7.55 + 0.45 * Math.sin((2 * Math.PI * (h - 10)) / 24) + 0.03 * gauss(`${key}:ph`);
  const phVoltage = 1500 + (7 - ph) * 175 + 2 * gauss(`${key}:phv`);
  const cloud = 0.55 + 0.45 * rnd(`cloud:${day}`);
  const light = h > 6 && h < 18 ? 65000 * Math.sin((Math.PI * (h - 6)) / 12) ** 1.3 * cloud * (0.9 + 0.2 * rnd(`${key}:lx`)) : 2 * rnd(`${key}:lx`);
  const airTemp = 27.2 + 4.2 * Math.sin((2 * Math.PI * (h - 9)) / 24) + 0.2 * gauss(`${key}:at`);
  const humidity = clamp(80 - 15 * Math.sin((2 * Math.PI * (h - 9)) / 24) + 1.5 * gauss(`${key}:rh`), 35, 99);
  const pressure = 1010.2 + 1.4 * Math.sin((2 * Math.PI * (h - 10)) / 12) + 0.3 * gauss(`${key}:p`);

  const started = new Date(t.getTime() + 2000 + Math.round(rnd(`${key}:s`) * 4000));
  const completed = new Date(started.getTime() + 6000 + Math.round(rnd(`${key}:c`) * 3000));

  const obs = {
    observation_id: observationId,
    timestamp_utc: iso,
    acquisition_started_at_utc: started.toISOString(),
    acquisition_completed_at_utc: completed.toISOString(),
    do_mg_l: doFault ? null : round(measuredDo, 2),
    do_saturation_pct: doFault ? null : round((measuredDo / doSaturation(waterTemp)) * 100, 1),
    water_temp_c: doFault ? null : round(waterTemp, 2),
    ph_adc_raw: phFault ? null : Math.round(phVoltage / 0.1875),
    ph_voltage_mv: phFault ? null : round(phVoltage, 1),
    ph_value: phFault ? null : round(ph, 2),
    light_lux: lightFault ? null : round(light, 0),
    air_temp_c: round(airTemp, 2),
    relative_humidity_pct: round(humidity, 1),
    atmospheric_pressure_hpa: round(pressure, 1),
    do_mg_l_status: doFault ? 'COMMUNICATION_ERROR' : 'VALID',
    do_saturation_status: doFault ? 'COMMUNICATION_ERROR' : 'VALID',
    water_temp_status: doFault ? 'COMMUNICATION_ERROR' : 'VALID',
    ph_status: phFault ? 'SENSOR_ERROR' : 'VALID',
    light_status: lightFault ? 'COMMUNICATION_ERROR' : 'VALID',
    air_temp_status: 'VALID',
    humidity_status: 'VALID',
    pressure_status: 'VALID',
    record_status: doFault || phFault || lightFault ? 'PARTIAL' : 'COMPLETE',
    sync_status: syncStatus,
  };

  const bootEvery = 4 * 86400_000;
  const depMs = new Date(deploymentStart || t).getTime();
  const sinceBoot = Math.max(0, (t.getTime() - depMs) % bootEvery);
  const health = {
    observation_id: observationId,
    timestamp_utc: new Date(completed.getTime() + 1500).toISOString(),
    pi_cpu_temp_c: round(47 + 0.25 * (airTemp - 27) * 4 + 3 * rnd(`${key}:cpu`), 1),
    pi_uptime_s: Math.round(sinceBoot / 1000) + 40,
    ram_used_pct: round(36 + 10 * rnd(`${key}:ram`), 1),
    storage_free_mb: round(24000 - (t.getTime() - depMs) / 86400_000 * 35, 0),
    wifi_connected: true,
    wifi_signal_rssi_dbm: round(-58 - 10 * rnd(`${key}:rssi`), 0),
    internet_reachable: true,
    last_cloud_sync_at_utc: new Date(t.getTime() + 45_000).toISOString(),
    battery_voltage_v: round(12.4 + (h > 7 && h < 17 ? 0.8 : 0.2) + 0.05 * gauss(`${key}:bat`), 2),
    rs485_bus_status: doFault || lightFault ? 'DEGRADED' : 'OK',
    i2c_bus_status: phFault ? 'DEGRADED' : 'OK',
    local_database_operational: true,
    sync_status: syncStatus,
  };

  const generated = new Date(completed.getTime() + 4000 + Math.round(rnd(`${key}:g`) * 3000));
  const forecasts = HORIZONS.map((hz) => {
    const model = models[hz];
    const target = new Date(t.getTime() + hz * 60_000);
    let status = 'VALID';
    let pred = null;
    if (doFault) status = 'INPUT_UNAVAILABLE';
    else if (rnd(`${key}:merr:${hz}`) < 0.002) status = 'MODEL_ERROR';
    else {
      const truth = trueDo(target) + aerationBoost(target, aeration);
      const sd = 0.06 + 0.07 * (hz / 30);
      pred = round(Math.max(0, truth + sd * gauss(`${key}:fc:${hz}`) - 0.03 * (hz / 30)), 2);
    }
    return {
      forecast_id: uuidFromName(`fc:${iso}:${hz}`),
      observation_id: observationId,
      model_id: model.model_id,
      generated_at_utc: generated.toISOString(),
      target_timestamp_utc: target.toISOString(),
      horizon_minutes: hz,
      predicted_do_mg_l: status === 'VALID' ? pred : null,
      forecast_status: status,
      sync_status: syncStatus,
    };
  });

  const r = riskFor(obs.do_mg_l, forecasts);
  const risk = {
    risk_id: uuidFromName(`risk:${iso}`),
    observation_id: observationId,
    assessment_timestamp_utc: new Date(generated.getTime() + 1500).toISOString(),
    current_risk_state: r.state,
    forecast_outlook: r.outlook,
    expected_threshold_crossing_utc: r.crossingUtc,
    rule_version: RULE_VERSION,
    sync_status: syncStatus,
  };

  return { obs, health, forecasts, risk };
}

/** Static reference rows: study, deployed models, sensors, calibrations, aerator settings, biomass. */
function referenceRows(deploymentStart) {
  const dep = floorToCycle(deploymentStart);
  const depIso = dep.toISOString();
  const volume = POND.length * POND.width * POND.depth;

  const study = {
    study_id: uuidFromName('study:main'),
    deployment_start_utc: depIso,
    deployment_end_utc: null,
    sampling_interval_min: CYCLE_MIN,
    probe_depth_m: 0.5,
    pond_length_m: POND.length,
    pond_width_m: POND.width,
    pond_depth_m: POND.depth,
    culture_species: 'Nile tilapia (Oreochromis niloticus)',
    culture_stage: 'Grow-out',
    culture_system: 'Earthen pond, static water with periodic exchange',
    site_description: 'BFAR TOS • Looc, Castillejos, Zambales - Pond 1',
    timezone: 'Asia/Manila',
    notes: 'MOCK DATA: generated by the AquaCast backend simulator for development and testing.',
  };

  const models = {};
  const modelRows = HORIZONS.map((hz) => {
    const row = {
      model_id: uuidFromName(`model:xgb:${hz}:v1`),
      model_name: `AquaCast XGBoost DO +${hz} min`,
      algorithm: 'XGBoost regression',
      forecast_horizon_min: hz,
      version: 'v1.0.0-mock',
      training_start_utc: '2026-08-01T00:00:00.000Z',
      training_end_utc: '2026-09-30T23:50:00.000Z',
      model_file_name: `xgb_do_h${hz}_v1.json`,
      model_file_hash: crypto.createHash('sha256').update(`xgb_do_h${hz}_v1`).digest('hex'),
      deployment_status: 'DEPLOYED',
      created_at_utc: new Date(dep.getTime() - 2 * 86400_000).toISOString(),
    };
    models[hz] = row;
    return row;
  });

  const sensorSpecs = [
    ['DISSOLVED_OXYGEN', 'DFRobot', 'SEN0680 RS485 Fluorescence DO Sensor', 'MOCK-SEN0680-0001', 'ACTIVE', 'Primary DO + water temperature sensor (RS485 / Modbus-RTU).'],
    ['PH', 'DFRobot', 'SEN0169-V2 Industrial Analog pH Sensor', 'MOCK-SEN0169-0001', 'ACTIVE', 'Read through ADS1115 ADC on I2C.'],
    ['LIGHT', 'DFRobot', 'SEN0644 RS485 Ambient Light Sensor', 'MOCK-SEN0644-0001', 'ACTIVE', null],
    ['AIR_TEMPERATURE_HUMIDITY', 'DFRobot', 'SEN0227 SHT20 Temperature & Humidity', 'MOCK-SEN0227-0001', 'ACTIVE', null],
    ['BAROMETRIC_PRESSURE', 'Bosch', 'BMP280 Barometric Pressure Sensor', 'MOCK-BMP280-0001', 'ACTIVE', null],
  ];
  const sensors = sensorSpecs.map(([type, mfr, model, serial, status, notes]) => ({
    sensor_id: uuidFromName(`sensor:${serial}`), sensor_type: type, manufacturer: mfr, model, serial_number: serial,
    status, notes, created_at_utc: new Date(dep.getTime() - 3 * 86400_000).toISOString(), sync_status: 'SYNCED',
  }));

  const calibrations = [];
  for (const s of sensors) {
    if (s.status !== 'ACTIVE') continue;
    const twoPoint = ['DISSOLVED_OXYGEN', 'PH'].includes(s.sensor_type);
    const start = new Date(dep.getTime() - 86400_000 + 3600_000);
    calibrations.push({
      calibration_id: uuidFromName(`cal:${s.serial_number}:initial`), sensor_id: s.sensor_id,
      calibration_started_at_utc: start.toISOString(), calibration_completed_at_utc: new Date(start.getTime() + 40 * 60_000).toISOString(),
      calibration_type: twoPoint ? 'TWO_POINT' : 'VERIFICATION', result: 'PASSED',
      notes: twoPoint ? 'Pre-deployment two-point calibration (mock).' : 'Pre-deployment verification against reference (mock).',
      created_at_utc: new Date(start.getTime() + 41 * 60_000).toISOString(), sync_status: 'SYNCED',
    });
  }

  const settings = {
    settings_id: uuidFromName('aerator-settings'), singleton_slot: 1, requested_mode: 'MANUAL', applied_mode: 'MANUAL',
    controller_output_state: 'OFF', automatic_rule_version: null, settings_revision: 1, applied_revision: 1,
    mode_requested_at_utc: depIso, mode_applied_at_utc: new Date(dep.getTime() + 30_000).toISOString(),
    output_reported_at_utc: new Date(dep.getTime() + 30_000).toISOString(), updated_by_user_id: null,
  };

  const stockKg = round((160 * 85) / 1000, 2);
  const biomass = [{
    biomass_record_id: uuidFromName('biomass:stocking'), measured_at_utc: new Date(dep.getTime() - 2 * 86400_000).toISOString(),
    estimated_fish_count: 160, mean_fish_weight_g: 85, total_biomass_kg: stockKg, biomass_density_kg_m3: round(stockKg / volume, 4),
    estimation_method: 'STOCK_RECORD_BASED_ESTIMATE', sample_size: null, notes: 'Stocking record: 160 Nile tilapia fingerlings-to-juveniles (mock).',
    recorded_at_utc: new Date(dep.getTime() - 2 * 86400_000 + 3600_000).toISOString(), sync_status: 'SYNCED',
  }];

  return { study, models, modelRows, sensors, calibrations, settings, biomass };
}

/** Routine management events for the history period (deterministic). */
function historicalEvents(fromDate, toDate) {
  const events = [];
  const startDay = new Date(floorToCycle(fromDate).getTime());
  for (let d = new Date(startDay); d < toDate; d = new Date(d.getTime() + 86400_000)) {
    const dayKey = localDayKey(d);
    const localMidnight = new Date(`${dayKey}T00:00:00+08:00`);
    const add = (type, hour, durMin, notes, reason) => {
      const start = new Date(localMidnight.getTime() + hour * 3600_000);
      const end = new Date(start.getTime() + durMin * 60_000);
      if (start < fromDate || end > toDate) return;
      events.push({
        event_id: uuidFromName(`event:${type}:${start.toISOString()}`), event_type: type,
        event_start_utc: start.toISOString(), event_end_utc: end.toISOString(), reason: reason || null,
        related_risk_id: null, related_command_id: null, stop_command_id: null, notes,
        recorded_at_utc: new Date(end.getTime() + 5 * 60_000).toISOString(), sync_status: 'SYNCED',
      });
    };
    add('FEEDING', 7, 20, 'Morning feeding, ~2% body weight pelleted feed (mock).');
    add('FEEDING', 16, 20, 'Afternoon feeding (mock).');
    if (rnd(`wx:${dayKey}`) < 0.33) add('WATER_EXCHANGE', 9, 120, 'Partial water exchange, ~15% volume (mock).', 'Routine water quality management');
    if (rnd(`maint:${dayKey}`) < 0.12) add('SENSOR_MAINTENANCE', 10.5, 30, 'DO probe membrane cleaned; readings verified (mock).', 'Scheduled maintenance');
  }
  return events;
}

module.exports = {
  CYCLE_MIN, CYCLE_MS, HORIZONS, RULE_VERSION, CRITICAL, WATCH, POND,
  uuidFromName, rnd, floorToCycle, buildCycle, referenceRows, historicalEvents, trueDo, aerationBoost, riskFor,
};
