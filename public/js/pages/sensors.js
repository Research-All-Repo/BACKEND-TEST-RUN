// Sensors & Device: sensor registry + calibration status, Raspberry Pi edge health,
// health history chart, and the aerator control path (request -> controller ack).
import { get } from '../api.js';
import { html, raw, ic, fmtNum, fmtDateTime, fmtTime, ago, titleCase, errorBox, loadingBox, openModal } from '../ui.js';
import { mountChart, CONTEXT_COLOR } from '../chart.js';

const VAR_LABEL = {
  do_mg_l: 'Dissolved O₂', do_saturation_pct: 'DO saturation', water_temp_c: 'Water temp', ph_value: 'pH', light_lux: 'Light',
  air_temp_c: 'Air temp', relative_humidity_pct: 'Humidity', atmospheric_pressure_hpa: 'Pressure',
};
const SENSOR_ICON = (t) => (/oxygen|dissolved|do/i.test(t) ? 'droplets' : /ph/i.test(t) ? 'flask-conical' : /light|lux/i.test(t) ? 'sun'
  : /humid|sht|air/i.test(t) ? 'thermometer' : /press|baro|bmp/i.test(t) ? 'gauge' : 'microchip');
const DATA_CHIP = { OK: ['available', 'Reading OK'], DEGRADED: ['pending', 'Partly invalid'], FAULT: ['prototype', 'Invalid reading'], NO_DATA: ['pending', 'No data'], NOT_MAPPED: ['prototype', 'Not mapped'] };
const busChip = (s) => (s === 'OK' ? 'available' : s === 'DEGRADED' ? 'pending' : 'prototype');

export default async function sensors(root) {
  let chart = null;
  root.innerHTML = html`<div class="sensors2-page">${raw(loadingBox('Loading sensor registry…'))}</div>`;
  const page = root.firstElementChild;

  let data; let aer; let hist;
  try {
    [data, aer, hist] = await Promise.all([
      get('/api/sensors'), get('/api/aerator').catch(() => null), get('/api/sensors/health?range=24h').catch(() => null),
    ]);
  } catch (err) { page.innerHTML = errorBox(err); return undefined; }

  const { sensors: list, system_health: h, latest_observation_utc: lastObs } = data.data;
  const fresh = data.meta.freshness;
  const active = list.filter((s) => s.status === 'ACTIVE');
  const okReadings = active.filter((s) => s.data_status === 'OK').length;
  const calOk = list.filter((s) => s.latest_calibration?.result === 'PASSED').length;
  const a = aer?.data;

  page.innerHTML = html`
    <section class="dashboard-panel sensors2-overview-panel">
      <div class="sensors2-header">
        <div class="sensors2-heading"><div class="sensors2-heading-icon">${ic('cpu', 22)}</div>
          <div><div class="sensors2-title-row"><h2>Sensors &amp; Edge Device</h2><span class="sensors2-purpose-badge">DEVICE REGISTRY</span></div>
            <p>Sensors registered for this deployment, their latest data-quality status and calibration records, plus the health of the Raspberry Pi edge controller.</p></div></div>
        <div class="sensors2-scope-card"><span>Latest edge observation</span><strong>${lastObs ? fmtDateTime(lastObs) : 'No data yet'}</strong><span>${titleCase(fresh?.state || 'NO_DATA')}${lastObs ? ` · ${ago(lastObs)}` : ''}</span></div>
      </div>
      <div class="sensors2-summary-grid">
        <article class="sensors2-summary-card"><span>Registered Sensors</span><strong>${list.length}</strong><p>${active.length} active · ${list.length - active.length} spare / service / retired.</p></article>
        <article class="sensors2-summary-card"><span>Readings OK</span><strong>${okReadings} / ${active.length}</strong><p>Active sensors whose latest readings were all flagged VALID.</p></article>
        <article class="sensors2-summary-card"><span>Calibration Passed</span><strong>${calOk} / ${list.length}</strong><p>Sensors whose most recent calibration result is PASSED.</p></article>
        <article class="sensors2-summary-card"><span>Edge Sync</span><strong class="sensors2-summary-text ${h?.internet_reachable ? '' : 'pending'}">${h ? (h.internet_reachable ? 'Online' : 'Offline') : '--'}</strong>
          <p>${h?.last_cloud_sync_at_utc ? `Last cloud sync ${ago(h.last_cloud_sync_at_utc)}` : 'No sync report yet'}</p></article>
      </div>
    </section>

    <section class="dashboard-panel sensors2-edge-panel">
      <div class="sensors2-section-header"><div><span class="sensors2-eyebrow">EDGE CONTROLLER</span><h3>Raspberry Pi Health</h3>
        <p>Latest health report sent with each 10-minute cycle${h ? ` (${fmtDateTime(h.timestamp_utc)})` : ''}.</p></div></div>
      ${h ? raw(html`<div class="sensors2-edge-grid">
        ${edge('thermometer', 'CPU Temperature', `${fmtNum(h.pi_cpu_temp_c, 1)} °C`, h.pi_cpu_temp_c > 75 ? 'Running hot' : 'Within normal range')}
        ${edge('memory-stick', 'RAM Used', `${fmtNum(h.ram_used_pct, 0)} %`, `Uptime ${h.pi_uptime_s ? `${Math.floor(h.pi_uptime_s / 86400)} d ${Math.floor((h.pi_uptime_s % 86400) / 3600)} h` : '--'}`)}
        ${edge('hard-drive', 'Storage Free', `${fmtNum((h.storage_free_mb || 0) / 1024, 1)} GB`, h.local_database_operational ? 'Local database operational' : 'Local database NOT operational')}
        ${edge(h.wifi_connected ? 'wifi' : 'wifi-off', 'Wi-Fi', h.wifi_connected ? `${fmtNum(h.wifi_signal_rssi_dbm, 0)} dBm` : 'Disconnected', h.internet_reachable ? 'Internet reachable' : 'Internet NOT reachable')}
        ${edge('cable', 'Sensor Buses', `RS-485 ${h.rs485_bus_status} · I²C ${h.i2c_bus_status}`, 'Bus status reported by the edge reader')}
        ${edge('battery', 'Battery / Supply', h.battery_voltage_v ? `${fmtNum(h.battery_voltage_v, 2)} V` : 'Not measured', `Sync status ${h.sync_status}`)}
      </div>`) : raw('<div class="aq-state"><strong>No health report yet</strong><p>The edge device has not uploaded a system_health row.</p></div>')}
      <div class="sensors2-section-header" style="margin-top:18px"><div><span class="sensors2-eyebrow">PAST 24 HOURS</span><h3>CPU Temperature &amp; Memory</h3><p>Each line is reported by the Raspberry Pi with every 10-minute cycle. Values that keep rising may need attention.</p></div></div>
      <div class="history2-chart-wrapper" id="s-health-chart" style="height:320px"></div>
    </section>

    <section class="dashboard-panel sensors2-array-panel">
      <div class="sensors2-section-header"><div><span class="sensors2-eyebrow">SENSOR ARRAY</span><h3>Registered Sensors</h3>
        <p>Select a sensor to see its calibration history. Bus status comes from the latest health report.</p></div></div>
      <div class="sensors2-table-container"><table class="sensors2-table">
        <thead><tr><th>Device</th><th>Variables</th><th>Interface</th><th>Latest Reading</th><th>Data Status</th><th>Calibration</th><th>Registry Status</th><th></th></tr></thead>
        <tbody>${list.length ? list.map((s) => raw(row(s))) : raw('<tr><td colspan="8" class="activity2-empty-table">No sensors registered in sensor_registry.</td></tr>')}</tbody></table></div>
    </section>

    <section class="dashboard-panel sensors2-control-panel">
      <div class="sensors2-section-header"><div><span class="sensors2-eyebrow">CONTROL PATH</span><h3>Aerator Control</h3>
        <p>The dashboard only records a request. The Raspberry Pi validates and applies it, then reports back.</p></div></div>
      <div class="sensors2-control-flow"><span>Dashboard request</span>${ic('arrow-right', 15)}<span>Supabase (secured RPC)</span>${ic('arrow-right', 15)}<span>Raspberry Pi controller</span>${ic('arrow-right', 15)}<span>Relay output</span></div>
      ${a?.initialized ? raw(html`<div class="sensors2-control-grid">
        ${ctl('sliders-horizontal', 'Requested Mode', a.mode.requested_mode, `Revision ${a.mode.settings_revision}${a.mode.mode_requested_at_utc ? ` · ${fmtDateTime(a.mode.mode_requested_at_utc)}` : ''}`)}
        ${ctl('check-check', 'Controller Mode', a.mode.applied_mode || 'Not acknowledged', a.mode.status_text, a.mode.acknowledged ? 'available' : 'pending')}
        ${ctl('send', 'Latest Request', a.recent_commands[0] ? `${a.recent_commands[0].requested_state} · ${a.recent_commands[0].effective_status}` : 'None', a.recent_commands[0] ? `${fmtDateTime(a.recent_commands[0].requested_at_utc)} · ${a.recent_commands[0].status_text}` : 'No dashboard request yet', a.recent_commands[0]?.effective_status === 'APPLIED' ? 'available' : 'pending')}
        ${ctl('power', 'Controller Output', a.controller.output_state || 'Unknown', a.controller.output_reported_at_utc ? `Reported ${ago(a.controller.output_reported_at_utc)}${a.controller.stale ? ' (stale)' : ''}. ${a.controller.note}` : 'No report yet', a.controller.stale ? 'pending' : 'available')}
        ${ctl('activity', 'Physical Feedback', 'Not measured', a.physical_feedback.note, 'prototype')}
      </div>`) : raw(`<div class="aq-state"><strong>Aerator settings not initialised</strong><p>${a?.message || 'The aerator settings could not be loaded.'}</p></div>`)}
      <div class="sensors2-control-note">${ic('info', 16)}<p><strong>Command sent ≠ aerator running.</strong> “Applied” means the controller acknowledged switching its relay output. There is no independent sensor confirming the aerator motor is running.</p></div>
    </section>
    <div class="sensors2-info-note">${ic('info', 15)}<p>Sensor registry and calibration records are written by the edge device / field team. The dashboard shows them read-only.</p></div>`;

  function edge(i, label, value, note) {
    return raw(html`<article class="sensors2-edge-card"><div class="sensors2-edge-icon">${ic(i, 18)}</div><span>${label}</span><strong>${value}</strong><p>${note}</p></article>`);
  }
  function ctl(i, label, value, note, tone = 'available') {
    return raw(html`<article class="sensors2-control-card"><div class="sensors2-control-card-top"><div class="sensors2-control-icon">${ic(i, 16)}</div><span class="sensors2-status-chip ${tone}">${value}</span></div><strong>${label}</strong><p>${note}</p></article>`);
  }
  function row(s) {
    const chip = DATA_CHIP[s.data_status] || ['pending', s.data_status];
    const r = s.latest_readings[0];
    const cal = s.latest_calibration;
    return html`<tr tabindex="0" data-sensor="${s.sensor_id}">
      <td><div class="sensors2-device-cell"><div class="sensors2-device-icon">${ic(SENSOR_ICON(s.sensor_type), 17)}</div><div><strong>${s.manufacturer} ${s.model}</strong><small>${titleCase(s.sensor_type)}${s.serial_number ? ` · SN ${s.serial_number}` : ''}</small></div></div></td>
      <td><div class="sensors2-variable-list">${s.monitored_variables.length ? s.monitored_variables.map((v) => raw(html`<span>${VAR_LABEL[v] || v}</span>`)) : raw('<span>—</span>')}</div></td>
      <td><span class="sensors2-interface">${s.bus ? `${s.bus.name}${s.bus.status ? ` · ${s.bus.status}` : ''}` : '—'}</span></td>
      <td><span class="sensors2-reading">${r && r.usable ? `${fmtNum(r.value, r.unit === 'lux' ? 0 : 2)} ${r.unit}` : r ? r.quality_status : '—'}</span></td>
      <td><span class="sensors2-status-chip ${chip[0]}">${chip[1]}</span></td>
      <td><span class="sensors2-role">${cal ? `${titleCase(cal.result)} · ${cal.calibration_completed_at_utc ? fmtDateTime(cal.calibration_completed_at_utc) : 'in progress'}` : 'No record'}</span></td>
      <td><span class="sensors2-status-chip ${s.status === 'ACTIVE' ? 'available' : 'pending'}">${titleCase(s.status)}</span></td>
      <td><span class="sensors2-row-action">${ic('chevron-right', 16)}</span></td></tr>`;
  }

  page.querySelectorAll('[data-sensor]').forEach((tr) => {
    const open = () => openSensor(list.find((s) => s.sensor_id === tr.dataset.sensor));
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  });

  const hp = hist?.data || [];
  chart = mountChart(page.querySelector('#s-health-chart'), {
    ariaLabel: 'Raspberry Pi CPU temperature and memory use, past 24 hours',
    panels: [
      { title: 'CPU temperature', unit: '°C', zones: [{ from: 80, to: Infinity, fill: '#e11d4812', solid: '#e11d48', label: 'Throttling risk (≥ 80 °C)', legend: 'CPU ≥ 80 °C: throttling risk' }],
        thresholds: [{ y: 80 }], series: [{ name: 'CPU temperature', color: '#e2553d', points: hp.map((x) => ({ x: new Date(x.timestamp_utc), y: x.pi_cpu_temp_c })), dots: false, endLabel: true, format: (v) => fmtNum(v, 1) }], yFormat: (v) => fmtNum(v, 0) },
      { title: 'Memory used', unit: '%', domain: [0, 100], series: [{ name: 'Memory used', color: CONTEXT_COLOR, points: hp.map((x) => ({ x: new Date(x.timestamp_utc), y: x.ram_used_pct })), dots: false, endLabel: true, format: (v) => fmtNum(v, 0) }], yFormat: (v) => fmtNum(v, 0) },
    ],
    tooltipX: (d) => fmtDateTime(d.toISOString()),
  });

  async function openSensor(s) {
    openModal({
      overlayClass: 'sensors2-modal-overlay', modalClass: 'sensors2-modal',
      content: html`<div class="sensors2-modal-header"><div class="sensors2-modal-title"><div class="sensors2-modal-icon">${ic(SENSOR_ICON(s.sensor_type), 20)}</div>
          <div><span>${titleCase(s.sensor_type).toUpperCase()}</span><h3>${s.manufacturer} ${s.model}</h3><p>${s.serial_number ? `Serial ${s.serial_number} · ` : ''}Registered ${fmtDateTime(s.created_at_utc)}</p></div></div>
          <button type="button" class="sensors2-modal-close" data-close aria-label="Close">${ic('x', 18)}</button></div>
        <div class="sensors2-detail-list">
          <div class="sensors2-detail-row"><span>Registry status</span><strong>${titleCase(s.status)}</strong></div>
          <div class="sensors2-detail-row"><span>Interface</span><strong>${s.bus ? `${s.bus.name} (${s.bus.status || 'unknown'})` : '—'}</strong></div>
          ${s.latest_readings.map((r) => raw(html`<div class="sensors2-detail-row"><span>${VAR_LABEL[r.variable] || r.variable}</span><strong class="sensors2-detail-reading">${r.usable ? `${fmtNum(r.value, r.unit === 'lux' ? 0 : 2)} ${r.unit}` : r.quality_status}</strong></div>`))}
          ${s.notes ? raw(html`<div class="sensors2-detail-row"><span>Notes</span><strong>${s.notes}</strong></div>`) : ''}
        </div>
        <div style="padding:0 20px 8px"><span class="sensors2-eyebrow">CALIBRATION HISTORY</span><div id="cal-list" class="model2-table-container" style="margin-top:8px">${raw(loadingBox())}</div></div>
        <div class="sensors2-modal-footer"><button type="button" data-close>Close</button></div>`,
      onMount: async (m) => {
        const box = m.querySelector('#cal-list');
        try {
          const c = (await get(`/api/sensors/${s.sensor_id}/calibrations`)).data.calibrations;
          box.innerHTML = c.length ? html`<table class="model2-table"><thead><tr><th>Started</th><th>Type</th><th>Result</th><th>Notes</th></tr></thead><tbody>
            ${c.map((x) => raw(html`<tr><td>${fmtDateTime(x.calibration_started_at_utc)}</td><td>${titleCase(x.calibration_type)}</td>
              <td><span class="sensors2-status-chip ${x.result === 'PASSED' ? 'available' : x.result === 'FAILED' ? 'prototype' : 'pending'}">${titleCase(x.result)}</span></td><td>${x.notes || '—'}</td></tr>`))}</tbody></table>`
            : '<p class="aq-muted">No calibration records for this sensor.</p>';
        } catch (err) { box.innerHTML = errorBox(err); }
      },
    });
  }

  return () => chart?.destroy();
}
