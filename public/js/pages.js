// Placeholder pages. Each one calls the backend and fills simple placeholders.
// The real frontend can copy the calls and field names from here (see docs/API.md).
import { get, post, patch, qs } from './api.js';
import { html, raw, esc, fmtTime, fmtClock, fmtNum, ago, pill, toast, modal, errorBox, formData, localInputToIso } from './ui.js';
import { lineChart } from './chart.js';

const COLORS = { do: '#0d7a8a', forecast: '#0284c7', overlay: '#a855f7', critical: '#be123c', watch: '#b45309' };
const OVERLAYS = { water_temp_c: 'Water temp (°C)', ph_value: 'pH', light_lux: 'Light (lux)', air_temp_c: 'Air temp (°C)',
  relative_humidity_pct: 'Humidity (%)', atmospheric_pressure_hpa: 'Pressure (hPa)' };

function bandsFor(rule) {
  if (!rule || rule.critical_do_mg_l === null) return [];
  return [{ y: rule.watch_boundary_do_mg_l, label: `Boundary ${rule.watch_boundary_do_mg_l}`, color: COLORS.watch },
    { y: rule.critical_do_mg_l, label: `Critical ${rule.critical_do_mg_l}`, color: COLORS.critical }];
}

async function safe(root, fn) {
  try { await fn(); } catch (err) { if (!['SESSION_EXPIRED', 'SESSION_MISSING'].includes(err.code)) root.innerHTML = errorBox(err); }
}

// =====================================================================
// LIVE STATUS
// =====================================================================
async function live(root, ctx) {
  const render = () => safe(root, async () => {
    const [{ data: d, meta }, acts] = await Promise.all([get('/api/live'), get(`/api/activities${qs({ range: '7d', page_size: 4 })}`)]);
    ctx.setBanner(meta.freshness);
    const o = d.observation;
    const risk = d.risk?.current_risk_state || 'DATA_UNAVAILABLE';
    const doR = o?.readings.do_mg_l;
    root.innerHTML = html`
      <div class="page-head"><div><h2>Live Status</h2>
        <p>Latest cycle ${o ? fmtTime(o.timestamp_utc) : '--'} (${o ? ago(o.timestamp_utc) : 'no data'}) · ${d.station?.site_description || ''}</p></div></div>
      ${!o ? raw('<div class="empty">No observations have been received yet. When the edge device syncs its first cycle, it will appear here.</div>') : ''}
      <div class="grid g2">
        <section class="panel">
          <div class="row"><h3>Dissolved Oxygen</h3><span class="spacer"></span>${pill(risk)}</div>
          <p class="sub">Current observation &amp; official AquaCast risk (rule ${d.rule_reference.rule_version})</p>
          <div class="big-do">${doR?.usable ? fmtNum(doR.value) : '--'} <span class="muted small">mg/L</span></div>
          ${doR && !doR.usable ? raw(`<div class="notice error">DO reading not usable: ${esc(doR.quality_status)}</div>`) : ''}
          <p class="small muted">Normal/Watch boundary ${d.rule_reference.watch_boundary_do_mg_l} mg/L · Critical ≤ ${d.rule_reference.critical_do_mg_l} mg/L</p>
          ${!d.risk?.available && o ? raw(`<div class="notice">${esc(d.risk.message)}</div>`) : ''}
        </section>
        <section class="panel grid g2">
          <div class="kpi"><div class="label">DO Trend (1 h)</div><div class="value">${d.trend?.label || '--'}</div>
            <div class="hint">${d.trend?.slope_mg_l_per_hr ?? '--'} mg/L/hr</div></div>
          <div class="kpi"><div class="label">Critical Outlook</div>
            <div class="value">${d.critical_outlook.crossing_expected ? fmtClock(d.critical_outlook.expected_threshold_crossing_utc) : 'None ≤ 120 min'}</div>
            <div class="hint">${d.risk?.forecast_outlook || 'DATA_UNAVAILABLE'}</div></div>
          <div class="kpi"><div class="label">Active Alerts (24 h)</div><div class="value">${d.active_alerts}</div><div class="hint"><a href="#alerts">Review alerts</a></div></div>
          <div class="kpi"><div class="label">Record status</div><div class="value">${o?.record_status || '--'}</div>
            <div class="hint">${o ? `acquired ${fmtClock(o.acquisition_started_at_utc)}` : ''}</div></div>
        </section>
      </div>
      <div class="grid g2" style="margin-top:14px">
        <section class="panel"><h3>Forecasts (this cycle)</h3><p class="sub">+30 / +60 / +90 / +120 min · XGBoost</p>
          <table><tr><th>Horizon</th><th>Predicted DO</th><th>Status</th><th>Target</th></tr>
          ${d.forecasts.map((f) => raw(html`<tr><td>+${f.horizon_minutes} min</td><td>${fmtNum(f.predicted_do_mg_l)}</td><td>${pill(f.forecast_status)}</td><td>${fmtClock(f.target_timestamp_utc)}</td></tr>`))}
          </table></section>
        <section class="panel" id="aerator-panel"></section>
      </div>
      <div class="grid g2" style="margin-top:14px">
        <section class="panel"><h3>Environmental Context</h3><p class="sub">Supporting measurements from the same cycle (not proof of cause)</p>
          <div class="readings">${o ? Object.entries(o.readings).filter(([k]) => k !== 'do_mg_l').map(([, r]) => raw(html`
            <div class="reading ${r.usable ? '' : 'bad'}"><div class="label">${r.label}</div>
            <div class="value">${r.usable ? fmtNum(r.value, r.unit === 'lux' ? 0 : 1) : '--'} <span class="small muted">${r.unit}</span></div>
            ${r.usable ? '' : raw(`<div class="small">${esc(r.quality_status)}</div>`)}</div>`)) : ''}</div></section>
        <section class="panel"><h3>System Health</h3><p class="sub">Raspberry Pi report ${d.system_health ? (d.system_health.matches_latest_observation ? '(this cycle)' : '(older cycle)') : ''}</p>
          ${d.system_health ? raw(html`<div class="kv">
            <div>CPU temp</div><div>${fmtNum(d.system_health.pi_cpu_temp_c, 1)} °C</div>
            <div>RAM used</div><div>${fmtNum(d.system_health.ram_used_pct, 0)} %</div>
            <div>Free storage</div><div>${fmtNum(d.system_health.storage_free_mb, 0)} MB</div>
            <div>Wi-Fi</div><div>${d.system_health.wifi_connected ? `connected (${d.system_health.wifi_signal_rssi_dbm} dBm)` : 'disconnected'}</div>
            <div>Internet</div><div>${d.system_health.internet_reachable ? 'reachable' : 'unreachable'}</div>
            <div>Last cloud sync</div><div>${fmtTime(d.system_health.last_cloud_sync_at_utc)}</div>
            <div>Buses</div><div>RS485 ${pill(d.system_health.rs485_bus_status)} I2C ${pill(d.system_health.i2c_bus_status)}</div>
            <div>Battery</div><div>${fmtNum(d.system_health.battery_voltage_v)} V</div></div>`) : raw('<div class="empty">No system health report available.</div>')}
        </section>
      </div>
      <section class="panel" style="margin-top:14px"><div class="row"><h3>Recent Activity</h3><span class="spacer"></span>
        <button type="button" data-act="log">Log Activity</button><a href="#activities">View full activity log →</a></div>
        ${acts.data.length ? raw(acts.data.map((a) => html`<div class="row small" style="padding:6px 0;border-bottom:1px solid var(--line)">
          ${pill(a.category)} <strong>${a.event_type}</strong> <span class="muted">${a.details}</span><span class="spacer"></span>
          <span class="muted">${a.actor_name || a.source} · ${fmtTime(a.occurred_at)}</span></div>`).join('')) : raw('<div class="empty">No recent activity.</div>')}
      </section>`;
    renderAerator(root.querySelector('#aerator-panel'), d.aerator, render);
    root.querySelector('[data-act=log]').addEventListener('click', () => activityModal(render));
  });
  await render();
  const t = setInterval(render, 60_000);
  ctx.onCleanup(() => clearInterval(t));
}

function renderAerator(el, a, refresh) {
  if (!a.initialized) { el.innerHTML = html`<h3>Manual Aeration</h3><div class="empty">${a.message}</div>`; return; }
  const p = a.pending_command;
  el.innerHTML = html`
    <h3>Manual Aeration</h3><p class="sub">Dashboard → Raspberry Pi → controller. A request is not the same as the aerator running.</p>
    <div class="steps">
      <div class="step"><span class="muted">1 · Requested</span><strong>${p ? `${p.requested_state} (pending)` : a.last_applied_command?.requested_state || '--'}</strong></div>
      <div class="step"><span class="muted">2 · Mode</span><strong>${a.mode.applied_mode}</strong>${a.mode.acknowledged ? '' : raw('<span class="small">change pending</span>')}</div>
      <div class="step"><span class="muted">3 · Controller ack</span><strong>${a.controller.output_state}</strong><span class="small">${a.controller.output_reported_at_utc ? ago(a.controller.output_reported_at_utc) : ''}</span></div>
      <div class="step"><span class="muted">4 · Report</span><strong>${a.controller.stale ? 'STALE' : 'Fresh'}</strong></div>
      <div class="step"><span class="muted">5 · Physical motor</span><strong>Not measured</strong></div>
    </div>
    <p class="small muted">${a.controller.note}</p>
    ${p ? raw(html`<div class="notice">Command ${pill(p.effective_status)} ${p.status_text} <span class="mono">${p.command_id.slice(0, 8)}</span> · expires ${fmtClock(p.expires_at_utc)}</div>`) : ''}
    ${a.manual_command_blocked_reason ? raw(`<div class="notice">${esc(a.manual_command_blocked_reason)}</div>`) : ''}
    <div class="row" style="margin-top:10px">
      <button class="primary" type="button" data-cmd="ON" ${a.can_request_manual_command ? '' : 'disabled'}>Request Aerator ON</button>
      <button type="button" data-cmd="OFF" ${a.can_request_manual_command ? '' : 'disabled'}>Request Aerator OFF</button>
    </div>
    <details style="margin-top:10px"><summary class="small">Recent commands</summary>
      <table><tr><th>Requested</th><th>State</th><th>Source</th><th>Status</th><th>Applied</th></tr>
      ${a.recent_commands.map((c) => raw(html`<tr><td>${fmtTime(c.requested_at_utc)}</td><td>${c.requested_state}</td><td>${c.command_source}</td>
        <td>${pill(c.effective_status)}${c.failure_reason ? raw(`<div class="small muted">${esc(c.failure_reason)}</div>`) : ''}</td><td>${fmtClock(c.applied_at_utc)}</td></tr>`))}
      </table></details>`;
  el.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', async () => {
    const state = b.dataset.cmd;
    if (!confirm(`Send an aerator ${state} request to the controller?`)) return;
    b.disabled = true;
    try {
      const key = crypto.randomUUID(); // idempotency key: safe to retry
      const r = await post('/api/aerator/commands', { requested_state: state }, { headers: { 'Idempotency-Key': key } });
      toast(r.meta.message);
      pollCommand(r.data.command_id, refresh);
      refresh();
    } catch (err) { toast(err.message, 'error'); b.disabled = false; }
  }));
}

function pollCommand(id, refresh) {
  let n = 0;
  const t = setInterval(async () => {
    n += 1;
    try {
      const { data } = await get(`/api/aerator/commands/${id}`);
      if (data.effective_status !== 'PENDING' || n > 60) {
        clearInterval(t);
        toast(`Aerator ${data.requested_state}: ${data.effective_status.replaceAll('_', ' ')}. ${data.status_text}`, data.effective_status === 'APPLIED' ? '' : 'error');
        refresh();
      }
    } catch { clearInterval(t); }
  }, 3000);
}

async function activityModal(onSaved) {
  const { data: types } = await get('/api/activities/types');
  modal(html`<h3>Record Pond Activity</h3>
    <form><label>Activity type</label><select name="event_type">${types.map((t) => raw(html`<option value="${t.value}">${t.label}</option>`))}</select>
    <label>Start (Manila time, blank = now)</label><input name="start" type="datetime-local">
    <label>End (optional)</label><input name="end" type="datetime-local">
    <label>Notes</label><textarea name="notes" rows="3" placeholder="Describe what was done or observed."></textarea>
    <div class="row" style="margin-top:12px"><span class="spacer"></span><button type="button" data-close>Cancel</button><button class="primary">Save to Activity Log</button></div></form>`,
  (m, close) => m.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    try {
      await post('/api/activities', { event_type: f.event_type, notes: f.notes, event_start_utc: localInputToIso(f.start) || undefined,
        event_end_utc: localInputToIso(f.end) || undefined }, { headers: { 'Idempotency-Key': crypto.randomUUID() } });
      toast('Activity saved to Supabase.'); close(); onSaved?.();
    } catch (err) { toast(err.message, 'error'); }
  }));
}

// =====================================================================
// FORECAST & RISK
// =====================================================================
async function forecast(root, ctx) {
  await safe(root, async () => {
    const { data: d, meta } = await get('/api/forecast/latest');
    ctx.setBanner(meta.freshness);
    if (!d) { root.innerHTML = '<div class="empty">No forecast cycle available yet.</div>'; return; }
    const origin = new Date(d.origin.forecast_origin_utc);
    const progression = [{ x: origin, y: d.origin.do_mg_l_status === 'VALID' ? d.origin.do_mg_l : null },
      ...d.horizons.map((h) => ({ x: new Date(origin.getTime() + h.horizon_minutes * 60000), y: h.predicted_do_mg_l }))];
    root.innerHTML = html`
      <div class="page-head"><div><h2>Dissolved Oxygen Forecast &amp; Risk</h2><p>Forecast origin ${fmtTime(d.origin.forecast_origin_utc)} · rule ${d.rule_reference.rule_version}</p></div>
        <span class="spacer"></span>${pill(d.risk.current_risk_state)}</div>
      <div class="grid g4">
        <div class="panel kpi"><div class="label">Forecast Origin</div><div class="value">${fmtNum(d.origin.do_mg_l)} <small>mg/L</small></div></div>
        <div class="panel kpi"><div class="label">Valid horizons</div><div class="value">${d.summary.valid_horizons} / 4</div></div>
        <div class="panel kpi"><div class="label">Earliest Critical</div><div class="value">${d.summary.earliest_critical_horizon_minutes ? `+${d.summary.earliest_critical_horizon_minutes} min` : 'None'}</div></div>
        <div class="panel kpi"><div class="label">Projected change (+120)</div><div class="value">${fmtNum(d.summary.projected_change_120_mg_l)} <small>mg/L</small></div></div>
      </div>
      <div class="grid g4" style="margin-top:14px">${d.horizons.map((h) => raw(html`<div class="panel kpi">
        <div class="row"><span class="label">+${h.horizon_minutes} Minute Forecast</span><span class="spacer"></span>${pill(h.threshold_status)}</div>
        <div class="value">${fmtNum(h.predicted_do_mg_l)} <small>mg/L</small></div>
        <div class="hint">${h.forecast_status} · Δ ${fmtNum(h.change_from_origin_mg_l)} · model ${h.model?.version || '--'}</div></div>`))}</div>
      <section class="panel" style="margin-top:14px"><h3>Forecast Progression</h3>
        ${raw(lineChart([{ name: 'Origin → forecasts', color: COLORS.forecast, dashed: true, points: progression }], { bands: bandsFor(d.rule_reference), yLabel: 'DO mg/L', xFormat: (x) => fmtClock(x.toISOString()) }))}</section>
      <div class="grid g2" style="margin-top:14px">
        <section class="panel"><h3>Official risk assessment</h3>
          <div class="kv"><div>Current risk</div><div>${pill(d.risk.current_risk_state)}</div>
          <div>Forecast outlook</div><div>${d.risk.forecast_outlook}</div>
          <div>Expected crossing</div><div>${fmtTime(d.risk.expected_threshold_crossing_utc)}</div>
          <div>Assessed at</div><div>${fmtTime(d.risk.assessment_timestamp_utc)}</div></div></section>
        <section class="panel"><h3>Risk rules (reference)</h3><p class="sub">${d.rule_reference.source}</p>
          <ul class="small">${d.rule_reference.description.map((x) => raw(`<li>${esc(x)}</li>`))}</ul></section>
      </div>
      <section class="panel" style="margin-top:14px"><div class="row"><h3>Forecast vs Observed (last 24 h)</h3><span class="spacer"></span>
        <select id="fh" style="width:auto">${[30, 60, 90, 120].map((h) => raw(`<option value="${h}" ${h === 60 ? 'selected' : ''}>+${h} min</option>`))}</select></div>
        <div id="fvo" class="loading">Loading...</div></section>`;
    const loadFvo = async () => {
      const box = root.querySelector('#fvo');
      try {
        const { data } = await get(`/api/forecast/history${qs({ horizon: root.querySelector('#fh').value, range: '24h' })}`);
        box.className = '';
        box.innerHTML = lineChart([
          { name: 'Observed', color: COLORS.do, points: data.points.map((p) => ({ x: new Date(p.target_timestamp_utc), y: p.observed_do_mg_l })) },
          { name: 'Forecast', color: COLORS.forecast, dashed: true, points: data.points.map((p) => ({ x: new Date(p.target_timestamp_utc), y: p.predicted_do_mg_l })) },
        ], { bands: bandsFor(d.rule_reference), yLabel: 'DO mg/L', xFormat: (x) => fmtClock(x.toISOString()) });
      } catch (err) { box.innerHTML = errorBox(err); }
    };
    root.querySelector('#fh').addEventListener('change', loadFvo);
    loadFvo();
  });
}

// =====================================================================
// HISTORY & TRENDS
// =====================================================================
async function history(root) {
  const st = { range: '24h', from: '', to: '', overlay: 'water_temp_c', page: 1 };
  root.innerHTML = html`<div class="page-head"><div><h2>Historical Observations &amp; Trends</h2><p>Query observations by date/time range.</p></div></div>
    <section class="panel"><div class="row">
      <select id="h-range" style="width:auto"><option value="24h">Past 24 Hours</option><option value="7d">Past 7 Days</option><option value="30d">Past 30 Days</option><option value="custom">Custom range</option></select>
      <input id="h-from" type="datetime-local" class="hidden" style="width:auto"><input id="h-to" type="datetime-local" class="hidden" style="width:auto">
      <select id="h-overlay" style="width:auto">${Object.entries(OVERLAYS).map(([k, v]) => raw(`<option value="${k}">DO vs ${esc(v)}</option>`))}</select>
      <button id="h-apply" class="primary" type="button">Apply</button><span class="spacer"></span><a id="h-csv" href="#">Export CSV</a></div></section>
    <div id="h-body" style="margin-top:14px"></div>`;
  const body = root.querySelector('#h-body');
  const rangeParams = () => (st.range === 'custom' ? { from: localInputToIso(st.from), to: localInputToIso(st.to) } : { range: st.range });

  async function load() {
    body.innerHTML = '<div class="loading">Loading...</div>';
    await safe(body, async () => {
      const p = rangeParams();
      root.querySelector('#h-csv').href = `/api/history/export.csv${qs(p)}`;
      const [sum, series, rows] = await Promise.all([get(`/api/history/summary${qs(p)}`), get(`/api/history/series${qs(p)}`),
        get(`/api/history/observations${qs({ ...p, page: st.page, page_size: 25 })}`)]);
      const s = sum.data;
      const pts = series.data;
      body.innerHTML = html`
        <div class="grid g4">
          <div class="panel kpi"><div class="label">Records Shown</div><div class="value">${s.records}</div></div>
          <div class="panel kpi"><div class="label">Average DO</div><div class="value">${fmtNum(s.avg_do)} <small>mg/L</small></div></div>
          <div class="panel kpi"><div class="label">Historical DO Range</div><div class="value">${fmtNum(s.min_do)}–${fmtNum(s.max_do)}</div></div>
          <div class="panel kpi"><div class="label">Elevated Risk Records</div><div class="value">${s.elevated_risk_records} <small>(${s.critical_records} critical)</small></div></div>
        </div>
        <section class="panel" style="margin-top:14px"><h3>Dissolved Oxygen &amp; Context Trend</h3><p class="sub">${series.meta.bucket_minutes}-minute averages · net change ${fmtNum(s.net_do_change)} mg/L</p>
          ${raw(lineChart([{ name: 'DO (mg/L)', color: COLORS.do, points: pts.map((r) => ({ x: new Date(r.bucket_start), y: r.do_mg_l })) }],
    { bands: bandsFor({ critical_do_mg_l: 3, watch_boundary_do_mg_l: 5 }), yLabel: 'DO mg/L', xFormat: (x) => fmtTime(x.toISOString()) }))}
          ${raw(lineChart([{ name: OVERLAYS[st.overlay], color: COLORS.overlay, points: pts.map((r) => ({ x: new Date(r.bucket_start), y: r[st.overlay] })) }],
    { yLabel: OVERLAYS[st.overlay], height: 180, xFormat: (x) => fmtTime(x.toISOString()) }))}
        </section>
        <section class="panel" style="margin-top:14px"><h3>Observation Records</h3>
          <div class="table-wrap"><table><tr><th>Timestamp</th><th>DO</th><th>Water °C</th><th>pH</th><th>Lux</th><th>Air °C</th><th>RH %</th><th>hPa</th><th>Record</th><th>Recorded Risk</th><th>Aeration</th></tr>
          ${rows.data.map((r) => raw(html`<tr><td>${fmtTime(r.timestamp_utc)}</td><td>${r.do_mg_l_status === 'VALID' ? fmtNum(r.do_mg_l) : r.do_mg_l_status}</td>
            <td>${fmtNum(r.water_temp_c, 1)}</td><td>${r.ph_status === 'VALID' ? fmtNum(r.ph_value) : r.ph_status}</td><td>${r.light_status === 'VALID' ? fmtNum(r.light_lux, 0) : r.light_status}</td>
            <td>${fmtNum(r.air_temp_c, 1)}</td><td>${fmtNum(r.relative_humidity_pct, 0)}</td><td>${fmtNum(r.atmospheric_pressure_hpa, 1)}</td><td>${r.record_status}</td>
            <td>${pill(r.recorded_risk_state || 'NONE')}</td><td class="small">${r.aeration_recorded}</td></tr>`))}</table></div>
          <div class="pager">Page ${rows.meta.page} of ${rows.meta.total_pages || 1} (${rows.meta.total} records)
            <button type="button" data-p="-1" ${st.page <= 1 ? 'disabled' : ''}>Prev</button><button type="button" data-p="1" ${st.page >= rows.meta.total_pages ? 'disabled' : ''}>Next</button></div>
        </section>`;
      body.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => { st.page += Number(b.dataset.p); load(); }));
    });
  }
  root.querySelector('#h-range').addEventListener('change', (e) => {
    const custom = e.target.value === 'custom';
    root.querySelector('#h-from').classList.toggle('hidden', !custom); root.querySelector('#h-to').classList.toggle('hidden', !custom);
  });
  root.querySelector('#h-apply').addEventListener('click', () => {
    st.range = root.querySelector('#h-range').value; st.from = root.querySelector('#h-from').value; st.to = root.querySelector('#h-to').value;
    st.overlay = root.querySelector('#h-overlay').value; st.page = 1;
    if (st.range === 'custom' && (!st.from || !st.to)) { toast('Pick both a start and an end time.', 'error'); return; }
    load();
  });
  load();
}

// =====================================================================
// ALERTS
// =====================================================================
async function alerts(root) {
  const render = () => safe(root, async () => {
    const [active, acked] = await Promise.all([get('/api/alerts?status=active'), get('/api/alerts?status=acknowledged&range=7d')]);
    const card = (a, canAck) => raw(html`<div class="panel" style="margin-bottom:10px">
      <div class="row">${pill(a.current_risk_state)}<strong>${a.previous_risk_state || 'START'} → ${a.current_risk_state}</strong><span class="spacer"></span><span class="muted small">${fmtTime(a.observation_timestamp_utc)}</span></div>
      <div class="kv" style="margin-top:8px"><div>Current DO at alert</div><div>${fmtNum(a.do_mg_l)} mg/L</div>
      <div>Lowest forecast</div><div>${fmtNum(a.min_forecast_do_mg_l)} mg/L</div><div>Outlook</div><div>${a.forecast_outlook} ${a.expected_threshold_crossing_utc ? `(crossing ~${fmtClock(a.expected_threshold_crossing_utc)})` : ''}</div>
      <div>Guidance</div><div><strong>${a.guidance.title}</strong><ul class="small">${a.guidance.steps.map((s) => raw(`<li>${esc(s)}</li>`))}</ul></div></div>
      ${canAck ? raw(`<button type="button" data-ack="${esc(a.risk_id)}">Acknowledge</button>`) : raw(html`<div class="small muted">Acknowledged by ${a.acknowledged_by_name || 'an operator'} ${ago(a.acknowledged_at)} ${a.acknowledgement_note ? `· "${a.acknowledgement_note}"` : ''}</div>`)}
    </div>`);
    root.innerHTML = html`<div class="page-head"><div><h2>Alerts &amp; Warning Center</h2><p>Alerts are the cycles where the official risk state changed into WATCH, WARNING or CRITICAL.</p></div></div>
      <div class="grid g3"><div class="panel kpi"><div class="label">Highest active severity</div><div class="value">${active.meta.highest_severity}</div></div>
      <div class="panel kpi"><div class="label">Active unacknowledged (24 h)</div><div class="value">${active.meta.total}</div></div>
      <div class="panel kpi"><div class="label">Acknowledged (7 d)</div><div class="value">${acked.meta.total}</div></div></div>
      <h3 style="margin-top:18px">Active Alerts</h3>${active.data.length ? active.data.map((a) => card(a, true)) : raw('<div class="empty">No unacknowledged alerts.</div>')}
      <h3 style="margin-top:18px">Acknowledged Alerts</h3>${acked.data.length ? acked.data.map((a) => card(a, false)) : raw('<div class="empty">No acknowledged alerts in the last 7 days.</div>')}
      <p class="small muted">Acknowledgement confirms an operator reviewed the alert. It does not mean the pond condition has returned to normal.</p>`;
    root.querySelectorAll('[data-ack]').forEach((b) => b.addEventListener('click', async () => {
      const note = prompt('Optional note for this acknowledgement:') ?? null;
      try { await post(`/api/alerts/${b.dataset.ack}/acknowledge`, { note }); toast('Alert acknowledged.'); render(); } catch (err) { toast(err.message, 'error'); }
    }));
  });
  await render();
}

// =====================================================================
// ACTIVITY LOG
// =====================================================================
async function activities(root) {
  const st = { category: '', q: '', page: 1, range: '7d' };
  const render = () => safe(root, async () => {
    const [sum, list] = await Promise.all([get(`/api/activities/summary${qs({ range: st.range })}`),
      get(`/api/activities${qs({ range: st.range, category: st.category, q: st.q, page: st.page, page_size: 25 })}`)]);
    const c = sum.data.by_category;
    root.innerHTML = html`<div class="page-head"><div><h2>Activity &amp; Event Log</h2><p>Pond activities, aeration commands, system warnings and admin actions.</p></div>
        <span class="spacer"></span><button class="primary" type="button" id="a-new">Record Pond Activity</button></div>
      <div class="grid g4"><div class="panel kpi"><div class="label">Total records (${st.range})</div><div class="value">${sum.data.total}</div></div>
        <div class="panel kpi"><div class="label">Pond activities</div><div class="value">${c.POND_ACTIVITY + c.MAINTENANCE}</div></div>
        <div class="panel kpi"><div class="label">System &amp; alert events</div><div class="value">${c.SYSTEM_WARNING + c.ALERT}</div></div>
        <div class="panel kpi"><div class="label">Aeration commands / sessions</div><div class="value">${c.AERATOR_COMMAND} / ${c.AERATION}</div></div></div>
      <section class="panel" style="margin-top:14px"><div class="row">
        <select id="a-cat" style="width:auto"><option value="">All Events</option>${['POND_ACTIVITY', 'AERATION', 'MAINTENANCE', 'AERATOR_COMMAND', 'SYSTEM_WARNING', 'ALERT', 'USER_MANAGEMENT', 'SETTINGS']
    .map((k) => raw(`<option value="${k}" ${st.category === k ? 'selected' : ''}>${k.replaceAll('_', ' ')}</option>`))}</select>
        <select id="a-range" style="width:auto">${['24h', '7d', '30d'].map((r) => raw(`<option ${st.range === r ? 'selected' : ''}>${r}</option>`))}</select>
        <input id="a-q" placeholder="Search type, user or details" value="${st.q}" style="max-width:280px"><button type="button" id="a-go">Search</button></div>
        <div class="table-wrap" style="margin-top:10px"><table><tr><th>Time</th><th>Category</th><th>Event Type</th><th>Source</th><th>User / Actor</th><th>Details</th></tr>
        ${list.data.length ? list.data.map((a) => raw(html`<tr><td>${fmtTime(a.occurred_at)}</td><td>${pill(a.category)}</td><td>${a.event_type}</td><td>${a.source}</td><td>${a.actor_name || '--'}</td><td class="small">${a.details}</td></tr>`))
    : raw('<tr><td colspan="6" class="muted">No activity records match the current filters.</td></tr>')}</table></div>
        <div class="pager">Page ${list.meta.page} of ${list.meta.total_pages || 1}<button type="button" data-p="-1" ${st.page <= 1 ? 'disabled' : ''}>Prev</button><button type="button" data-p="1" ${st.page >= list.meta.total_pages ? 'disabled' : ''}>Next</button></div></section>`;
    root.querySelector('#a-new').addEventListener('click', () => activityModal(render));
    root.querySelector('#a-go').addEventListener('click', () => {
      st.category = root.querySelector('#a-cat').value; st.range = root.querySelector('#a-range').value; st.q = root.querySelector('#a-q').value.trim(); st.page = 1; render();
    });
    root.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => { st.page += Number(b.dataset.p); render(); }));
  });
  await render();
}

// =====================================================================
// SENSORS & DEVICE
// =====================================================================
async function sensors(root, ctx) {
  await safe(root, async () => {
    const [{ data: d, meta }, h] = await Promise.all([get('/api/sensors'), get('/api/sensors/health?range=24h')]);
    ctx.setBanner(meta.freshness);
    const hs = d.system_health;
    root.innerHTML = html`<div class="page-head"><div><h2>Sensors &amp; Device Health</h2><p>Sensor registry, calibration records and Raspberry Pi health.</p></div></div>
      <div class="grid g4"><div class="panel kpi"><div class="label">Registered sensors</div><div class="value">${d.sensors.length}</div><div class="hint">${d.sensors.filter((s) => s.status === 'ACTIVE').length} active</div></div>
        <div class="panel kpi"><div class="label">Latest reading</div><div class="value">${d.latest_observation_utc ? ago(d.latest_observation_utc) : '--'}</div></div>
        <div class="panel kpi"><div class="label">RS485 / I2C bus</div><div class="value">${hs ? `${hs.rs485_bus_status} / ${hs.i2c_bus_status}` : '--'}</div></div>
        <div class="panel kpi"><div class="label">Local database</div><div class="value">${hs ? (hs.local_database_operational ? 'OK' : 'FAULT') : '--'}</div></div></div>
      <section class="panel" style="margin-top:14px"><h3>Sensor Registry</h3><div class="table-wrap"><table>
        <tr><th>Sensor</th><th>Type</th><th>Serial</th><th>Lifecycle</th><th>Latest readings</th><th>Data</th><th>Last calibration</th><th></th></tr>
        ${d.sensors.map((s) => raw(html`<tr><td><strong>${s.manufacturer}</strong> ${s.model}</td><td>${s.sensor_type}</td><td class="mono">${s.serial_number || '--'}</td><td>${pill(s.status)}</td>
          <td class="small">${s.latest_readings.map((r) => `${r.label}: ${r.usable ? fmtNum(r.value, 2) : r.quality_status}`).join(' · ') || '--'}</td>
          <td>${pill(s.data_status)}</td><td class="small">${s.latest_calibration ? `${s.latest_calibration.calibration_type} ${s.latest_calibration.result} · ${fmtTime(s.latest_calibration.calibration_started_at_utc)}` : 'none'}</td>
          <td><button type="button" data-cal="${s.sensor_id}">History</button></td></tr>`))}</table></div></section>
      <section class="panel" style="margin-top:14px"><h3>Raspberry Pi health (24 h)</h3>
        ${raw(lineChart([{ name: 'CPU °C', color: '#c2410c', points: h.data.map((r) => ({ x: new Date(r.timestamp_utc), y: r.pi_cpu_temp_c })) },
    { name: 'RAM %', color: '#0284c7', points: h.data.map((r) => ({ x: new Date(r.timestamp_utc), y: r.ram_used_pct })) }], { yLabel: 'value', height: 200, xFormat: (x) => fmtClock(x.toISOString()) }))}
      </section>`;
    root.querySelectorAll('[data-cal]').forEach((b) => b.addEventListener('click', async () => {
      try {
        const { data } = await get(`/api/sensors/${b.dataset.cal}/calibrations`);
        modal(html`<h3>${data.sensor.model}</h3><table><tr><th>Started</th><th>Type</th><th>Result</th><th>Notes</th></tr>
          ${data.calibrations.map((c) => raw(html`<tr><td>${fmtTime(c.calibration_started_at_utc)}</td><td>${c.calibration_type}</td><td>${pill(c.result)}</td><td class="small">${c.notes || ''}</td></tr>`))}</table>
          <div class="row" style="margin-top:10px"><span class="spacer"></span><button type="button" data-close>Close</button></div>`);
      } catch (err) { toast(err.message, 'error'); }
    }));
  });
}

// =====================================================================
// MODEL EVALUATION (admin)
// =====================================================================
async function evaluation(root) {
  await safe(root, async () => {
    const { data: d, meta } = await get('/api/evaluation');
    root.innerHTML = html`<div class="page-head"><div><h2>Model Evaluation</h2><p>${meta.basis}</p></div></div>
      <div class="notice">${meta.caution}</div>
      <section class="panel" style="margin-top:14px"><h3>Performance by horizon</h3><table>
        <tr><th>Horizon</th><th>Lead steps</th><th>Deployed model</th><th>MAE</th><th>RMSE</th><th>R²</th><th>Bias</th><th>Samples</th></tr>
        ${d.horizons.map((h) => raw(html`<tr><td>+${h.horizon_minutes} min</td><td>${h.lead_steps}</td><td>${h.deployed_model ? `${h.deployed_model.model_name} (${h.deployed_model.version})` : 'none'}</td>
          <td>${fmtNum(h.mae, 3)}</td><td>${fmtNum(h.rmse, 3)}</td><td>${fmtNum(h.r2, 3)}</td><td>${fmtNum(h.mean_bias, 3)}</td><td>${h.samples}</td></tr>`))}</table></section>
      <section class="panel" style="margin-top:14px"><div class="row"><h3>Actual vs Predicted (48 h)</h3><span class="spacer"></span>
        <select id="ev-h" style="width:auto">${[30, 60, 90, 120].map((h) => raw(`<option value="${h}">+${h} min</option>`))}</select></div><div id="ev-chart"></div></section>
      <section class="panel" style="margin-top:14px"><h3>Registered models</h3><table><tr><th>Name</th><th>Horizon</th><th>Version</th><th>Status</th><th>Training window</th><th>Artifact</th></tr>
        ${d.models.map((m) => raw(html`<tr><td>${m.model_name}</td><td>+${m.forecast_horizon_min}</td><td>${m.version}</td><td>${pill(m.deployment_status)}</td>
          <td class="small">${fmtTime(m.training_start_utc)} – ${fmtTime(m.training_end_utc)}</td><td class="mono">${m.model_file_name}</td></tr>`))}</table></section>`;
    const load = async () => {
      const box = root.querySelector('#ev-chart');
      try {
        const { data } = await get(`/api/evaluation/series?horizon=${root.querySelector('#ev-h').value}`);
        box.innerHTML = lineChart([{ name: 'Observed', color: COLORS.do, points: data.points.map((p) => ({ x: new Date(p.target_timestamp_utc), y: p.observed })) },
          { name: 'Predicted', color: COLORS.forecast, dashed: true, points: data.points.map((p) => ({ x: new Date(p.target_timestamp_utc), y: p.predicted })) }],
        { yLabel: 'DO mg/L', xFormat: (x) => fmtTime(x.toISOString()) });
      } catch (err) { box.innerHTML = errorBox(err); }
    };
    root.querySelector('#ev-h').addEventListener('change', load);
    load();
  });
}

// =====================================================================
// USER DIRECTORY (admin)
// =====================================================================
async function users(root) {
  const st = { q: '' };
  const render = () => safe(root, async () => {
    const r = await get(`/api/users${qs({ q: st.q })}`);
    const pending = r.data.filter((u) => u.status === 'PENDING');
    const others = r.data.filter((u) => u.status !== 'PENDING');
    const roleLabel = (x) => (x === 'ADMIN' ? 'Administrator' : 'BFAR Staff');
    const actions = (u) => {
      if (u.is_self) return '<span class="small muted">You</span>';
      const b = [];
      if (u.status === 'PENDING') b.push(['approve', 'Approve'], ['reject', 'Reject']);
      if (u.status === 'ACTIVE') b.push(['suspend', 'Suspend'], ['role', 'Change role'], ['revoke', 'Revoke']);
      if (u.status === 'SUSPENDED') b.push(['reactivate', 'Reactivate'], ['revoke', 'Revoke']);
      b.push(['edit', 'Edit']);
      return b.map(([a, l]) => `<button type="button" class="${['revoke', 'reject', 'suspend'].includes(a) ? 'danger' : ''}" data-ua="${a}" data-uid="${esc(u.user_id)}">${l}</button>`).join(' ');
    };
    const row = (u) => raw(html`<tr><td><strong>${u.full_name || '--'}</strong><div class="small muted">${u.organization || ''}</div></td><td>${u.email}
      <div class="small ${u.auth?.email_confirmed_at ? 'muted' : ''}">${u.auth ? (u.auth.email_confirmed_at ? 'email verified' : 'email NOT verified') : ''}</div></td>
      <td>${roleLabel(u.role)}</td><td>${pill(u.status)}${u.status_reason ? raw(`<div class="small muted">${esc(u.status_reason)}</div>`) : ''}</td>
      <td class="small">${u.last_login_at ? ago(u.last_login_at) : 'never'}</td><td class="small">${fmtTime(u.created_at)}</td><td>${raw(actions(u))}</td></tr>`);
    const head = raw('<tr><th>User</th><th>Email</th><th>Role</th><th>Status</th><th>Last access</th><th>Registered</th><th>Actions</th></tr>');
    root.innerHTML = html`<div class="page-head"><div><h2>User Directory</h2><p>Supabase Auth holds credentials; access role and status live in user_access_profiles.</p></div>
        <span class="spacer"></span><button class="primary" type="button" id="u-invite">Invite Authorized User</button></div>
      <div class="grid g4">${['ACTIVE', 'PENDING', 'SUSPENDED', 'REVOKED'].map((s) => raw(html`<div class="panel kpi"><div class="label">${s}</div><div class="value">${r.meta.counts[s]}</div></div>`))}</div>
      <section class="panel" style="margin-top:14px"><h3>Pending Access Requests</h3>
        ${pending.length ? raw(`<div class="table-wrap"><table>${head.value}${pending.map((u) => row(u).value).join('')}</table></div>`) : raw('<div class="empty">No pending access requests.</div>')}</section>
      <section class="panel" style="margin-top:14px"><div class="row"><h3>Authorized Directory</h3><span class="spacer"></span>
        <input id="u-q" placeholder="Search name, email, role" value="${st.q}" style="max-width:260px"><button type="button" id="u-go">Search</button></div>
        <div class="table-wrap"><table>${head}${others.map(row)}</table></div></section>`;
    root.querySelector('#u-go').addEventListener('click', () => { st.q = root.querySelector('#u-q').value.trim(); render(); });
    root.querySelector('#u-invite').addEventListener('click', () => modal(html`<h3>Invite Authorized User</h3><form>
      <label>Full name</label><input name="full_name" required><label>Official email</label><input name="email" type="email" required>
      <label>Organization / assignment</label><input name="organization"><label>Role</label><select name="role"><option value="BFAR_STAFF">BFAR Staff</option><option value="ADMIN">Administrator</option></select>
      <p class="small muted">Supabase emails an invitation link; the person sets their own password.</p>
      <div class="row"><span class="spacer"></span><button type="button" data-close>Cancel</button><button class="primary">Send invitation</button></div></form>`,
    (m, close) => m.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await post('/api/users/invite', formData(e.target)); toast('Invitation sent.'); close(); render(); } catch (err) { toast(err.message, 'error'); }
    })));
    root.querySelectorAll('[data-ua]').forEach((b) => b.addEventListener('click', () => userAction(b.dataset.ua, r.data.find((u) => u.user_id === b.dataset.uid), render)));
  });
  await render();
}

function userAction(action, u, done) {
  const needsReason = ['suspend', 'revoke', 'reject'].includes(action);
  const roleField = ['approve', 'role', 'reactivate'].includes(action);
  if (action === 'edit') {
    modal(html`<h3>Edit ${u.email}</h3><form><label>Full name</label><input name="full_name" value="${u.full_name}">
      <label>Organization</label><input name="organization" value="${u.organization || ''}"><label>Position</label><input name="position" value="${u.position || ''}">
      <div class="row" style="margin-top:12px"><span class="spacer"></span><button type="button" data-close>Cancel</button><button class="primary">Save</button></div></form>`,
    (m, close) => m.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await patch(`/api/users/${u.user_id}`, formData(e.target)); toast('Saved.'); close(); done(); } catch (err) { toast(err.message, 'error'); }
    }));
    return;
  }
  modal(html`<h3>${action[0].toUpperCase() + action.slice(1)}: ${u.full_name || u.email}</h3><form>
    ${roleField ? raw(html`<label>Role</label><select name="role"><option value="BFAR_STAFF" ${u.role === 'BFAR_STAFF' ? 'selected' : ''}>BFAR Staff</option><option value="ADMIN" ${u.role === 'ADMIN' ? 'selected' : ''}>Administrator</option></select>`) : ''}
    ${needsReason ? raw('<label>Reason (required)</label><textarea name="reason" rows="2" required></textarea>') : ''}
    <div class="row" style="margin-top:12px"><span class="spacer"></span><button type="button" data-close>Cancel</button><button class="primary">Confirm</button></div></form>`,
  (m, close) => m.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await post(`/api/users/${u.user_id}/${action}`, formData(e.target));
      toast(r.meta?.warning || `User is now ${r.data.status} (${r.data.role}).`, r.meta?.warning ? 'error' : '');
      close(); done();
    } catch (err) { toast(err.message, 'error'); }
  }));
}

// =====================================================================
// SYSTEM SETTINGS (admin) - only settings that exist in the database
// =====================================================================
async function settings(root) {
  const render = () => safe(root, async () => {
    const { data: d } = await get('/api/settings');
    let dev = null;
    try { dev = (await get('/api/dev/mock-edge')).data; } catch { /* mock edge disabled */ }
    const s = d.study;
    const a = d.aerator;
    root.innerHTML = html`<div class="page-head"><div><h2>System Settings</h2><p>Only settings stored in study_metadata and aerator_control_settings. Study guardrails are read-only.</p></div></div>
      <div class="grid g2">
        <section class="panel"><h3>Deployment profile (study_metadata)</h3>
          ${s ? raw(html`<form id="study-form">
            <label>Site description</label><input name="site_description" value="${s.site_description}">
            <div class="grid g3"><div><label>Culture species</label><input name="culture_species" value="${s.culture_species}"></div>
              <div><label>Culture stage</label><input name="culture_stage" value="${s.culture_stage}"></div>
              <div><label>Culture system</label><input name="culture_system" value="${s.culture_system}"></div></div>
            <div class="grid g4"><div><label>Pond length (m)</label><input name="pond_length_m" type="number" step="0.01" value="${s.pond_length_m}"></div>
              <div><label>Pond width (m)</label><input name="pond_width_m" type="number" step="0.01" value="${s.pond_width_m}"></div>
              <div><label>Pond depth (m)</label><input name="pond_depth_m" type="number" step="0.01" value="${s.pond_depth_m}"></div>
              <div><label>Probe depth (m)</label><input name="probe_depth_m" type="number" step="0.01" value="${s.probe_depth_m}"></div></div>
            <label>Timezone (IANA)</label><input name="timezone" value="${s.timezone}">
            <label>Notes</label><textarea name="notes" rows="2">${s.notes || ''}</textarea>
            <div class="row" style="margin-top:10px"><span class="small muted">Deployment started ${fmtTime(s.deployment_start_utc)}</span><span class="spacer"></span><button class="primary">Save Changes</button></div>
          </form>`) : raw('<div class="empty">No study_metadata row yet.</div>')}
        </section>
        <section class="panel"><h3>Aerator control mode (aerator_control_settings)</h3>
          ${a.initialized ? raw(html`<div class="kv"><div>Requested mode</div><div>${a.mode.requested_mode}</div><div>Applied mode</div><div>${a.mode.applied_mode}</div>
            <div>Revision</div><div>${a.mode.settings_revision} requested / ${a.mode.applied_revision ?? '--'} applied</div><div>Status</div><div>${a.mode.status_text}</div>
            <div>Automatic rule</div><div>${a.mode.automatic_rule_version || '--'}</div></div>
            <div class="row" style="margin-top:10px"><button type="button" data-mode="MANUAL" ${a.mode.requested_mode === 'MANUAL' ? 'disabled' : ''}>Request MANUAL</button>
              <button type="button" data-mode="AUTOMATIC" ${a.mode.requested_mode === 'AUTOMATIC' ? 'disabled' : ''}>Request AUTOMATIC</button></div>
            <p class="small muted">The Raspberry Pi acknowledges the new revision; pending manual commands from before the change are cancelled by the controller.</p>`) : raw(`<div class="empty">${esc(a.message)}</div>`)}
          <h3 style="margin-top:16px">Locked study parameters</h3>
          <div class="kv"><div>Sampling interval</div><div>${d.locked.sampling_interval_min} min</div><div>Forecast horizons</div><div>${d.locked.forecast_horizons_min.map((h) => `+${h}`).join(', ')} min</div>
            <div>Risk rule</div><div>${d.locked.risk_rule.rule_version} (critical ≤ ${d.locked.risk_rule.critical_do_mg_l}, boundary ${d.locked.risk_rule.watch_boundary_do_mg_l} mg/L)</div>
            <div>Deployed models</div><div>${d.locked.deployed_models.map((m) => `+${m.forecast_horizon_min}: ${m.version}`).join(' · ')}</div></div>
        </section>
      </div>
      ${dev ? raw(html`<section class="panel" style="margin-top:14px"><h3>Mock edge device (development only)</h3>
        <p class="sub">Simulated Raspberry Pi. Take it offline to test offline / delayed-sync / stale-controller states.</p>
        <div class="kv"><div>State</div><div>${dev.offline ? 'OFFLINE (not syncing)' : 'online'}</div><div>Last tick</div><div>${fmtTime(dev.last_tick_at)}</div><div>Last error</div><div>${dev.last_error || 'none'}</div></div>
        <div class="row" style="margin-top:10px"><button type="button" data-dev="${dev.offline ? 'online' : 'offline'}">${dev.offline ? 'Bring online' : 'Take offline'}</button><button type="button" data-dev="tick">Run a cycle now</button></div></section>`) : ''}`;
    root.querySelector('#study-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      const changed = Object.fromEntries(Object.entries(f).filter(([k, v]) => String(s[k] ?? '') !== v));
      if (!Object.keys(changed).length) { toast('No changes to save.'); return; }
      try { await patch('/api/settings/study', changed); toast('Deployment profile saved.'); render(); } catch (err) { toast(err.message, 'error'); }
    });
    root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(`Request ${b.dataset.mode} mode? The controller must acknowledge it.`)) return;
      try { const r = await post('/api/aerator/mode', { mode: b.dataset.mode }); toast(r.meta.message); render(); } catch (err) { toast(err.message, 'error'); }
    }));
    root.querySelectorAll('[data-dev]').forEach((b) => b.addEventListener('click', async () => {
      const body = b.dataset.dev === 'tick' ? { tick: true } : { offline: b.dataset.dev === 'offline' };
      try { await post('/api/dev/mock-edge', body); toast('Mock edge updated.'); render(); } catch (err) { toast(err.message, 'error'); }
    }));
  });
  await render();
}

export const pages = { live, forecast, history, alerts, activities, sensors, evaluation, users, settings };
