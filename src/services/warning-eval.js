'use strict';
/**
 * Early-warning performance, computed from the data the system logged itself.
 * Answers: did warnings come BEFORE DO went critical (lead time)? how many critical events were
 * missed? how many warnings were false alarms? how fast did people respond? did alerts reach phones?
 * And: does the forecast beat a "no change" baseline?
 *
 * Definitions (shown on the Model Evaluation page as well):
 *   critical event  - observed DO at or below the critical threshold, after being above it for at
 *                     least 30 minutes (so one low period counts once)
 *   early warning   - the forecast predicted a critical crossing (outlook CROSSING_EXPECTED) while DO
 *                     was still above critical; one per continuous period of such predictions
 *   detected        - an early warning was active within 130 minutes (forecast window + 10) before the event
 *   lead time       - event start minus the start of that early-warning period
 *   false alarm     - an early warning with no critical event in the following 130 minutes AND no
 *                     aeration or recorded action within 120 minutes (acted-on warnings may have prevented it)
 * These are operational numbers from whatever data is in the database (simulated or real).
 */
const { ruleReference } = require('../lib/helpers');

const WINDOW_MIN = 120;
const REARM_MIN = 30;
const HORIZONS = [30, 60, 90, 120];
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const round = (v, d = 1) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);

/**
 * obs:   [{ t: ms, do: number|null }] sorted by time (valid DO only has a number)
 * risks: [{ t: ms, state, outlook, rule_version }] sorted by time
 */
function computeWarningMetrics(obs, risks, interventions = []) {
  const critical = (rv) => ruleReference(rv).critical_do_mg_l ?? 3.0;
  const crit = critical(risks[risks.length - 1]?.rule_version);
  // critical events
  const events = [];
  let lastLowAt = null; let inEvent = false;
  for (const o of obs) {
    if (o.do === null) continue;
    if (o.do <= crit) {
      if (!inEvent && (lastLowAt === null || o.t - lastLowAt >= REARM_MIN * 60000)) events.push({ start: o.t });
      inEvent = true; lastLowAt = o.t;
    } else if (inEvent && o.t - lastLowAt >= REARM_MIN * 60000) inEvent = false; // recovered for 30 min: next low is a new event
  }
  // early warnings = the forecast predicted a critical crossing (risk outlook CROSSING_EXPECTED)
  // while DO itself was still above critical; one warning per continuous predicted-crossing period
  const onsets = []; let warningOnsets = 0;
  let prevState = null; let streakStart = null; let lastPredAt = null;
  const streakAt = new Map(); // risk time -> start of the prediction period it belongs to
  for (const r of risks) {
    const pred = r.outlook === 'CROSSING_EXPECTED' && r.state !== 'CRITICAL';
    if (pred) {
      // a prediction that flickers off for less than 30 minutes is still the same warning
      if (lastPredAt === null || r.t - lastPredAt >= REARM_MIN * 60000) { onsets.push(r.t); streakStart = r.t; }
      streakAt.set(r.t, streakStart); lastPredAt = r.t;
    }
    if (r.state === 'WARNING' && prevState !== 'WARNING' && prevState !== 'CRITICAL') warningOnsets += 1;
    prevState = r.state;
  }
  const leads = [];
  let detected = 0;
  for (const e of events) {
    // the last prediction before the event, no more than one forecast window (+10 min tolerance) earlier
    const lastPred = [...risks].reverse().find((r) => streakAt.has(r.t) && r.t < e.start && e.start - r.t <= (WINDOW_MIN + 10) * 60000);
    if (lastPred) { detected += 1; leads.push((e.start - streakAt.get(lastPred.t)) / 60000); }
  }
  const notFollowed = onsets.filter((t) => !events.some((e) => e.start >= t && e.start - t <= (WINDOW_MIN + 10) * 60000));
  // a warning followed by aeration / a recorded action may have PREVENTED the event: report it separately
  const actedOn = notFollowed.filter((t) => interventions.some((a) => a >= t && a - t <= WINDOW_MIN * 60000)).length;
  const falseAlarms = notFollowed.length - actedOn;
  return {
    critical_threshold_mg_l: crit,
    critical_events: events.length,
    detected,
    missed: events.length - detected,
    detection_rate: events.length ? round(detected / events.length, 3) : null,
    median_lead_minutes: round(median(leads)),
    shortest_lead_minutes: leads.length ? round(Math.min(...leads)) : null,
    early_warnings: onsets.length,
    warning_state_onsets: warningOnsets,
    not_followed_by_event: notFollowed.length,
    not_followed_but_acted_on: actedOn,
    false_alarms: falseAlarms,
    false_alarm_ratio: onsets.length ? round(falseAlarms / onsets.length, 3) : null,
  };
}

/**
 * Forecast skill against the "no change" baseline, over the SAME readings:
 * skill = 1 - MAE(model) / MAE(no change). Above 0 = the model adds value; 0.3 = 30% smaller error.
 * forecasts: [{ h, t: target ms, p: predicted }]
 */
function computeSkill(obs, forecasts) {
  const byTime = new Map(obs.filter((o) => o.do !== null).map((o) => [o.t, o.do]));
  return HORIZONS.map((h) => {
    const modelErr = []; const baseErr = [];
    for (const f of forecasts) {
      if (f.h !== h) continue;
      const actual = byTime.get(f.t); const issuedAt = byTime.get(f.t - h * 60000);
      if (actual === undefined || issuedAt === undefined) continue; // compare only where both exist
      modelErr.push(Math.abs(f.p - actual)); baseErr.push(Math.abs(issuedAt - actual));
    }
    const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    const m = mean(modelErr); const b = mean(baseErr);
    return { horizon_minutes: h, samples: modelErr.length, model_mae: round(m, 3), baseline_mae: round(b, 3), skill: m !== null && b ? round(1 - m / b, 3) : null };
  });
}

/**
 * alerts:  [{ t: ms, state, acknowledged_at: ms|null }]  (WARNING / CRITICAL onsets)
 * actions: [ms]  times operators recorded an activity or requested aeration
 */
function computeResponse(alerts, actions, now = Date.now()) {
  const ackMins = alerts.filter((a) => a.acknowledged_at).map((a) => (a.acknowledged_at - a.t) / 60000);
  const actMins = alerts.map((a) => { const n = actions.find((x) => x >= a.t && x - a.t <= WINDOW_MIN * 60000); return n === undefined ? null : (n - a.t) / 60000; }).filter((x) => x !== null);
  const open = alerts.filter((a) => !a.acknowledged_at && now - a.t > 15 * 60000).length;
  return {
    alerts: alerts.length,
    acknowledged: ackMins.length,
    median_minutes_to_acknowledge: round(median(ackMins)),
    acknowledged_within_15_min: ackMins.filter((m) => m <= 15).length,
    not_acknowledged: open,
    with_action_within_2h: actMins.length,
    median_minutes_to_first_action: round(median(actMins)),
  };
}

/** deliveries: [{ dispatch_created: ms, status, confirmed_at: ms|null }] for RISK / ESCALATION alerts */
function computeDelivery(deliveries) {
  const push = deliveries;
  const sent = push.filter((d) => d.status !== 'FAILED');
  const confirmed = push.filter((d) => d.status === 'CONFIRMED');
  const delays = confirmed.filter((d) => d.confirmed_at).map((d) => (d.confirmed_at - d.dispatch_created) / 1000);
  return {
    push_sent: sent.length,
    push_failed: push.length - sent.length,
    push_confirmed: confirmed.length,
    confirmation_rate: sent.length ? round(confirmed.length / sent.length, 3) : null,
    median_seconds_to_phone: round(median(delays)),
  };
}

// ---------------- loading from the database ----------------
async function pageAll(build, max = 10000) {
  const out = [];
  for (let from = 0; from < max; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

async function loadWarningPerformance(db, { from, to }) {
  const [obsRows, riskRows, alertRows, events, commands, fcRows] = await Promise.all([
    pageAll(() => db.from('raw_observations').select('timestamp_utc, do_mg_l, do_mg_l_status').gte('timestamp_utc', from).lt('timestamp_utc', to).order('timestamp_utc')),
    pageAll(() => db.from('risk_assessments').select('current_risk_state, forecast_outlook, rule_version, raw_observations!inner(timestamp_utc)')
      .gte('raw_observations.timestamp_utc', from).lt('raw_observations.timestamp_utc', to).order('assessment_timestamp_utc')),
    pageAll(() => db.from('risk_alerts').select('observation_timestamp_utc, current_risk_state, acknowledged_at').in('current_risk_state', ['WARNING', 'CRITICAL'])
      .gte('observation_timestamp_utc', from).lt('observation_timestamp_utc', to).order('observation_timestamp_utc'), 3000),
    pageAll(() => db.from('management_events').select('recorded_at_utc').gte('recorded_at_utc', from).order('recorded_at_utc'), 3000),
    pageAll(() => db.from('aerator_commands').select('requested_at_utc, requested_state, command_source').gte('requested_at_utc', from).order('requested_at_utc'), 3000),
    pageAll(() => db.from('forecasts').select('horizon_minutes, target_timestamp_utc, predicted_do_mg_l').eq('forecast_status', 'VALID')
      .gte('target_timestamp_utc', from).lt('target_timestamp_utc', to).order('target_timestamp_utc'), 40000),
  ]);
  const ms = (x) => new Date(x).getTime();
  const obs = obsRows.map((o) => ({ t: ms(o.timestamp_utc), do: o.do_mg_l_status === 'VALID' && o.do_mg_l !== null ? Number(o.do_mg_l) : null }));
  const risks = riskRows.map((r) => {
    const ro = Array.isArray(r.raw_observations) ? r.raw_observations[0] : r.raw_observations;
    return { t: ms(ro.timestamp_utc), state: r.current_risk_state, outlook: r.forecast_outlook, rule_version: r.rule_version };
  }).sort((a, b) => a.t - b.t);
  const alerts = alertRows.map((a) => ({ t: ms(a.observation_timestamp_utc), state: a.current_risk_state, acknowledged_at: a.acknowledged_at ? ms(a.acknowledged_at) : null }));
  // operator actions: recorded activities + aeration requested from the dashboard
  const actions = [...events.map((e) => ms(e.recorded_at_utc)), ...commands.filter((c) => c.command_source === 'MANUAL_DASHBOARD').map((c) => ms(c.requested_at_utc))].sort((a, b) => a - b);
  // interventions that can change DO: any aeration switched ON (manual or automatic) + recorded activities
  const interventions = [...events.map((e) => ms(e.recorded_at_utc)), ...commands.filter((c) => c.requested_state === 'ON').map((c) => ms(c.requested_at_utc))].sort((a, b) => a - b);

  let delivery = null;
  const { data: ds, error: dErr } = await db.from('alert_dispatches').select('dispatch_id, created_at').in('kind', ['RISK', 'ESCALATION'])
    .gte('created_at', from).lt('created_at', to).limit(1000);
  if (!dErr && ds.length) {
    const created = new Map(ds.map((d) => [d.dispatch_id, ms(d.created_at)]));
    const rows = [];
    for (let i = 0; i < ds.length; i += 200) {
      const { data } = await db.from('alert_deliveries').select('dispatch_id, status, confirmed_at').in('dispatch_id', ds.slice(i, i + 200).map((d) => d.dispatch_id));
      rows.push(...(data || []));
    }
    delivery = computeDelivery(rows.map((r) => ({ ...r, dispatch_created: created.get(r.dispatch_id), confirmed_at: r.confirmed_at ? ms(r.confirmed_at) : null })));
  }
  const forecasts = fcRows.map((f) => ({ h: f.horizon_minutes, t: ms(f.target_timestamp_utc), p: Number(f.predicted_do_mg_l) }));
  return { warning: computeWarningMetrics(obs, risks, interventions), skill: computeSkill(obs, forecasts), response: computeResponse(alerts, actions), delivery, readings: obs.length };
}

module.exports = { computeWarningMetrics, computeSkill, computeResponse, computeDelivery, loadWarningPerformance };
