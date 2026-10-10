// Live Status: latest observation + official risk, condition overview, DO trend & forecast chart,
// operator guidance, manual aeration REQUEST (never direct control), environment, edge health, recent activity.
import { get, post, qs } from '../api.js';
import { html, raw, ic, esc, fmtNum, fmtTime, fmtDateTime, ago, riskKey, riskLabel, doBand, guidanceFor, toast, errorBox, busy } from '../ui.js';
import { mountChart, doZones, doThresholds, doDomain, DO_COLOR, FORECAST_COLOR } from '../chart.js';
import { openActivityModal, eventIcon, eventLabel } from './shared.js';

const ENV = [
  ['water_temp_c', 'thermometer', 'Water Temperature', (v) => `${fmtNum(v, 1)} °C`],
  ['ph_value', 'flask-conical', 'pH', (v) => fmtNum(v, 2)],
  ['light_lux', 'sun', 'Light Intensity', (v) => `${fmtNum(v, 0)} lux`],
  ['atmospheric_pressure_hpa', 'gauge', 'Atmospheric Pressure', (v) => `${fmtNum(v, 1)} hPa`],
  ['air_temp_c', 'wind', 'Ambient Temperature', (v) => `${fmtNum(v, 1)} °C`],
  ['relative_humidity_pct', 'droplets', 'Relative Humidity', (v) => `${fmtNum(v, 0)} %`],
];

// newest reading already shown on this device (kept while the app is open)
let lastSeenObs = null;
// DO Trend & Forecast: chosen past window (hours) and the recent forecast error per horizon
const LIVE_RANGES = [1, 4, 12, 24];
let liveRange = 4;
let accCache = null;
const BAND_COLOR = { normal: '#0d9488', watch: '#d97706', critical: '#e11d48', unknown: '#94a3b8' };
const valid = (q) => q && Number.isFinite(q.y);
const RISK_COLOR = { NORMAL: '#0f766e', WATCH: '#b45309', WARNING: '#ea580c', CRITICAL: '#e11d48' };

/** Typical forecast error (RMSE, mg/L) per horizon over the last 24 h; cached for 15 minutes. */
async function forecastAccuracy() {
  if (accCache && Date.now() - accCache.at < 15 * 60_000) return accCache.rmse;
  const H = [30, 60, 90, 120];
  const res = await Promise.all(H.map((h) => get(`/api/forecast/history${qs({ horizon: h, range: '24h' })}`).then((r) => r.data.points).catch(() => [])));
  const rmse = {};
  H.forEach((h, i) => {
    const e = res[i].map((p) => p.error_mg_l).filter(Number.isFinite);
    if (e.length >= 6) rmse[h] = Math.sqrt(e.reduce((a, x) => a + x * x, 0) / e.length);
  });
  accCache = { at: Date.now(), rmse };
  return rmse;
}

/** "-2h", "-30m", "NOW", "+1.5h" */
function relLabel(m) {
  if (m === 0) return 'NOW';
  const a = Math.abs(m);
  return `${m < 0 ? '-' : '+'}${a < 60 ? `${a}m` : `${String(+(a / 60).toFixed(1)).replace(/\.0$/, '')}h`}`;
}

/** One or two plain sentences: where DO is now, how it moved, what the forecast says. */
function liveSummary(d, series, doValue, rule) {
  if (doValue === null || doValue === undefined) return 'No valid dissolved oxygen reading in the latest cycle.';
  const w = rule.watch_boundary_do_mg_l ?? 5; const c = rule.critical_do_mg_l ?? 3;
  const where = doValue <= c ? `<strong>at or below the critical ${fmtNum(c, 1)} mg/L level</strong>` : doValue < w ? `<strong>below the ${fmtNum(w, 1)} mg/L normal boundary</strong>` : `in the normal range (at or above ${fmtNum(w, 1)} mg/L)`;
  let txt = `DO is <strong>${fmtNum(doValue)} mg/L</strong> now, ${where}.`;
  const first = series.find((r) => r.do_mg_l_status === 'VALID');
  if (first && series.length > 3) {
    const diff = doValue - first.do_mg_l;
    txt += Math.abs(diff) < 0.1 ? ' It has been steady over the last 2 hours.' : ` It ${diff < 0 ? 'fell' : 'rose'} ${fmtNum(Math.abs(diff))} mg/L over the last 2 hours.`;
  }
  const fc = d.forecasts.filter((f) => f.forecast_status === 'VALID');
  if (fc.length) {
    const lo = fc.reduce((a, b) => (b.predicted_do_mg_l < a.predicted_do_mg_l ? b : a));
    txt += ` The lowest forecast is ${fmtNum(lo.predicted_do_mg_l)} mg/L in ${lo.horizon_minutes} minutes`;
    txt += lo.predicted_do_mg_l <= c ? `, <strong>which reaches the critical level</strong>.` : lo.predicted_do_mg_l < w ? ', below the normal boundary but above critical.' : ', still in the normal range.';
  } else txt += ' No valid forecast is available for this cycle.';
  return txt;
}

export default async function live(root, ctx) {
  let chart = null;
  let timer = null;
  let cmdPoll = null;
  let firstRender = true;

  async function load() {
    const d = (await ctx.refreshLive()) || ctx.live();
    if (!d) throw new Error('Live data could not be loaded.');
    const [series, acts, rmse] = await Promise.all([
      d.observation ? get(`/api/history/observations${qs({ from: new Date(new Date(d.observation.timestamp_utc) - 24 * 3600e3).toISOString(), to: new Date(new Date(d.observation.timestamp_utc).getTime() + 1000).toISOString(), order: 'asc', page_size: 160 })}`).catch(() => ({ data: [] })) : { data: [] },
      get(`/api/activities${qs({ range: '7d', page_size: 4 })}`).catch(() => ({ data: [] })),
      forecastAccuracy().catch(() => ({})),
    ]);
    return { d, series24: series.data, acts: acts.data, rmse };
  }

  async function render() {
    let data;
    try { data = await load(); } catch (err) {
      if (!['SESSION_EXPIRED', 'SESSION_MISSING'].includes(err.code)) root.innerHTML = errorBox(err);
      return;
    }
    const { d, series24, acts, rmse } = data;
    // the plain-language summary keeps describing the last 2 hours
    const series = d.observation ? series24.filter((r) => new Date(r.timestamp_utc) >= new Date(d.observation.timestamp_utc) - 2 * 3600e3) : [];
    const rule = d.rule_reference;
    const o = d.observation;
    const doR = o?.readings?.do_mg_l;
    const risk = d.risk?.current_risk_state || 'DATA_UNAVAILABLE';
    const rk = riskKey(risk);
    const g = guidanceFor(risk);
    const doValue = doR?.usable ? doR.value : null;
    const doClass = doBand(doValue, rule) === 'critical' ? 'critical-text' : doBand(doValue, rule) === 'watch' ? 'warning-text' : '';
    const outlook = d.critical_outlook?.crossing_expected
      ? (d.critical_outlook.first_horizon_minutes ? `+${d.critical_outlook.first_horizon_minutes} min` : fmtTime(d.critical_outlook.expected_threshold_crossing_utc))
      : (doValue !== null && rule.critical_do_mg_l !== null && doValue <= rule.critical_do_mg_l ? 'Current condition' : 'Not projected within 120 min');
    const trend = d.trend;
    const trendCls = trend?.slope_mg_l_per_hr <= -0.3 ? 'critical-text' : trend?.slope_mg_l_per_hr < -0.05 ? 'warning-text' : '';

    root.innerHTML = html`<div class="live-status-page live-status-redesign">
      ${!o ? raw('<div class="aq-state"><strong>No observations yet</strong><p>When the AquaCast edge device syncs its first 10-minute cycle, the current conditions will appear here.</p></div>') : ''}
      <section class="live-overview-grid">
        <article class="live-primary-status-card">
          <div class="live-primary-header">
            <div class="live-primary-heading"><div class="live-primary-icon">${ic('droplets', 20)}</div>
              <div><span>Current Observation &amp; Risk</span><h3>Dissolved Oxygen</h3></div></div>
            <span class="live-risk-state-badge live-risk-${rk === 'unknown' ? 'normal' : rk}">${riskLabel(risk)}</span>
          </div>
          <div class="live-do-display"><strong class="live-do-value ${doClass}">${doValue === null ? '--' : fmtNum(doValue)}</strong><span class="live-do-unit">mg/L</span></div>
          <p class="live-do-caption">${doR && !doR.usable && o ? `DO reading not usable this cycle (${doR.quality_status.replace(/_/g, ' ')}).` : 'Current observed dissolved oxygen with the AquaCast risk classification for this monitoring cycle.'}</p>
          <div class="live-threshold-row">
            <span class="live-threshold-pill">Normal / Watch boundary: <strong>${fmtNum(rule.watch_boundary_do_mg_l, 1)} mg/L</strong></span>
            <span class="live-threshold-pill">Critical threshold: <strong>≤ ${fmtNum(rule.critical_do_mg_l, 1)} mg/L</strong></span>
          </div>
          ${d.risk && !d.risk.available && o ? raw(html`<p class="live-do-caption">${d.risk.message}</p>`) : ''}
        </article>
        <article class="live-context-card">
          <div class="live-context-header"><div class="live-context-title">${ic('triangle-alert', 19)}<div><h3>Condition Overview</h3><p>Current trend, critical outlook, alerts, and data status at a glance.</p></div></div></div>
          <div class="live-context-grid">
            <div class="live-context-metric"><div class="live-context-metric-top">${ic(trend?.slope_mg_l_per_hr < 0 ? 'trending-down' : 'trending-up', 15)}<span>DO Trend</span></div>
              <strong class="${trendCls}">${trend?.label || 'Insufficient data'}</strong><small>${trend?.slope_mg_l_per_hr === null || trend?.slope_mg_l_per_hr === undefined ? 'Needs 3 valid readings in 1 h' : `${fmtNum(trend.slope_mg_l_per_hr)} mg/L/hr`}</small></div>
            <div class="live-context-metric"><div class="live-context-metric-top">${ic('clock', 15)}<span>Critical Outlook</span></div>
              <strong>${outlook}</strong><small>Based on 30–120 min forecasts</small></div>
            <button type="button" class="live-context-metric live-context-link" data-go="alerts"><div class="live-context-metric-top">${ic('bell', 15)}<span>Active Alerts</span></div>
              <strong>${d.active_alerts}</strong><small>Review active alerts</small></button>
            <div class="live-context-metric"><div class="live-context-metric-top">${ic('clock', 15)}<span>Latest Observation</span></div>
              <strong>${o ? ago(o.timestamp_utc).toUpperCase() : '--'}</strong><small>${o ? `${fmtDateTime(o.timestamp_utc)} • ${o.record_status}` : 'Waiting for first cycle'}</small></div>
          </div>
        </article>
      </section>

      <section class="live-insight-grid">
        <section class="dashboard-panel do-trend-panel">
          <div class="do-trend-header">
            <div class="do-trend-heading"><div class="do-trend-heading-icon">${ic('trending-down', 18)}</div>
              <div><h3>DO Trend &amp; Forecast</h3><p>Recent dissolved oxygen measurements and the predicted values for the next 2 hours (<span id="live-range-label">${liveRange}h</span> window).</p></div></div>
            <div class="do-trend-live-badge"><span class="do-trend-live-dot"></span>${d.freshness?.state === 'LIVE' ? 'LIVE' : (d.freshness?.state || 'NO DATA').replace('_', ' ')}</div>
          </div>
          <p class="aq-chart-summary">${raw(liveSummary(d, series, doValue, rule))}</p>
          ${d.critical_outlook?.crossing_expected ? raw(html`<div class="do-trend-outlook">${ic('triangle-alert', 15)}<span><strong>Forecast outlook:</strong> The forecast reaches the configured critical reference by approximately ${outlook}.</span></div>`) : ''}
          <div class="do-trend-toolbar">
            <div class="aq-zoom-presets" role="group" aria-label="How far back to show">${LIVE_RANGES.map((h) => raw(`<button type="button" data-live-range="${h}" class="${h === liveRange ? 'active' : ''}" aria-pressed="${h === liveRange}">${h}h</button>`))}</div>
            <div class="do-trend-keys">
              ${rule.critical_do_mg_l !== null ? raw(html`<span><i class="dotted" style="--c:#e11d48"></i>Critical (≤ ${fmtNum(rule.critical_do_mg_l, 1)} mg/L)</span><span><i class="dotted" style="--c:#d97706"></i>Watch (${fmtNum(rule.critical_do_mg_l, 1)}–${fmtNum(rule.watch_boundary_do_mg_l, 1)} mg/L)</span>`) : ''}
              ${Object.keys(rmse || {}).length ? raw('<span><i class="range"></i>Likely forecast range</span>') : ''}
            </div>
          </div>
          <div class="do-trend-chart" id="live-chart"></div>
          <div class="do-trend-value-grid">
            ${[{ label: 'Current', icon: 'activity', v: doValue }, ...d.forecasts.map((f) => ({ label: `+${f.horizon_minutes} min`, icon: 'clock-3', v: f.forecast_status === 'VALID' ? f.predicted_do_mg_l : null, status: f.forecast_status }))]
              .map((c) => { const b = doBand(c.v, rule); return raw(html`<div class="do-trend-value-card ${b === 'critical' ? 'critical' : b === 'watch' ? 'attention' : 'normal'}">
                <div class="do-trend-value-label">${ic(c.icon, 13)}${c.label}</div><strong>${c.v === null ? '--' : fmtNum(c.v)}</strong><span>${c.v === null && c.status ? c.status.replace(/_/g, ' ') : 'mg/L'}</span></div>`); })}
          </div>
          <div class="do-trend-model">
            <div><span>Model</span><strong>${(() => { const m = d.forecasts.find((f) => f.model)?.model; return m ? `${m.model_name.replace(/ DO \+\d+ min$/, '')} ${m.version}` : 'XGBoost'; })()}</strong></div>
            <div><span>Typical error at +1h</span><strong>${rmse?.[60] ? `± ${fmtNum(rmse[60])} mg/L` : 'Not enough data yet'}</strong></div>
            <div><span>Forecast made from</span><strong>${o ? `${fmtTime(o.timestamp_utc)} reading` : '--'}</strong></div>
            <button type="button" class="do-trend-more" data-go="forecast">View full forecast ${ic('arrow-right', 15)}</button>
          </div>
          <div class="do-trend-footnote">${ic('activity', 14)}<span>Each dot is a 10-minute reading. The shaded band around the forecast is its typical error over the last 24 hours (± RMSE per horizon), so the real value usually lands inside it.</span></div>
        </section>

        <div class="live-right-stack">
          <article class="dashboard-panel operator-support-panel">
            <div class="operator-support-header"><div class="operator-support-title"><div class="operator-support-icon">${ic('shield-check', 18)}</div>
              <div><h3>Operator Guidance</h3><p>Forecast-informed decision support</p><span class="human-loop-badge">HUMAN-IN-THE-LOOP</span></div></div></div>
            <div class="operator-support-status"><span>Current Guidance</span><strong>${g.title}</strong><p>${g.description}</p></div>
            <button type="button" class="operator-support-action" data-go="forecast">View Full Forecast${ic('arrow-right', 16)}</button>
          </article>
          <article class="dashboard-panel manual-aeration-panel manual-aeration-compact" id="aeration-panel"></article>
        </div>
      </section>

      <section class="live-lower-grid">
        <article class="dashboard-panel environment-overview-panel">
          <div class="environment-overview-header"><div class="environment-overview-title">${ic('cloud-sun', 19)}<h3>Environmental Context</h3></div>
            <p>Supporting pond and atmospheric measurements from the current observation cycle.</p></div>
          <div class="environment-context-grid">
            ${ENV.map(([k, ico, label, f]) => { const r = o?.readings?.[k]; return raw(html`<div class="environment-context-item">
              <div class="environment-context-icon">${ic(ico, 17)}</div><span>${label}</span>
              <strong>${r?.usable ? f(r.value) : (r ? r.quality_status.replace(/_/g, ' ') : '--')}</strong></div>`); })}
          </div>
          <div class="environment-context-note">Environmental measurements provide context for interpreting dissolved oxygen behavior. They should not be treated as confirmation that a particular variable caused a DO change.</div>
        </article>
        <article class="dashboard-panel activity-audit-panel">
          <div class="activity-audit-header"><div class="activity-audit-title"><div class="activity-header-icon">${ic('clipboard-list', 19)}</div>
            <div><h3>Pond Activity &amp; Event Log</h3><p>Recent pond operations, management activities, and system events</p></div></div>
            <button type="button" class="log-activity-button" data-act="log">${ic('plus', 15)}Log Activity</button></div>
          <div class="activity-feed">
            ${acts.length ? acts.map((a) => raw(html`<div class="activity-item"><div class="activity-item-left">
              <div class="activity-timeline"><span class="activity-dot"></span><span class="activity-line"></span></div>
              <div class="activity-icon-container">${ic(eventIcon(a), 17)}</div>
              <div class="activity-information"><div class="activity-title-row"><strong>${eventLabel(a.event_type)}</strong><span class="activity-station">${ctx.station()}</span></div>
                <p>${a.details || '—'}</p><span class="activity-user">${a.actor_name || a.source}</span></div></div>
              <time>${fmtTime(a.occurred_at, true)}</time></div>`)) : raw('<div class="aq-state small"><strong>No recent activity</strong><p>Logged pond activities and system events from the last 7 days appear here.</p></div>')}
          </div>
          <div class="activity-footer"><span>Showing latest ${acts.length} records</span><button type="button" data-go="activities">View full activity log →</button></div>
        </article>
      </section>

      <section class="dashboard-panel sensors2-edge-panel live-health-panel">
        <div class="sensors2-section-header"><div><span class="sensors2-eyebrow">EDGE DEVICE</span><h3>System Health</h3>
          <p>${d.system_health ? `Latest Raspberry Pi report ${ago(d.system_health.timestamp_utc).toLowerCase()}${d.system_health.matches_latest_observation ? ' (this cycle)' : ' (older cycle)'}.` : 'No health report has been synced yet.'}</p></div>
          <span class="sensors2-status-chip ${d.system_health ? (d.system_health.rs485_bus_status === 'OK' && d.system_health.i2c_bus_status === 'OK' ? 'available' : 'pending') : 'pending'}">${d.system_health ? (d.system_health.rs485_bus_status === 'OK' && d.system_health.i2c_bus_status === 'OK' ? 'BUSES OK' : 'BUS DEGRADED') : 'UNAVAILABLE'}</span></div>
        ${raw(healthCards(d.system_health))}
      </section>
    </div>`;

    renderAeration(root.querySelector('#aeration-panel'), d.aerator);
    root.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => ctx.navigate(b.dataset.go)));
    root.querySelector('[data-act=log]').addEventListener('click', () => openActivityModal({ variant: 'compact', onSaved: render }));

    const chartHost = root.querySelector('#live-chart');
    function drawTrend() {
      chart?.destroy(); chart = null;
      if (!o) { chartHost.innerHTML = '<div class="aq-state small"><strong>No observations yet</strong></div>'; return; }
      const originT = new Date(o.timestamp_utc);
      const from = originT.getTime() - liveRange * 3600e3;
      const to = originT.getTime() + 120 * 60000;
      const obsPts = series24.filter((r) => new Date(r.timestamp_utc) >= from)
        .map((r) => ({ x: new Date(r.timestamp_utc), y: r.do_mg_l_status === 'VALID' ? r.do_mg_l : null }));
      const fcPts = d.forecasts.map((f) => {
        const v = f.forecast_status === 'VALID' ? f.predicted_do_mg_l : null;
        const col = BAND_COLOR[doBand(v, rule)] || BAND_COLOR.unknown;
        const e = rmse?.[f.horizon_minutes];
        return { x: new Date(originT.getTime() + f.horizon_minutes * 60000), y: v, fill: col, r: 5, label: v === null ? '' : fmtNum(v), labelColor: col,
          note: v !== null && e ? `Likely range ${fmtNum(Math.max(0, v - e))}–${fmtNum(v + e)} mg/L (± typical error ${fmtNum(e)})` : null, h: f.horizon_minutes, e };
      });
      // when the 2-hour forecast is only a sliver of the chart (12h / 24h on a phone), label just the last value
      const fcWidth = (chartHost.clientWidth || 600) * (120 / (liveRange * 60 + 120));
      if (fcWidth < 170) fcPts.forEach((q, i) => { if (i < fcPts.length - 1) q.label = ''; q.r = 4; });
      const band = fcPts.some((q) => q.e && valid(q)) ? [{ x: originT, lo: doValue, hi: doValue }, ...fcPts.filter((q) => q.e && valid(q)).map((q) => ({ x: q.x, lo: Math.max(0, q.y - q.e), hi: q.y + q.e }))] : null;
      // relative time ticks (-4h … NOW … +2h), spaced to fit the width
      const width = chartHost.clientWidth || 600;
      const totalMin = liveRange * 60 + 120;
      const step = [15, 30, 60, 120, 240, 360].find((m) => totalMin / m + 1 <= Math.max(4, Math.floor(width / 62))) || 360;
      const ticks = [];
      for (let m = -Math.floor((liveRange * 60) / step) * step; m <= 120; m += step) ticks.push(new Date(originT.getTime() + m * 60000));
      const riskCol = RISK_COLOR[d.risk?.current_risk_state] || '#64748b';
      chart = mountChart(chartHost, {
        ariaLabel: `Dissolved oxygen: last ${liveRange} hours measured and the next 2 hours predicted`,
        memoryKey: 'live-trend',
        xDomain: [new Date(from), new Date(to)],
        xTicks: ticks,
        xFormat: (dt) => relLabel(Math.round((dt - originT) / 60000)),
        xTickClass: (dt) => (Math.round((dt - originT) / 60000) === 0 ? 'tick-now' : ''),
        legend: false,
        panels: [{ title: 'Dissolved oxygen', unit: 'mg/L',
          domain: doDomain([...obsPts.map((q) => q.y), doValue, ...fcPts.map((q) => q.y), ...(band || []).flatMap((q) => [q.lo, q.hi])], rule),
          thresholds: rule.critical_do_mg_l !== null ? [
            { y: rule.critical_do_mg_l, label: fmtNum(rule.critical_do_mg_l, 1), color: '#e11d48', dotted: true },
            { y: rule.watch_boundary_do_mg_l, label: fmtNum(rule.watch_boundary_do_mg_l, 1), color: '#d97706', dotted: true }] : [],
          marker: { x: originT, label: `NOW · ${riskLabel(d.risk?.current_risk_state || 'DATA_UNAVAILABLE').toUpperCase()}`, color: riskCol },
          series: [
            { name: 'Actual DO', color: DO_COLOR, width: 2.6, area: true, markers: 'ring', dots: false, points: obsPts },
            { name: 'Predicted DO (+30m, +1h, +1.5h, +2h)', color: FORECAST_COLOR, dotted: true, width: 2.6, dots: true,
              band, bandTooltip: false,
              points: [{ x: originT, y: doValue, fill: DO_COLOR, r: 4.5 }, ...fcPts] },
          ] }],
        tooltipX: (dt) => { const m = Math.round((dt - originT) / 60000); return `${fmtTime(dt.toISOString())} · ${m === 0 ? 'now' : m > 0 ? `forecast ${relLabel(m)}` : `${relLabel(m).slice(1)} ago`}`; },
      });
    }
    drawTrend();
    root.querySelectorAll('[data-live-range]').forEach((b) => b.addEventListener('click', () => {
      liveRange = Number(b.dataset.liveRange);
      root.querySelectorAll('[data-live-range]').forEach((x) => { const on = x === b; x.classList.toggle('active', on); x.setAttribute('aria-pressed', String(on)); });
      root.querySelector('#live-range-label').textContent = `${liveRange}h`;
      drawTrend();
    }));

    // a new reading since the last time this screen was drawn: let the DO value glow once
    const obsKey = o?.timestamp_utc || null;
    if (obsKey && lastSeenObs && obsKey !== lastSeenObs) root.querySelectorAll('.live-do-value').forEach((el) => el.classList.add('aq-fresh'));
    if (obsKey) lastSeenObs = obsKey;

    if (firstRender && ctx.opts?.focus === 'aeration') {
      root.querySelector('#aeration-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    firstRender = false;
  }

  function healthCards(h) {
    if (!h) return '<div class="aq-state small"><strong>No system health report</strong><p>The Raspberry Pi sends a health record with each cycle once it is connected.</p></div>';
    const up = h.pi_uptime_s ? `${Math.floor(h.pi_uptime_s / 86400)}d ${Math.floor((h.pi_uptime_s % 86400) / 3600)}h uptime` : 'Uptime unknown';
    const cards = [
      ['cpu', 'Edge Node', `${fmtNum(h.pi_cpu_temp_c, 1)} °C CPU`, `RAM ${fmtNum(h.ram_used_pct, 0)}% • ${up}`, 'Raspberry Pi 4'],
      ['radio', 'Network', h.wifi_connected ? `Wi-Fi ${fmtNum(h.wifi_signal_rssi_dbm, 0)} dBm` : 'Wi-Fi disconnected', h.internet_reachable ? 'Internet reachable' : 'Internet unreachable', h.internet_reachable ? 'Online' : 'Offline'],
      ['database', 'Local Data Store', h.local_database_operational ? 'SQLite operational' : 'SQLite fault', `${fmtNum(h.storage_free_mb / 1024, 1)} GB free`, h.battery_voltage_v ? `${fmtNum(h.battery_voltage_v, 2)} V battery` : 'Battery n/a'],
      ['refresh-cw', 'Cloud Sync', h.last_cloud_sync_at_utc ? ago(h.last_cloud_sync_at_utc) : 'Never', h.last_cloud_sync_at_utc ? fmtDateTime(h.last_cloud_sync_at_utc) : 'Waiting for first sync', `RS485 ${h.rs485_bus_status} • I²C ${h.i2c_bus_status}`],
    ];
    return html`<div class="sensors2-edge-grid">${cards.map(([ico, label, strong, p, small]) => raw(html`<article class="sensors2-edge-card">
      <div class="sensors2-edge-icon">${ic(ico, 18)}</div><span>${label}</span><strong>${strong}</strong><p>${p}</p><small>${small}</small></article>`))}</div>`;
  }

  function renderAeration(el, a) {
    if (cmdPoll) { clearInterval(cmdPoll); cmdPoll = null; }
    if (!a || !a.initialized) {
      el.innerHTML = html`<div class="manual-aeration-compact-header"><div class="manual-aeration-title"><div class="manual-aeration-icon">${ic('fan', 18)}</div>
        <div><h3>Manual Aeration</h3><p>Operator-issued request</p></div></div><span class="manual-aeration-state unknown"><span></span>NOT READY</span></div>
        <p class="manual-aeration-compact-note">${a?.message || 'Aerator status unavailable.'}</p>`;
      return;
    }
    const p = a.pending_command && a.pending_command.effective_status === 'PENDING' ? a.pending_command : null;
    const out = a.controller.output_state;
    const badge = p ? ['pending', `REQ ${p.requested_state}`] : out === 'ON' ? ['on', 'ACK ON'] : out === 'OFF' ? ['off', 'ACK OFF'] : ['unknown', 'UNKNOWN'];
    const target = out === 'ON' ? 'OFF' : 'ON';
    const lastProblem = a.recent_commands.find((c) => c.command_source === 'MANUAL_DASHBOARD' && ['REJECTED', 'FAILED', 'EXPIRED', 'EXPIRED_NOT_ACKNOWLEDGED', 'CANCELLED'].includes(c.effective_status));
    const latestManual = a.recent_commands.find((c) => c.command_source === 'MANUAL_DASHBOARD');
    el.innerHTML = html`<div class="manual-aeration-compact-header">
        <div class="manual-aeration-title"><div class="manual-aeration-icon">${ic('fan', 18)}</div><div><h3>Manual Aeration</h3><p>Dashboard request → Raspberry Pi → controller</p></div></div>
        <span class="manual-aeration-state ${badge[0]}"><span></span>${badge[1]}</span></div>
      <div class="manual-aeration-compact-grid">
        <div><span>Requested State</span><strong>${p ? `${p.requested_state} (waiting)` : latestManual ? `${latestManual.requested_state} • ${latestManual.effective_status.replace(/_/g, ' ')}` : 'None yet'}</strong></div>
        <div><span>Controller Mode</span><strong>${a.mode.applied_mode}${a.mode.acknowledged ? '' : ` → ${a.mode.requested_mode}`}</strong></div>
        <div><span>Controller Ack</span><strong>${out}${a.controller.stale ? ' (stale)' : ''}</strong></div>
        <div><span>Physical Feedback</span><strong>Not measured</strong></div>
      </div>
      <button type="button" class="manual-aeration-button ${target === 'ON' ? 'start' : 'stop'}" data-cmd="${target}" ${a.can_request_manual_command ? '' : 'disabled'}>${ic('power', 16)}Request Aerator ${target}</button>
      ${p ? raw(html`<div class="aq-command-pending">${ic('loader-circle', 15, 'aq-spin')}<span>${p.requested_state} request sent ${fmtTime(p.requested_at_utc, true)}. Waiting for the Raspberry Pi to validate and apply it (expires ${fmtTime(p.expires_at_utc, true)}).</span></div>`) : ''}
      ${!p && lastProblem && lastProblem === latestManual ? raw(html`<div class="aq-command-pending problem">${ic('triangle-alert', 15)}<span>Last request (${lastProblem.requested_state}) ${lastProblem.effective_status.replace(/_/g, ' ').toLowerCase()}: ${lastProblem.failure_reason || lastProblem.status_text}</span></div>`) : ''}
      <p class="manual-aeration-compact-note">${a.manual_command_blocked_reason || `Controller last reported ${ago(a.controller.output_reported_at_utc).toLowerCase()}. A request is not proof that the aerator motor is running.`}</p>`;
    el.querySelector('[data-cmd]').addEventListener('click', (e) => busy(e.currentTarget, async () => {
      const state = e.currentTarget.dataset.cmd;
      try {
        const r = await post('/api/aerator/commands', { requested_state: state }, { headers: { 'Idempotency-Key': crypto.randomUUID() } });
        toast(r.meta.message);
        a.pending_command = r.data;
        a.can_request_manual_command = false;
        a.recent_commands.unshift(r.data);
        renderAeration(el, a);
      } catch (err) { toast(err.message, 'error'); }
    }));
    if (p) {
      cmdPoll = setInterval(async () => {
        try {
          const { data } = await get(`/api/aerator/commands/${p.command_id}`);
          if (data.effective_status !== 'PENDING') {
            clearInterval(cmdPoll); cmdPoll = null;
            toast(`Aerator ${data.requested_state} request ${data.effective_status.replace(/_/g, ' ').toLowerCase()}. ${data.status_text}`, data.effective_status === 'APPLIED' ? 'success' : 'error');
            const fresh = await get('/api/aerator');
            if (el.isConnected) renderAeration(el, fresh.data);
          }
        } catch { /* keep polling */ }
      }, 3000);
    }
  }

  await render();
  timer = setInterval(render, 60_000);
  return () => { clearInterval(timer); if (cmdPoll) clearInterval(cmdPoll); chart?.destroy(); };
}

export { esc };
