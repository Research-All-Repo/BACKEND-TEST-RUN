// Live Status: latest observation + official risk, condition overview, DO trend & forecast chart,
// operator guidance, manual aeration REQUEST (never direct control), environment, edge health, recent activity.
import { get, post, qs } from '../api.js';
import { html, raw, ic, icon, esc, fmtNum, fmtTime, fmtDateTime, ago, riskKey, riskLabel, doBand, guidanceFor, toast, errorBox, busy } from '../ui.js';
import { mountChart, doDomain, DO_COLOR, FORECAST_COLOR } from '../chart.js';
import { openActivityModal, eventIcon, eventLabel, describeEvent } from './shared.js';

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

// phone: secondary Live sections start folded so the status, chart and aerator come first
const collapseState = new Map();
function setupCollapsibles(scope) {
  const phone = window.matchMedia('(max-width: 760px)').matches;
  scope.querySelectorAll('.aq-collapsible').forEach((el) => {
    const key = el.dataset.collapse;
    const head = el.firstElementChild;
    if (!head) return;
    const collapsed = collapseState.has(key) ? collapseState.get(key) : phone;
    el.classList.toggle('collapsed', collapsed);
    head.classList.add('aq-collapse-head');
    head.setAttribute('role', 'button'); head.setAttribute('tabindex', '0'); head.setAttribute('aria-expanded', String(!collapsed));
    const toggle = (e) => {
      if (e.target.closest('button, a') && e.target.closest('button, a') !== head) return; // buttons inside the header keep working
      const now = !el.classList.contains('collapsed');
      el.classList.toggle('collapsed', now); collapseState.set(key, now); head.setAttribute('aria-expanded', String(!now));
    };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); } });
  });
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

    const fc = d.forecasts.filter((f) => f.forecast_status === 'VALID');
    const lowest = fc.length ? fc.reduce((m, f) => (f.predicted_do_mg_l < m.predicted_do_mg_l ? f : m)) : null;
    const calib = d.calibration?.enabled;
    function heroHtml() {
      const RISK_ICON = { normal: 'circle-check', watch: 'eye', warning: 'triangle-alert', critical: 'octagon-alert', unknown: 'circle-help' };
      const FRESH = { LIVE: 'Live', SYNC_DELAYED: 'Sync delayed', OFFLINE: 'Offline', NO_DATA: 'No data' };
      const slope = trend?.slope_mg_l_per_hr;
      const urgent = risk === 'WARNING' || risk === 'CRITICAL';
      const fresh = d.freshness?.state || 'NO_DATA';
      return html`<section class="aq-hero aq-hero-${rk}" aria-label="Pond status">
        <div class="aq-hero-main">
          <div class="aq-hero-top">
            <span class="aq-hero-risk">${ic(RISK_ICON[rk] || 'circle-help', 16)}${riskLabel(risk)}</span>
            <span class="aq-hero-fresh fresh-${fresh.toLowerCase()}"><span class="aq-hero-dot"></span>${FRESH[fresh] || fresh}${o ? ` · updated ${ago(o.timestamp_utc).toLowerCase()}` : ''}</span>
            ${calib ? raw(`<span class="aq-hero-calib">${icon('wrench', 13)}Uncalibrated · alerts paused</span>`) : ''}
          </div>
          <div class="aq-hero-reading">
            <div class="aq-hero-value"><span class="aq-hero-label">Dissolved oxygen now</span>
              <div class="aq-hero-number"><strong class="live-do-value ${doClass}">${doValue === null ? '--' : fmtNum(doValue)}</strong><span>mg/L</span></div></div>
            <div class="aq-hero-trend ${trendCls}">${ic(slope === null || slope === undefined ? 'minus' : slope < -0.05 ? 'arrow-down-right' : slope > 0.05 ? 'arrow-up-right' : 'move-right', 22)}
              <div><b>${trend?.label || 'Not enough data'}</b><small>${slope === null || slope === undefined ? 'needs 3 readings in 1 h' : `${slope > 0 ? '+' : ''}${fmtNum(slope)} mg/L per hour`}</small></div></div>
          </div>
          ${doR && !doR.usable && o ? raw(html`<p class="aq-hero-note">DO reading not usable this cycle (${doR.quality_status.replace(/_/g, ' ')}).</p>`) : ''}
          ${d.risk && !d.risk.available && o ? raw(html`<p class="aq-hero-note">${d.risk.message}</p>`) : ''}
          ${o ? raw(heroSpark()) : ''}
          <div class="aq-hero-guidance"><strong>${g.title}</strong><p>${g.description}</p></div>
          <div class="aq-hero-actions">
            ${urgent ? raw(`<button type="button" class="aq-hero-btn danger" data-hero="aeration">${icon('fan', 17)}Go to aeration control</button><button type="button" class="aq-hero-btn" data-go="forecast">View forecast${icon('arrow-right', 16)}</button>`)
              : raw(`<button type="button" class="aq-hero-btn primary" data-go="forecast">View 2-hour forecast${icon('arrow-right', 16)}</button>`)}
            ${d.active_alerts ? raw(`<button type="button" class="aq-hero-btn" data-go="alerts">${icon('bell', 16)}${d.active_alerts} active alert${d.active_alerts > 1 ? 's' : ''}</button>`) : ''}
          </div>
        </div>
        <div class="aq-hero-side">
          <div class="aq-hero-metric"><span>${ic('arrow-down-to-line', 14)}Lowest in next 2 h</span><strong class="${lowest ? (doBand(lowest.predicted_do_mg_l, rule) === 'critical' ? 'critical-text' : doBand(lowest.predicted_do_mg_l, rule) === 'watch' ? 'warning-text' : '') : ''}">${lowest ? `${fmtNum(lowest.predicted_do_mg_l)} mg/L` : '--'}</strong><small>${lowest ? `at +${lowest.horizon_minutes} min` : 'No valid forecast'}</small></div>
          <div class="aq-hero-metric"><span>${ic('clock', 14)}Critical outlook</span><strong>${outlook}</strong><small>Below ${fmtNum(rule.critical_do_mg_l, 1)} mg/L is critical</small></div>
          <button type="button" class="aq-hero-metric aq-hero-link" data-go="alerts"><span>${ic('bell', 14)}Active alerts</span><strong>${d.active_alerts}</strong><small>${d.active_alerts ? 'Tap to review' : 'Nothing to review'}</small></button>
          <div class="aq-hero-metric"><span>${ic('radio', 14)}Latest reading</span><strong>${o ? fmtTime(o.timestamp_utc) : '--'}</strong><small>${o ? `${o.record_status.toLowerCase()} · every 10 min` : 'Waiting for first cycle'}</small></div>
        </div>
      </section>`;
    }
    /** Small two-hour picture: measured (solid) up to now, forecast (dotted) after, boundary lines. */
    function heroSpark() {
      const t0 = new Date(o.timestamp_utc).getTime();
      const meas = series24.filter((r) => new Date(r.timestamp_utc) >= t0 - 2 * 3600e3 && r.do_mg_l_status === 'VALID').map((r) => [new Date(r.timestamp_utc).getTime(), r.do_mg_l]);
      const fut = [[t0, doValue], ...fc.map((f) => [t0 + f.horizon_minutes * 60000, f.predicted_do_mg_l])].filter((q) => Number.isFinite(q[1]));
      const ys = [...meas, ...fut].map((q) => q[1]);
      if (ys.length < 2) return '';
      const dom = doDomain(ys, rule);
      const W = 320; const H = 64; const P = 4;
      const X = (t) => P + ((t - (t0 - 2 * 3600e3)) / (4 * 3600e3)) * (W - 2 * P);
      const Y = (v) => P + (1 - (v - dom[0]) / (dom[1] - dom[0])) * (H - 2 * P);
      const path = (pts) => pts.map((q, i) => `${i ? 'L' : 'M'}${X(q[0]).toFixed(1)},${Y(q[1]).toFixed(1)}`).join('');
      const line = (v, cls) => (v > dom[0] && v < dom[1] ? `<line class="${cls}" x1="${P}" x2="${W - P}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/>` : '');
      return `<div class="aq-hero-spark"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Dissolved oxygen over the last 2 hours and the next 2 hours">
        ${line(rule.watch_boundary_do_mg_l, 'b-watch')}${line(rule.critical_do_mg_l, 'b-crit')}
        <line class="b-now" x1="${X(t0).toFixed(1)}" x2="${X(t0).toFixed(1)}" y1="0" y2="${H}"/>
        ${meas.length > 1 ? `<path class="s-meas" d="${path(meas)}"/>` : ''}${fut.length > 1 ? `<path class="s-fc" d="${path(fut)}"/>` : ''}
        ${Number.isFinite(doValue) ? `<circle class="s-now" cx="${X(t0).toFixed(1)}" cy="${Y(doValue).toFixed(1)}" r="4"/>` : ''}
      </svg><div class="aq-hero-spark-axis"><span>2 h ago</span><span>Now</span><span>+2 h</span></div></div>`;
    }

    root.innerHTML = html`<div class="live-status-page live-status-redesign">
      ${!o ? raw('<div class="aq-state"><strong>No observations yet</strong><p>When the AquaCast edge device syncs its first 10-minute cycle, the current conditions will appear here.</p></div>') : ''}
      ${raw(heroHtml())}

      <section class="live-insight-grid">
        <section class="dashboard-panel do-trend-panel">
          <div class="do-trend-header">
            <div class="do-trend-heading"><div class="do-trend-heading-icon">${ic('trending-down', 18)}</div>
              <div><h3>DO Trend &amp; Forecast</h3><p>Recent dissolved oxygen measurements and the predicted values for the next 2 hours (<span id="live-range-label">${liveRange}h</span> window).</p></div></div>
            <div class="do-trend-live-badge"><span class="do-trend-live-dot"></span>${d.freshness?.state === 'LIVE' ? 'LIVE' : (d.freshness?.state || 'NO DATA').replace('_', ' ')}</div>
          </div>
          <p class="aq-chart-summary">${raw(liveSummary(d, series, doValue, rule))}</p>
          ${d.critical_outlook?.crossing_expected ? raw(html`<div class="do-trend-outlook">${ic('triangle-alert', 15)}<span><strong>Forecast outlook:</strong> The forecast reaches the configured critical reference by approximately ${outlook}.</span></div>`) : ''}
          <div class="aq-zoom do-trend-range" id="live-range">
            <div class="aq-zoom-row"><div class="aq-zoom-presets" role="group" aria-label="How far back to show">${LIVE_RANGES.map((h) => raw(`<button type="button" data-live-range="${h}" class="${h === liveRange ? 'active' : ''}" aria-pressed="${h === liveRange}">${h}h</button>`))}</div></div>
            <div class="aq-zoom-hint">Pick how far back to show. Tap or slide on the chart to read exact values.</div>
          </div>
          <div class="do-trend-chart" id="live-chart"></div>
          <div class="do-trend-model">
            <div><span>Model</span><strong>${(() => { const m = d.forecasts.find((f) => f.model)?.model; return m ? `${m.model_name.replace(/ DO \+\d+ min$/, '')} ${m.version}` : 'XGBoost'; })()}</strong></div>
            <div><span>Typical error at +1h</span><strong>${rmse?.[60] ? `± ${fmtNum(rmse[60])} mg/L` : 'Not enough data yet'}</strong></div>
            <div><span>Forecast made from</span><strong>${o ? `${fmtTime(o.timestamp_utc)} reading` : '--'}</strong></div>
            <button type="button" class="do-trend-more" data-go="forecast">View full forecast ${ic('arrow-right', 15)}</button>
          </div>
          <div class="do-trend-footnote">${ic('activity', 14)}<span>Each dot is a 10-minute reading. The shaded band around the forecast is its typical error over the last 24 hours (± RMSE per horizon), so the real value usually lands inside it.</span></div>
        </section>

        <div class="live-right-stack">
          <article class="dashboard-panel manual-aeration-panel manual-aeration-compact" id="aeration-panel"></article>
        </div>
      </section>

      <section class="live-lower-grid">
        <article class="dashboard-panel environment-overview-panel aq-collapsible" data-collapse="env">
          <div class="environment-overview-header"><div class="environment-overview-title">${ic('cloud-sun', 19)}<h3>Environmental Context</h3></div>
            <p>Supporting pond and atmospheric measurements from the current observation cycle.</p></div>
          <div class="environment-context-grid">
            ${ENV.map(([k, ico, label, f]) => { const r = o?.readings?.[k]; return raw(html`<div class="environment-context-item">
              <div class="environment-context-icon">${ic(ico, 17)}</div><span>${label}</span>
              <strong>${r?.usable ? f(r.value) : (r ? r.quality_status.replace(/_/g, ' ') : '--')}</strong></div>`); })}
          </div>
          <div class="environment-context-note">Environmental measurements provide context for interpreting dissolved oxygen behavior. They should not be treated as confirmation that a particular variable caused a DO change.</div>
        </article>
        <article class="dashboard-panel activity-audit-panel aq-collapsible" data-collapse="activity">
          <div class="activity-audit-header"><div class="activity-audit-title"><div class="activity-header-icon">${ic('clipboard-list', 19)}</div>
            <div><h3>Pond Activity &amp; Event Log</h3><p>Recent pond operations, management activities, and system events</p></div></div>
            <button type="button" class="log-activity-button" data-act="log">${ic('plus', 15)}Log Activity</button></div>
          <div class="activity-feed">
            ${acts.length ? acts.map((a) => raw(html`<div class="activity-item"><div class="activity-item-left">
              <div class="activity-timeline"><span class="activity-dot"></span><span class="activity-line"></span></div>
              <div class="activity-icon-container">${ic(eventIcon(a), 17)}</div>
              <div class="activity-information"><div class="activity-title-row"><strong>${eventLabel(a.event_type)}</strong><span class="activity-station">${ctx.station()}</span></div>
                <p>${describeEvent(a)}</p><span class="activity-user">${a.actor_name || a.source}</span></div></div>
              <time>${fmtTime(a.occurred_at, true)}</time></div>`)) : raw('<div class="aq-state small"><strong>No recent activity</strong><p>Logged pond activities and system events from the last 7 days appear here.</p></div>')}
          </div>
          <div class="activity-footer"><span>Showing latest ${acts.length} records</span><button type="button" data-go="activities">View full activity log →</button></div>
        </article>
      </section>

      <section class="dashboard-panel sensors2-edge-panel live-health-panel aq-collapsible" data-collapse="health">
        <div class="sensors2-section-header"><div><span class="sensors2-eyebrow">EDGE DEVICE</span><h3>System Health</h3>
          <p>${d.system_health ? `Latest Raspberry Pi report ${ago(d.system_health.timestamp_utc).toLowerCase()}${d.system_health.matches_latest_observation ? ' (this cycle)' : ' (older cycle)'}.` : 'No health report has been synced yet.'}</p></div>
          <span class="sensors2-status-chip ${d.system_health ? (d.system_health.rs485_bus_status === 'OK' && d.system_health.i2c_bus_status === 'OK' ? 'available' : 'pending') : 'pending'}">${d.system_health ? (d.system_health.rs485_bus_status === 'OK' && d.system_health.i2c_bus_status === 'OK' ? 'BUSES OK' : 'BUS DEGRADED') : 'UNAVAILABLE'}</span></div>
        ${raw(healthCards(d.system_health))}
      </section>
    </div>`;

    renderAeration(root.querySelector('#aeration-panel'), d.aerator);
    root.querySelector('[data-hero=aeration]')?.addEventListener('click', () => root.querySelector('#aeration-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    setupCollapsibles(root);
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
        legendExtra: rule.critical_do_mg_l !== null ? [
          { cls: 'line dotted', color: '#e11d48', label: `Critical (≤ ${fmtNum(rule.critical_do_mg_l, 1)} mg/L)` },
          { cls: 'line dotted', color: '#d97706', label: `Watch (${fmtNum(rule.critical_do_mg_l, 1)}–${fmtNum(rule.watch_boundary_do_mg_l, 1)} mg/L)` }] : [],
        panels: [{ title: 'Dissolved oxygen', unit: 'mg/L',
          domain: doDomain([...obsPts.map((q) => q.y), doValue, ...fcPts.map((q) => q.y), ...(band || []).flatMap((q) => [q.lo, q.hi])], rule),
          thresholds: rule.critical_do_mg_l !== null ? [
            { y: rule.critical_do_mg_l, label: fmtNum(rule.critical_do_mg_l, 1), color: '#e11d48', dotted: true },
            { y: rule.watch_boundary_do_mg_l, label: fmtNum(rule.watch_boundary_do_mg_l, 1), color: '#d97706', dotted: true }] : [],
          marker: { x: originT, label: `NOW · ${riskLabel(d.risk?.current_risk_state || 'DATA_UNAVAILABLE').toUpperCase()}`, color: riskCol },
          series: [
            { name: 'Actual DO', color: DO_COLOR, width: 2.6, area: true, markers: 'ring', dots: false, points: obsPts },
            { name: 'Predicted DO (+30m, +1h, +1.5h, +2h)', color: FORECAST_COLOR, dotted: true, width: 2.6, dots: true,
              band, bandTooltip: false, bandLabel: 'Likely forecast range (± typical error)',
              points: [{ x: originT, y: doValue, fill: DO_COLOR, r: 4.5 }, ...fcPts] },
          ] }],
        tooltipX: (dt) => { const m = Math.round((dt - originT) / 60000); return `${fmtTime(dt.toISOString())} · ${m === 0 ? 'now' : m > 0 ? `forecast ${relLabel(m)}` : `${relLabel(m).slice(1)} ago`}`; },
      });
    }
    const rangeBar = root.querySelector('#live-range');
    const drawTrendInOrder = () => { drawTrend(); chartHost.before(rangeBar); }; // order: Show chips, range buttons, chart
    drawTrendInOrder();
    root.querySelectorAll('[data-live-range]').forEach((b) => b.addEventListener('click', () => {
      liveRange = Number(b.dataset.liveRange);
      root.querySelectorAll('[data-live-range]').forEach((x) => { const on = x === b; x.classList.toggle('active', on); x.setAttribute('aria-pressed', String(on)); });
      root.querySelector('#live-range-label').textContent = `${liveRange}h`;
      drawTrendInOrder();
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
