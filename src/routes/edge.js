'use strict';
/**
 * Edge API: the only door the Raspberry Pi uses to talk to AquaCast.
 *
 * The Pi authenticates with EDGE_API_KEY (Authorization: Bearer ...). That key only opens these
 * routes, so the Pi never holds the Supabase service-role key; if the Pi is lost or stolen, change
 * EDGE_API_KEY in Vercel and the old key stops working at the next deploy.
 *
 *   GET  /api/edge/v1/hello     server time, registered forecast models, aerator settings
 *   POST /api/edge/v1/models    register the Pi's forecast models (one DEPLOYED model per horizon)
 *   POST /api/edge/v1/cycles    upload 1-50 ten-minute cycles (reading + health + forecasts + risk)
 *   POST /api/edge/v1/control   report relay state / command results / mode acknowledgement,
 *                               receive the pending dashboard ON/OFF requests and the requested mode
 *
 * Every write is idempotent (the Pi makes the UUIDs), so the Pi can safely send the same thing again
 * after a timeout or an internet outage (store-and-forward from its SD card).
 */
const crypto = require('crypto');
const express = require('express');
const { waitUntil } = require('@vercel/functions');
const config = require('../config');
const { ApiError, E } = require('../lib/errors');
const { getAdminClient } = require('../lib/supabase');
const { validateCycle, UUID_RE, HORIZONS } = require('../services/edge-validate');

const router = express.Router();
const { rateLimit } = require('../middleware/rate-limit');
const edgeFailures = rateLimit({ windowMs: 15 * 60_000, max: 20, key: (req) => `edge-fail:${req.ip}`, message: 'Too many wrong edge keys from this network.' });
// a normal Pi makes about 100 calls per 15 minutes (check-in every 15 s + uploads); this only stops floods
router.use(rateLimit({ windowMs: 15 * 60_000, max: 1200, shared: false, key: (req) => `edge:${req.ip}`, message: 'Too many edge requests.' }));
const MAX_BATCH = 50;
const API_VERSION = 1;

// ---------- authentication ----------
const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
function edgeAuth(req, _res, next) {
  if (!config.edge.apiKey) return next(new ApiError(503, 'EDGE_NOT_CONFIGURED', 'EDGE_API_KEY is not set on the server (Vercel -> Settings -> Environment Variables).'));
  if (config.edge.apiKey.length < 32) return next(new ApiError(503, 'EDGE_KEY_TOO_SHORT', 'EDGE_API_KEY on the server must be at least 32 characters.'));
  const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  if (!m || !crypto.timingSafeEqual(digest(m[1].trim()), digest(config.edge.apiKey))) {
    // wrong keys are counted per network: after 20 in 15 minutes that address is refused for a while
    return edgeFailures.hit(req).then((r) => next(r.allowed
      ? new ApiError(401, 'EDGE_KEY_INVALID', 'Edge key missing or wrong. Check AQUACAST_EDGE_KEY on the Raspberry Pi.')
      : edgeFailures.tooMany(r.retry)), next);
  }
  req.edge = { version: String(req.get('x-aquacast-edge-version') || '').slice(0, 40) || null };
  next();
}
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.use(edgeAuth);

const db = () => getAdminClient();
function must({ data, error }) { if (error) throw error; return data; }
const isConstraint = (e) => /^(23|22)/.test(String(e?.code || '')); // integrity / data errors: the row itself is bad
const nowIso = () => new Date().toISOString();

async function loadModels() {
  return must(await db().from('forecast_models').select('model_id, forecast_horizon_min, model_name, version, model_file_hash, deployment_status'));
}

async function readSettings() {
  return must(await db().from('aerator_control_settings').select('*').eq('singleton_slot', 1).maybeSingle());
}

/** Small "Raspberry Pi connection" record for the Diagnostics panel (dashboard_settings.edge_status). */
async function saveEdgeStatus(patch) {
  try {
    const cur = must(await db().from('dashboard_settings').select('value').eq('setting_key', 'edge_status').maybeSingle());
    const value = { ...(cur?.value || {}), ...patch };
    must(await db().from('dashboard_settings').upsert({ setting_key: 'edge_status', value, updated_at: nowIso(), updated_by: null }, { onConflict: 'setting_key' }));
  } catch (e) { console.warn('[edge] could not save status:', e.message); }
}

function simulatorGuard() {
  if (config.mockEdge.enabled) {
    throw new ApiError(409, 'SIMULATOR_ENABLED', 'The simulator is still ON (MOCK_EDGE_ENABLED=true), so real Pi data would clash with simulated data. Set MOCK_EDGE_ENABLED=false in Vercel and redeploy. The Pi keeps its readings on the SD card until then.');
  }
}

// ---------- GET /hello ----------
router.get('/v1/hello', async (req, res, next) => {
  try {
    const [models, settings] = await Promise.all([loadModels(), readSettings()]);
    const deployed = {};
    for (const hz of HORIZONS) deployed[hz] = models.find((m) => m.forecast_horizon_min === hz && m.deployment_status === 'DEPLOYED') || null;
    const pi = req.query || {};
    await saveEdgeStatus({ last_hello_at: nowIso(), edge_version: req.edge.version, hostname: String(pi.host || '').slice(0, 60) || null,
      clock_skew_s: Number.isFinite(Number(pi.pi_time_ms)) ? Math.round((Number(pi.pi_time_ms) - Date.now()) / 1000) : null });
    res.json({ data: {
      api_version: API_VERSION, server_time: nowIso(), simulator_enabled: !!config.mockEdge.enabled,
      max_batch: MAX_BATCH, deployed_models: deployed, default_rule_version: config.defaultRuleVersion,
      settings: settings && publicSettings(settings),
    } });
  } catch (err) { next(err); }
});

// ---------- POST /models ----------
router.post('/v1/models', async (req, res, next) => {
  try {
    const list = req.body?.models;
    if (!Array.isArray(list) || !list.length || list.length > 4) throw E.validation('models must be a list of 1-4 models (one per horizon).');
    const out = [];
    for (const [i, m] of list.entries()) {
      const hz = Number(m?.horizon_minutes);
      if (!HORIZONS.includes(hz)) throw E.validation(`models[${i}].horizon_minutes must be 30, 60, 90 or 120.`);
      if (!UUID_RE.test(String(m.model_id || ''))) throw E.validation(`models[${i}].model_id must be a UUID.`);
      const text = (k, max = 200) => { const v = String(m[k] ?? '').trim(); if (!v) throw E.validation(`models[${i}].${k} is required.`); return v.slice(0, max); };
      const date = (k) => { const d = new Date(m[k]); if (Number.isNaN(d.getTime())) throw E.validation(`models[${i}].${k} must be a date.`); return d.toISOString(); };
      const row = {
        model_id: String(m.model_id).toLowerCase(), forecast_horizon_min: hz, model_name: text('model_name'), algorithm: text('algorithm'),
        version: text('version', 60), training_start_utc: date('training_start_utc'), training_end_utc: date('training_end_utc'),
        model_file_name: text('model_file_name'), model_file_hash: text('model_file_hash', 128),
      };
      if (row.training_end_utc < row.training_start_utc) throw E.validation(`models[${i}]: training_end_utc is before training_start_utc.`);
      const existing = must(await db().from('forecast_models').select('model_id, forecast_horizon_min, deployment_status').eq('model_id', row.model_id).maybeSingle());
      if (existing && existing.forecast_horizon_min !== hz) throw E.validation(`models[${i}]: model_id is already registered for another horizon.`);
      if (existing?.deployment_status === 'DEPLOYED') { out.push({ model_id: row.model_id, horizon_minutes: hz, status: 'ALREADY_DEPLOYED' }); continue; }
      // one DEPLOYED model per horizon: the previous one is kept (old forecasts point to it) but RETIRED
      must(await db().from('forecast_models').update({ deployment_status: 'RETIRED' }).eq('forecast_horizon_min', hz).eq('deployment_status', 'DEPLOYED'));
      if (existing) must(await db().from('forecast_models').update({ deployment_status: 'DEPLOYED' }).eq('model_id', row.model_id));
      else must(await db().from('forecast_models').insert({ ...row, deployment_status: 'DEPLOYED', created_at_utc: nowIso() }));
      await db().from('dashboard_audit_log').insert({ actor_user_id: null, action: 'EDGE_MODEL_DEPLOYED', target_table: 'forecast_models', target_id: row.model_id,
        details: { horizon_minutes: hz, model_name: row.model_name, version: row.version, file: row.model_file_name } });
      out.push({ model_id: row.model_id, horizon_minutes: hz, status: existing ? 'REDEPLOYED' : 'REGISTERED' });
    }
    res.json({ data: { models: out } });
  } catch (err) { next(err); }
});

// ---------- POST /cycles ----------
router.post('/v1/cycles', async (req, res, next) => {
  try {
    simulatorGuard();
    const cycles = req.body?.cycles;
    if (!Array.isArray(cycles) || !cycles.length) throw E.validation('cycles must be a non-empty list.');
    if (cycles.length > MAX_BATCH) throw E.validation(`Send at most ${MAX_BATCH} cycles per request.`);
    const models = await loadModels();
    const now = Date.now();
    const results = new Array(cycles.length);
    const good = []; // { i, rows }
    cycles.forEach((c, i) => {
      const v = validateCycle(c, { models, now });
      if (v.ok) good.push({ i, rows: v.rows });
      else results[i] = { observation_id: v.observation_id, status: 'REJECTED', error: v.error };
    });

    // Readings already in the cloud: same id = an earlier upload (fine); another id at the same time = clash.
    if (good.length) {
      const ids = good.map((g) => g.rows.obs.observation_id);
      const times = good.map((g) => g.rows.obs.timestamp_utc);
      const [byId, byTime] = await Promise.all([
        db().from('raw_observations').select('observation_id, timestamp_utc').in('observation_id', ids).then(must),
        db().from('raw_observations').select('observation_id, timestamp_utc').in('timestamp_utc', times).then(must),
      ]);
      const known = new Map([...byId, ...byTime].map((r) => [r.observation_id, r]));
      const takenAt = new Map(byTime.map((r) => [new Date(r.timestamp_utc).getTime(), r.observation_id]));
      for (const g of good) {
        const o = g.rows.obs;
        const owner = takenAt.get(new Date(o.timestamp_utc).getTime());
        const mine = known.get(o.observation_id);
        if (mine && new Date(mine.timestamp_utc).getTime() !== new Date(o.timestamp_utc).getTime()) g.error = 'observation_id was already stored with a different timestamp_utc';
        else if (owner && owner !== o.observation_id) g.error = `another reading is already stored for ${o.timestamp_utc} (simulated data not cleared yet?)`;
        g.existed = !!mine;
      }
    }
    const todo = good.filter((g) => !g.error);
    good.filter((g) => g.error).forEach((g) => { results[g.i] = { observation_id: g.rows.obs.observation_id, status: 'REJECTED', error: g.error }; });

    // Write in foreign-key order; a batch that the database refuses is retried row by row to find the bad cycle.
    const steps = [
      ['raw_observations', (g) => (g.existed ? [] : [g.rows.obs]), 'observation_id'],
      ['system_health', (g) => (g.rows.health ? [g.rows.health] : []), 'observation_id'],
      ['forecasts', (g) => g.rows.forecasts, 'observation_id,horizon_minutes'],
      ['risk_assessments', (g) => (g.rows.risk ? [g.rows.risk] : []), 'observation_id'],
    ];
    let live = todo;
    for (const [table, rowsOf, onConflict] of steps) {
      const rows = live.flatMap(rowsOf);
      if (!rows.length) continue;
      const { error } = await db().from(table).upsert(rows, { onConflict, ignoreDuplicates: true });
      if (!error) continue;
      if (!isConstraint(error)) throw error; // database / network trouble: the Pi will retry the whole batch
      const ok = [];
      for (const g of live) {
        const mine = rowsOf(g);
        const r = mine.length ? await db().from(table).upsert(mine, { onConflict, ignoreDuplicates: true }) : { error: null };
        if (!r.error) { ok.push(g); continue; }
        if (!isConstraint(r.error)) throw r.error;
        results[g.i] = { observation_id: g.rows.obs.observation_id, status: 'REJECTED', error: `${table}: ${r.error.message}` };
      }
      live = ok;
    }
    for (const g of live) results[g.i] = { observation_id: g.rows.obs.observation_id, status: g.existed ? 'DUPLICATE' : 'STORED' };

    const stored = results.filter((r) => r.status === 'STORED').length;
    const latest = live.map((g) => g.rows.obs.timestamp_utc).sort().pop() || null;
    const backlog = Number(req.body?.outbox_backlog);
    await saveEdgeStatus({ last_upload_at: nowIso(), edge_version: req.edge.version, outbox_backlog: Number.isFinite(backlog) ? backlog : null,
      ...(latest ? { latest_uploaded_cycle_utc: latest } : {}), last_rejected: results.find((r) => r.status === 'REJECTED')?.error || null });
    // A new risk assessment may need a phone alert. The Supabase webhook does this too; the claim in
    // the audit log makes sure only one of them sends. Readings older than 60 min never alert.
    if (live.some((g) => g.rows.risk && !g.existed)) {
      waitUntil(require('../services/risk-push').evaluateAndNotify().catch((e) => console.warn('[edge] alert check failed:', e.message)));
    }
    res.json({ data: { results, stored, server_time: nowIso() } });
  } catch (err) { next(err); }
});

// ---------- POST /control ----------
const RESULT_STATUS = ['APPLIED', 'REJECTED', 'FAILED', 'EXPIRED'];

function publicSettings(s) {
  return { requested_mode: s.requested_mode, settings_revision: s.settings_revision, applied_mode: s.applied_mode, applied_revision: s.applied_revision,
    automatic_rule_version: s.automatic_rule_version, mode_requested_at_utc: s.mode_requested_at_utc, controller_output_state: s.controller_output_state };
}

async function latestAlertRiskId() {
  const r = must(await db().from('risk_assessments').select('risk_id, current_risk_state').order('assessment_timestamp_utc', { ascending: false }).limit(1).maybeSingle());
  return r && ['WATCH', 'WARNING', 'CRITICAL'].includes(r.current_risk_state) ? r.risk_id : null;
}

/** An APPLIED ON opens an AERATION activity; an APPLIED OFF closes it (same as the simulator). */
async function recordAeration(commandId, state, atIso, note) {
  const open = must(await db().from('management_events').select('event_id, related_command_id, event_start_utc').eq('event_type', 'AERATION').is('event_end_utc', null).maybeSingle());
  if (state === 'ON' && !open) {
    must(await db().from('management_events').insert({
      event_id: crypto.randomUUID(), event_type: 'AERATION', event_start_utc: atIso, event_end_utc: null, reason: null,
      related_risk_id: await latestAlertRiskId(), related_command_id: commandId, stop_command_id: null,
      notes: note, recorded_at_utc: nowIso(), sync_status: 'SYNCED',
    }));
  } else if (state === 'OFF' && open && open.related_command_id) {
    const end = new Date(atIso) < new Date(open.event_start_utc) ? open.event_start_utc : atIso;
    must(await db().from('management_events').update({ event_end_utc: end, stop_command_id: commandId }).eq('event_id', open.event_id));
  }
}

function readTime(v, fallback) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) || d.getTime() > Date.now() + 5 * 60_000 ? fallback : d.toISOString();
}

router.post('/v1/control', async (req, res, next) => {
  try {
    simulatorGuard();
    const body = req.body || {};
    const handled = { command_results: [], automatic_commands: [] };
    const problems = [];

    // 1. results of dashboard ON/OFF requests the Pi worked on
    for (const r of (Array.isArray(body.command_results) ? body.command_results : []).slice(0, 50)) {
      const id = String(r?.command_id || '').toLowerCase();
      if (!UUID_RE.test(id) || !RESULT_STATUS.includes(r.status)) { problems.push(`bad command result ${JSON.stringify(r).slice(0, 120)}`); handled.command_results.push(id); continue; }
      const cmd = must(await db().from('aerator_commands').select('*').eq('command_id', id).maybeSingle());
      handled.command_results.push(id); // answered either way, so the Pi stops resending it
      if (!cmd || cmd.command_source !== 'MANUAL_DASHBOARD' || cmd.command_status !== 'PENDING') continue; // unknown or already final
      const at = readTime(r.at, nowIso());
      const ms = Math.max(new Date(at).getTime(), new Date(cmd.requested_at_utc).getTime());
      const patch = { command_status: r.status, status_updated_at_utc: new Date(ms).toISOString() };
      // a Pi clock a few seconds off must not make a real switch unrecordable (applied must be <= expiry)
      if (r.status === 'APPLIED') patch.applied_at_utc = new Date(Math.min(ms, new Date(cmd.expires_at_utc).getTime())).toISOString();
      if (['REJECTED', 'FAILED'].includes(r.status)) patch.failure_reason = String(r.reason || 'Reported by the controller').slice(0, 300);
      if (r.status === 'EXPIRED') patch.failure_reason = String(r.reason || 'Not applied before the command expiry time').slice(0, 300);
      const { data: changed, error } = await db().from('aerator_commands').update(patch).eq('command_id', id).eq('command_status', 'PENDING').select('command_id');
      if (error) { if (!isConstraint(error)) throw error; problems.push(`command ${id}: ${error.message}`); continue; }
      if (changed?.length && r.status === 'APPLIED') {
        await recordAeration(id, cmd.requested_state, patch.applied_at_utc, 'Aeration session started by dashboard command (controller acknowledgement, not motor feedback).');
      }
    }

    // 2. switching the Pi did by itself in AUTOMATIC mode (may arrive late after an outage)
    const autos = (Array.isArray(body.automatic_commands) ? body.automatic_commands : []).slice(0, 200)
      .sort((a, b) => String(a?.at).localeCompare(String(b?.at)));
    for (const a of autos) {
      const id = String(a?.command_id || '').toLowerCase();
      if (!UUID_RE.test(id) || !['ON', 'OFF'].includes(a.requested_state)) { problems.push('bad automatic command'); handled.automatic_commands.push(id); continue; }
      const at = readTime(a.at, nowIso());
      const { error } = await db().from('aerator_commands').insert({
        command_id: id, requested_state: a.requested_state, command_source: 'AUTOMATIC_LOCAL', requested_by_user_id: null, requested_at_utc: at,
        expires_at_utc: null, command_status: 'APPLIED', applied_at_utc: at, status_updated_at_utc: at, failure_reason: null, sync_status: 'SYNCED',
      });
      handled.automatic_commands.push(id);
      if (error) { if (error.code === '23505') continue; if (!isConstraint(error)) throw error; problems.push(`automatic ${id}: ${error.message}`); continue; }
      const rule = String(a.rule_version || 'AUTO-RULE-1.0').slice(0, 60);
      await recordAeration(id, a.requested_state, at, `Automatic aeration (${rule})${a.risk_state ? ` for risk ${String(a.risk_state).slice(0, 20)}` : ''}; controller acknowledgement.`);
    }

    // 3. the Pi switched to the mode an Admin asked for
    let s = await readSettings();
    if (!s) throw new ApiError(409, 'AERATOR_NOT_INITIALIZED', 'The aerator settings row does not exist yet.');
    const ack = body.mode_ack;
    if (ack && Number(ack.revision) === s.settings_revision && ack.mode === s.requested_mode && s.applied_revision !== s.settings_revision) {
      const at = nowIso();
      // dashboard requests made before the mode change are cancelled, never executed
      const old = must(await db().from('aerator_commands').select('command_id').eq('command_status', 'PENDING').eq('command_source', 'MANUAL_DASHBOARD').lt('requested_at_utc', s.mode_requested_at_utc));
      for (const c of old) {
        must(await db().from('aerator_commands').update({ command_status: 'CANCELLED', status_updated_at_utc: at, failure_reason: `Superseded by mode revision ${s.settings_revision}` })
          .eq('command_id', c.command_id).eq('command_status', 'PENDING'));
      }
      must(await db().from('aerator_control_settings').update({ applied_mode: s.requested_mode, applied_revision: s.settings_revision, mode_applied_at_utc: at })
        .eq('singleton_slot', 1).or(`applied_revision.is.null,applied_revision.lt.${s.settings_revision}`));
    }

    // 4. heartbeat + the relay state the Pi reports right now
    const out = ['ON', 'OFF', 'UNKNOWN'].includes(body.output_state) ? body.output_state : 'UNKNOWN';
    must(await db().from('aerator_control_settings').update({ controller_output_state: out, output_reported_at_utc: nowIso() }).eq('singleton_slot', 1));
    s = await readSettings();

    // 5. work for the Pi: dashboard requests still waiting (expired ones too: the Pi reports them EXPIRED)
    const modeSettled = s.applied_revision === s.settings_revision;
    const pending = must(await db().from('aerator_commands').select('command_id, requested_state, requested_at_utc, expires_at_utc')
      .eq('command_status', 'PENDING').eq('command_source', 'MANUAL_DASHBOARD').order('requested_at_utc').limit(20))
      .filter((c) => modeSettled || new Date(c.requested_at_utc) >= new Date(s.mode_requested_at_utc)); // older ones get cancelled by the mode change

    if (problems.length) console.warn('[edge] control problems:', problems.join(' | '));
    res.json({ data: { server_time: nowIso(), settings: publicSettings(s), pending_commands: pending, handled, problems } });
  } catch (err) { next(err); }
});

router.use((_req, _res, next) => next(E.notFound('Unknown edge API route.')));

module.exports = router;
