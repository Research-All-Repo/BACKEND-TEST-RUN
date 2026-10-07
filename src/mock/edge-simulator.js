'use strict';
/**
 * MockEdge: stands in for the Raspberry Pi while the hardware is not connected.
 * It does what the real edge sync will do, using the service-role key:
 *   - pushes each 10-minute cycle (observation, health, 4 forecasts, risk)
 *   - acknowledges aerator mode revisions
 *   - validates and applies (or rejects / expires) PENDING dashboard commands
 *   - opens/closes AERATION sessions from APPLIED ON/OFF commands
 *   - runs automatic aeration when the controller is in AUTOMATIC mode
 * Take it "offline" to see the dashboard's offline / delayed / stale states.
 */
const crypto = require('crypto');
const config = require('../config');
const { getAdminClient } = require('../lib/supabase');
const G = require('./generator');

function check({ error, data }, what) {
  if (error) throw new Error(`${what}: ${error.message}${error.details ? ` (${error.details})` : ''}`);
  return data;
}

async function insertBatches(db, table, rows, onConflict, size = 400) {
  for (let i = 0; i < rows.length; i += size) {
    check(await db.from(table).upsert(rows.slice(i, i + size), { onConflict, ignoreDuplicates: true }), `insert ${table}`);
  }
}

/** Ensure the static reference rows exist. Returns { study, models }. */
async function ensureReference(db, { deploymentStart }) {
  const existing = check(await db.from('study_metadata').select('*').limit(1).maybeSingle(), 'read study');
  const ref = G.referenceRows(existing ? new Date(existing.deployment_start_utc) : deploymentStart);
  if (!existing) check(await db.from('study_metadata').insert(ref.study), 'insert study');

  const deployed = check(await db.from('forecast_models').select('*').eq('deployment_status', 'DEPLOYED'), 'read models');
  const models = {};
  for (const hz of G.HORIZONS) models[hz] = deployed.find((m) => m.forecast_horizon_min === hz) || null;
  const missing = ref.modelRows.filter((m) => !models[m.forecast_horizon_min]);
  if (missing.length) {
    await insertBatches(db, 'forecast_models', missing, 'model_id');
    for (const m of missing) models[m.forecast_horizon_min] = m;
  }

  const anySensor = check(await db.from('sensor_registry').select('sensor_id').limit(1), 'read sensors');
  if (!anySensor.length) {
    await insertBatches(db, 'sensor_registry', ref.sensors, 'sensor_id');
    await insertBatches(db, 'sensor_calibrations', ref.calibrations, 'calibration_id');
  }
  const settings = check(await db.from('aerator_control_settings').select('settings_id').eq('singleton_slot', 1).maybeSingle(), 'read settings');
  if (!settings) check(await db.from('aerator_control_settings').insert(ref.settings), 'insert settings');
  const bio = check(await db.from('biomass_records').select('biomass_record_id').limit(1), 'read biomass');
  if (!bio.length) await insertBatches(db, 'biomass_records', ref.biomass, 'biomass_record_id');

  const study = existing || ref.study;
  return { study, models };
}

/** Aeration intervals overlapping a window, used to apply the DO boost. */
async function aerationIntervals(db, from, to) {
  const rows = check(await db.from('management_events').select('event_start_utc, event_end_utc, related_command_id')
    .eq('event_type', 'AERATION').not('related_command_id', 'is', null).lt('event_start_utc', to.toISOString())
    .or(`event_end_utc.is.null,event_end_utc.gt.${from.toISOString()}`), 'read aeration');
  return rows.map((r) => ({ start: r.event_start_utc, end: r.event_end_utc }));
}

/** Insert every missing cycle between `from` and `to` (inclusive slots). */
async function pushCycles(db, { from, to, study, models }) {
  const slots = [];
  for (let t = G.floorToCycle(from).getTime(); t <= G.floorToCycle(to).getTime(); t += G.CYCLE_MS) slots.push(new Date(t));
  if (!slots.length) return 0;
  const aeration = await aerationIntervals(db, new Date(slots[0].getTime() - 3600_000), new Date(slots[slots.length - 1].getTime() + 3 * 3600_000));
  const cycles = slots.map((s) => G.buildCycle(s, { models, aeration, deploymentStart: study.deployment_start_utc }));
  await insertBatches(db, 'raw_observations', cycles.map((c) => c.obs), 'timestamp_utc');
  await insertBatches(db, 'system_health', cycles.map((c) => c.health), 'observation_id');
  await insertBatches(db, 'forecasts', cycles.flatMap((c) => c.forecasts), 'observation_id,horizon_minutes');
  await insertBatches(db, 'risk_assessments', cycles.map((c) => c.risk), 'observation_id');
  return cycles.length;
}

class MockEdge {
  constructor({ log = () => {}, db = null } = {}) {
    this.db = db || getAdminClient();
    this.log = log;
    this.offline = config.mockEdge.startOffline;
    this.timer = null;
    this.running = false;
    this.lastTickAt = null;
    this.lastError = null;
    this.cyclesPushed = 0;
    this.ref = null;
  }

  start() {
    this.log(`started (tick ${config.mockEdge.tickSeconds}s, backfill ${config.mockEdge.backfillHours}h, offline=${this.offline})`);
    this.tick().catch(() => {});
    this.timer = setInterval(() => this.tick().catch(() => {}), config.mockEdge.tickSeconds * 1000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setOffline(v) {
    this.offline = !!v;
    this.log(`offline=${this.offline}`);
  }

  status() {
    return { enabled: true, offline: this.offline, last_tick_at: this.lastTickAt, last_error: this.lastError,
      cycles_pushed_since_start: this.cyclesPushed, tick_seconds: config.mockEdge.tickSeconds,
      ack_delay_seconds: config.mockEdge.ackDelaySeconds };
  }

  async tick(now = new Date()) {
    if (this.running) return;
    this.running = true;
    try {
      this.lastTickAt = now.toISOString();
      if (this.offline) return;
      const db = this.db;
      if (!this.ref) {
        this.ref = await ensureReference(db, { deploymentStart: new Date(now.getTime() - config.mockEdge.backfillHours * 3600_000) });
      }
      // 1. data cycles
      const latest = check(await db.from('raw_observations').select('timestamp_utc').order('timestamp_utc', { ascending: false }).limit(1).maybeSingle(), 'latest obs');
      const windowStart = new Date(now.getTime() - config.mockEdge.backfillHours * 3600_000);
      const from = latest ? new Date(Math.max(new Date(latest.timestamp_utc).getTime() + G.CYCLE_MS, windowStart.getTime())) : windowStart;
      // only push a cycle once its acquisition + forecasting would be finished (~1 min after the slot)
      const to = new Date(now.getTime() - 60_000);
      if (from <= to) {
        const n = await pushCycles(db, { from, to, study: this.ref.study, models: this.ref.models });
        if (n) { this.cyclesPushed += n; this.log(`pushed ${n} cycle(s)`); }
      }
      // 2. controller duties
      await this.processModeRevision(now);
      await this.processCommands(now);
      await this.automaticControl(now);
      check(await db.from('aerator_control_settings').update({ output_reported_at_utc: now.toISOString() }).eq('singleton_slot', 1), 'heartbeat');
      this.lastError = null;
    } catch (err) {
      this.lastError = err.message;
      this.log('tick failed:', err.message);
    } finally {
      this.running = false;
    }
  }

  async settings() {
    return check(await this.db.from('aerator_control_settings').select('*').eq('singleton_slot', 1).single(), 'read settings');
  }

  async processModeRevision(now) {
    const s = await this.settings();
    if (s.applied_revision === s.settings_revision) return;
    if ((now - new Date(s.mode_requested_at_utc)) / 1000 < config.mockEdge.ackDelaySeconds) return;
    // Pending manual commands made obsolete by the newer revision are CANCELLED, never executed.
    const obsolete = check(await this.db.from('aerator_commands').select('command_id').eq('command_status', 'PENDING')
      .eq('command_source', 'MANUAL_DASHBOARD').lt('requested_at_utc', s.mode_requested_at_utc), 'obsolete cmds');
    for (const c of obsolete) {
      check(await this.db.from('aerator_commands').update({ command_status: 'CANCELLED', status_updated_at_utc: now.toISOString(),
        failure_reason: `Superseded by mode revision ${s.settings_revision}` }).eq('command_id', c.command_id).eq('command_status', 'PENDING'), 'cancel cmd');
    }
    check(await this.db.from('aerator_control_settings').update({
      applied_mode: s.requested_mode, applied_revision: s.settings_revision, mode_applied_at_utc: now.toISOString(),
      output_reported_at_utc: now.toISOString(),
    }).eq('singleton_slot', 1).or(`applied_revision.is.null,applied_revision.lt.${s.settings_revision}`), 'ack mode');
    this.log(`acknowledged mode ${s.requested_mode} (revision ${s.settings_revision})`);
  }

  async processCommands(now) {
    const pending = check(await this.db.from('aerator_commands').select('*').eq('command_status', 'PENDING')
      .eq('command_source', 'MANUAL_DASHBOARD').order('requested_at_utc'), 'pending cmds');
    for (const c of pending) {
      const s = await this.settings();
      const nowIso = now.toISOString();
      const finish = (status, reason) => this.db.from('aerator_commands').update({ command_status: status, status_updated_at_utc: nowIso,
        failure_reason: reason }).eq('command_id', c.command_id).eq('command_status', 'PENDING');
      if (new Date(c.expires_at_utc) <= now) {
        check(await finish('EXPIRED', 'Not applied before the command expiry time'), 'expire cmd');
        this.log(`command ${c.command_id} EXPIRED`);
        continue;
      }
      if (s.applied_mode !== 'MANUAL') {
        check(await finish('REJECTED', `Controller is in ${s.applied_mode} mode; manual commands are not accepted`), 'reject cmd');
        this.log(`command ${c.command_id} REJECTED`);
        continue;
      }
      if ((now - new Date(c.requested_at_utc)) / 1000 < config.mockEdge.ackDelaySeconds) continue;
      await this.applyCommand(c, now);
    }
  }

  async applyCommand(c, now) {
    const nowIso = now.toISOString();
    check(await this.db.from('aerator_commands').update({ command_status: 'APPLIED', applied_at_utc: nowIso, status_updated_at_utc: nowIso })
      .eq('command_id', c.command_id).eq('command_status', 'PENDING'), 'apply cmd');
    await this.afterOutputChange(c.command_id, c.requested_state, now, c.command_source === 'MANUAL_DASHBOARD'
      ? 'Aeration session started by dashboard command (controller acknowledgement, not motor feedback).'
      : 'Aeration session started by automatic local control (controller acknowledgement).');
    this.log(`command ${c.command_id} APPLIED (${c.requested_state})`);
  }

  async afterOutputChange(commandId, state, now, note) {
    const nowIso = now.toISOString();
    check(await this.db.from('aerator_control_settings').update({ controller_output_state: state, output_reported_at_utc: nowIso })
      .eq('singleton_slot', 1), 'report output');
    const open = check(await this.db.from('management_events').select('*').eq('event_type', 'AERATION').is('event_end_utc', null)
      .maybeSingle(), 'open aeration');
    if (state === 'ON' && !open) {
      check(await this.db.from('management_events').insert({
        event_id: crypto.randomUUID(), event_type: 'AERATION', event_start_utc: nowIso, event_end_utc: null,
        reason: null, related_risk_id: await this.latestRiskId(), related_command_id: commandId, stop_command_id: null,
        notes: note, recorded_at_utc: nowIso, sync_status: 'SYNCED',
      }), 'open aeration event');
    } else if (state === 'OFF' && open && open.related_command_id) {
      check(await this.db.from('management_events').update({ event_end_utc: nowIso, stop_command_id: commandId })
        .eq('event_id', open.event_id), 'close aeration event');
    }
  }

  async latestRiskId() {
    const r = check(await this.db.from('risk_assessments').select('risk_id, current_risk_state')
      .order('assessment_timestamp_utc', { ascending: false }).limit(1).maybeSingle(), 'latest risk');
    return r && ['WARNING', 'CRITICAL', 'WATCH'].includes(r.current_risk_state) ? r.risk_id : null;
  }

  async automaticControl(now) {
    const s = await this.settings();
    if (s.applied_mode !== 'AUTOMATIC') return;
    const r = check(await this.db.from('risk_assessments').select('current_risk_state')
      .order('assessment_timestamp_utc', { ascending: false }).limit(1).maybeSingle(), 'latest risk');
    if (!r) return;
    let desired = null;
    if (['WARNING', 'CRITICAL'].includes(r.current_risk_state)) desired = 'ON';
    if (r.current_risk_state === 'NORMAL') desired = 'OFF';
    if (!desired || desired === s.controller_output_state) return;
    const nowIso = now.toISOString();
    const id = crypto.randomUUID();
    check(await this.db.from('aerator_commands').insert({
      command_id: id, requested_state: desired, command_source: 'AUTOMATIC_LOCAL', requested_by_user_id: null,
      requested_at_utc: nowIso, expires_at_utc: null, command_status: 'APPLIED', applied_at_utc: nowIso,
      status_updated_at_utc: nowIso, failure_reason: null, sync_status: 'SYNCED',
    }), 'auto cmd');
    await this.afterOutputChange(id, desired, now, `Automatic aeration (${s.automatic_rule_version}) for risk ${r.current_risk_state}.`);
    this.log(`automatic control -> ${desired}`);
  }
}

module.exports = { MockEdge, ensureReference, pushCycles, insertBatches, check };
