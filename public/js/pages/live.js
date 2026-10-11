// Live Status: latest observation + official risk, condition overview, DO trend & forecast chart,
// operator guidance, manual aeration REQUEST (never direct control), environment, edge health, recent activity.
import { get, post, qs } from '../api.js';
import { html, raw, ic, esc, fmtNum, fmtTime, fmtDateTime, ago, riskKey, riskLabel, doBand, guidanceFor, toast, errorBox, busy } from '../ui.js';
import { mountChart } from '../chart.js';
import { openActivityModal, eventIcon, eventLabel } from './shared.js';

const ENV = [
  ['water_temp_c', 'thermometer', 'Water Temperature', (v) => `${fmtNum(v, 1)} °C`],
  ['ph_value', 'flask-conical', 'pH', (v) => fmtNum(v, 2)],
  ['light_lux', 'sun', 'Light Intensity', (v) => `${fmtNum(v, 0)} lux`],
  ['atmospheric_pressure_hpa', 'gauge', 'Atmospheric Pressure', (v) => `${fmtNum(v, 1)} hPa`],
  ['air_temp_c', 'wind', 'Ambient Temperature', (v) => `${fmtNum(v, 1)} °C`],
  ['relative_humidity_pct', 'droplets', 'Relative Humidity', (v) => `${fmtNum(v, 0)} %`],
];

export default async function live(root, ctx) {
  let chart = null;
  let timer = null;
  let cmdPoll = null;
  let firstRender = true;

  async function load() {
    const d = (await ctx.refreshLive()) || ctx.live();
    if (!d) throw new Error('Live data could not be loaded.');
    const [series, acts] = await Promise.all([
      d.observation ? get(`/api/history/observations${qs({ from: new Date(new Date(d.observation.timestamp_utc) - 2 * 3600e3).toISOString(), to: new Date(new Date(d.observation.timestamp_utc).getTime() + 1000).toISOString(), order: 'asc', page_size: 30 })}`).catch(() => ({ data: [] })) : { data: [] },
      get(`/api/activities${qs({ range: '7d', page_size: 4 })}`).catch(() => ({ data: [] })),
    ]);
    return { d, series: series.data, acts: acts.data };
  }

  async function render() {
    let data;
    try { data = await load(); } catch (err) {
      if (!['SESSION_EXPIRED', 'SESSION_MISSING'].includes(err.code)) root.innerHTML = errorBox(err);
      return;
    }
    const { d, series, acts } = data;
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
              <div><h3>DO Trend &amp; Forecast</h3><p>Recent observed dissolved oxygen followed by the +30, +60, +90, and +120 minute forecasts.</p></div></div>
            <div class="do-trend-live-badge"><span class="do-trend-live-dot"></span>${d.freshness?.state === 'LIVE' ? 'LIVE' : (d.freshness?.state || 'NO DATA').replace('_', ' ')}</div>
          </div>
          <div class="do-trend-legend">
            <div class="do-trend-legend-item"><span class="do-trend-line-key observed"></span><span>Observed DO</span></div>
            <div class="do-trend-legend-item"><span class="do-trend-line-key forecast"></span><span>Forecast DO</span></div>
            <div class="do-trend-legend-item"><span class="do-trend-threshold-key watch"></span><span>Watch reference ≤ ${fmtNum(rule.watch_boundary_do_mg_l, 1)} mg/L</span></div>
            <div class="do-trend-legend-item"><span class="do-trend-threshold-key critical"></span><span>Critical reference ≤ ${fmtNum(rule.critical_do_mg_l, 1)} mg/L</span></div>
          </div>
          ${d.critical_outlook?.crossing_expected ? raw(html`<div class="do-trend-outlook">${ic('triangle-alert', 15)}<span><strong>Forecast outlook:</strong> The forecast reaches the configured critical reference by approximately ${outlook}.</span></div>`) : ''}
          <div class="do-trend-chart" id="live-chart"></div>
          <div class="do-trend-value-grid">
            ${[{ label: 'Current', icon: 'activity', v: doValue }, ...d.forecasts.map((f) => ({ label: `+${f.horizon_minutes} min`, icon: 'clock-3', v: f.forecast_status === 'VALID' ? f.predicted_do_mg_l : null, status: f.forecast_status }))]
              .map((c) => { const b = doBand(c.v, rule); return raw(html`<div class="do-trend-value-card ${b === 'critical' ? 'critical' : b === 'watch' ? 'attention' : 'normal'}">
                <div class="do-trend-value-label">${ic(c.icon, 13)}${c.label}</div><strong>${c.v === null ? '--' : fmtNum(c.v)}</strong><span>${c.v === null && c.status ? c.status.replace(/_/g, ' ') : 'mg/L'}</span></div>`); })}
          </div>
          <div class="do-trend-footnote">${ic('activity', 14)}<span>Observed values are the last 2 hours of synced 10-minute cycles. Forecasts are the four XGBoost horizons generated for the latest cycle.</span></div>
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

    chart?.destroy();
    const chartHost = root.querySelector('#live-chart');
    if (o) {
      const originT = new Date(o.timestamp_utc);
      chart = mountChart(chartHost, {
        ariaLabel: 'Observed and forecast dissolved oxygen',
        series: [
          { name: 'Observed DO', color: '#0d9488', points: series.map((r) => ({ x: new Date(r.timestamp_utc), y: r.do_mg_l_status === 'VALID' ? r.do_mg_l : null })), dots: series.length <= 14 },
          { name: 'Forecast DO', color: '#0284c7', dashed: true, points: [{ x: originT, y: doValue }, ...d.forecasts.map((f) => ({ x: new Date(originT.getTime() + f.horizon_minutes * 60000), y: f.forecast_status === 'VALID' ? f.predicted_do_mg_l : null }))] },
        ],
        refAreas: rule.critical_do_mg_l !== null ? [{ y1: 0, y2: rule.critical_do_mg_l, fill: '#f43f5e0d' }, { y1: rule.critical_do_mg_l, y2: rule.watch_boundary_do_mg_l, fill: '#f59e0b0a' }] : [],
        refLines: rule.critical_do_mg_l !== null ? [{ y: rule.watch_boundary_do_mg_l, label: `Watch ${fmtNum(rule.watch_boundary_do_mg_l, 1)}`, color: '#d97706' }, { y: rule.critical_do_mg_l, label: `Critical ${fmtNum(rule.critical_do_mg_l, 1)}`, color: '#e11d48' }] : [],
        markerX: { x: originT, label: 'Current' },
        xFormat: (dt) => fmtTime(dt.toISOString()), tooltipX: (dt) => fmtDateTime(dt.toISOString()),
        leftLabel: 'DO mg/L',
      });
    } else chartHost.innerHTML = '<div class="aq-state small"><strong>No observations yet</strong></div>';

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
