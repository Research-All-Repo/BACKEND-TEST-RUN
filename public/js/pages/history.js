// History & Trends: observations by date/time range (preset or custom), summary cards,
// DO vs one context variable chart, recorded risk distribution, paginated records, CSV export.
import { get, qs } from '../api.js';
import { html, raw, ic, fmtNum, fmtDateTime, fmtTime, fmtDate, riskKey, riskLabel, localInputToIso, isoToLocalInput, toast, errorBox, loadingBox } from '../ui.js';
import { mountChart } from '../chart.js';
import { paginationHtml, wirePagination } from './shared.js';

const OVERLAYS = {
  water_temp_c: { label: 'Water Temperature', short: 'Water Temperature', unit: '°C', d: 1 },
  ph_value: { label: 'Acidity (pH)', short: 'pH', unit: 'pH', d: 2 },
  light_lux: { label: 'Light Intensity', short: 'Light Intensity', unit: 'lux', d: 0 },
  air_temp_c: { label: 'Air Temperature', short: 'Air Temperature', unit: '°C', d: 1 },
  relative_humidity_pct: { label: 'Relative Humidity', short: 'Relative Humidity', unit: '%', d: 0 },
  atmospheric_pressure_hpa: { label: 'Atmospheric Pressure', short: 'Pressure', unit: 'hPa', d: 1 },
};
const RANGES = { '24h': 'Past 24 Hours', '7d': 'Past 7 Days', '30d': 'Past 30 Days', custom: 'Custom Range' };

export default async function history(root) {
  const st = { range: '24h', from: '', to: '', overlay: 'water_temp_c', page: 1, pageSize: 10 };
  let chart = null;

  root.innerHTML = html`<div class="history-trends-page history2-page">
    <section class="dashboard-panel history2-overview-panel">
      <div class="history2-header">
        <div class="history2-heading-group"><div class="history2-heading-icon">${ic('rotate-ccw-clock', 22)}</div>
          <div><div class="history2-title-row"><h2>Historical Observations &amp; Trends</h2><span class="history2-history-badge">OBSERVED HISTORY</span></div>
            <p>Review historical dissolved oxygen behavior, environmental context, recorded risk states, and aeration records for any date and time range.</p></div></div>
        <a class="history2-export-button" id="h-csv" href="#" download>${ic('download', 16)}Export CSV</a>
      </div>
      <div class="history2-control-grid">
        <div class="history2-control-card"><div class="history2-control-label">${ic('calendar-range', 15)}<span>Historical Range</span></div>
          <div class="history2-select-wrapper"><select id="h-range">${Object.entries(RANGES).map(([k, v]) => raw(`<option value="${k}">${v}</option>`))}</select>${ic('chevron-down', 15)}</div>
          <div class="history2-custom-range aq-hidden" id="h-custom">
            <input class="aq-input" type="datetime-local" id="h-from" aria-label="From (station time)">
            <input class="aq-input" type="datetime-local" id="h-to" aria-label="To (station time)">
            <button type="button" class="aq-btn primary" id="h-apply" style="grid-column:1/-1">${ic('search', 14)}Apply range</button>
          </div></div>
        <div class="history2-control-card"><div class="history2-control-label">${ic('sliders-horizontal', 15)}<span>Context Overlay</span></div>
          <div class="history2-select-wrapper"><select id="h-overlay">${Object.entries(OVERLAYS).map(([k, v]) => raw(`<option value="${k}">DO vs ${v.label}</option>`))}</select>${ic('chevron-down', 15)}</div></div>
        <div class="history2-record-card"><div><span>Records Shown</span><strong id="h-count">—</strong></div><div class="history2-record-icon">${ic('database', 20)}</div></div>
      </div>
      <div class="history2-summary-grid" id="h-summary"></div>
    </section>
    <section class="dashboard-panel history2-chart-panel" id="h-chart-panel"></section>
    <section class="dashboard-panel history2-table-panel" id="h-table-panel"></section>
  </div>`;

  const rangeParams = () => (st.range === 'custom' ? { from: localInputToIso(st.from), to: localInputToIso(st.to) } : { range: st.range });
  const rangeText = () => (st.range === 'custom' ? `${fmtDateTime(localInputToIso(st.from))} – ${fmtDateTime(localInputToIso(st.to))}` : RANGES[st.range]);

  async function loadAll() {
    const p = rangeParams();
    root.querySelector('#h-csv').href = `/api/history/export.csv${qs(p)}`;
    root.querySelector('#h-summary').innerHTML = loadingBox();
    root.querySelector('#h-chart-panel').innerHTML = loadingBox();
    try {
      const [sum, series] = await Promise.all([get(`/api/history/summary${qs(p)}`), get(`/api/history/series${qs(p)}`)]);
      renderSummary(sum.data);
      renderChart(series, sum.data);
    } catch (err) {
      root.querySelector('#h-summary').innerHTML = errorBox(err);
      root.querySelector('#h-chart-panel').innerHTML = '';
    }
    await loadTable();
  }

  function renderSummary(s) {
    root.querySelector('#h-count').textContent = `${s.records ?? 0} records`;
    const net = s.net_do_change;
    root.querySelector('#h-summary').innerHTML = html`
      <article class="history2-summary-card"><div class="history2-summary-top">${ic('droplets', 15)}<span>Average DO</span></div><strong>${fmtNum(s.avg_do)}<small>mg/L</small></strong><p>Mean of valid DO readings in the selected range.</p></article>
      <article class="history2-summary-card"><div class="history2-summary-top">${ic('activity', 15)}<span>Historical DO Range</span></div><strong>${fmtNum(s.min_do)}–${fmtNum(s.max_do)}<small>mg/L</small></strong><p>Minimum to maximum observed DO in the selected range.</p></article>
      <article class="history2-summary-card"><div class="history2-summary-top">${ic(net < 0 ? 'arrow-down-right' : 'arrow-up-right', 15)}<span>Net DO Change</span></div><strong class="${net < 0 ? 'history2-negative' : ''}">${net === null || net === undefined ? '--' : `${net > 0 ? '+' : ''}${fmtNum(net)}`}<small>mg/L</small></strong><p>Oldest to latest valid observation in the range.</p></article>
      <article class="history2-summary-card"><div class="history2-summary-top">${ic('shield-alert', 15)}<span>Elevated Risk Records</span></div><strong>${s.elevated_risk_records ?? 0} / ${s.records ?? 0}</strong><p>Cycles classified Watch, Warning or Critical (${s.critical_records ?? 0} critical).</p></article>`;
  }

  function renderChart(series, s) {
    const ov = OVERLAYS[st.overlay];
    const rc = s.risk_counts || {};
    const panel = root.querySelector('#h-chart-panel');
    panel.innerHTML = html`<div class="history2-section-header"><div><span class="history2-eyebrow">HISTORICAL ANALYSIS</span><h3>Dissolved Oxygen &amp; Context Trend</h3>
        <p>Observed DO against ${ov.label.toLowerCase()} across the selected range (${series.meta.bucket_minutes}-minute averages).</p></div>
        <div class="history2-chart-context"><span>${rangeText()}</span><span>${ov.short}</span></div></div>
      <div class="history2-chart-legend">
        <span class="history2-legend-item"><i class="history2-legend-line history2-do-line"></i>Dissolved Oxygen</span>
        <span class="history2-legend-item"><i class="history2-legend-line" style="background:#8b5cf6"></i>${ov.short} (${ov.unit})</span>
        <span class="history2-legend-item history2-legend-muted">Watch boundary 5.0 mg/L</span>
        <span class="history2-legend-item history2-legend-muted">Critical 3.0 mg/L</span></div>
      <div class="history2-chart-wrapper" id="h-chart"></div>
      <div class="history2-chart-footer">
        <div class="history2-risk-distribution"><span>Recorded risk states</span><div>
          <span class="history2-risk-mini normal">Normal ${rc.NORMAL ?? 0}</span><span class="history2-risk-mini watch">Watch ${rc.WATCH ?? 0}</span>
          <span class="history2-risk-mini warning">Warning ${rc.WARNING ?? 0}</span><span class="history2-risk-mini critical">Critical ${rc.CRITICAL ?? 0}</span></div></div>
        <span class="history2-history-note">Risk states are shown exactly as recorded by the edge device for each 10-minute cycle${rc.DATA_UNAVAILABLE ? ` (${rc.DATA_UNAVAILABLE} cycles had insufficient data)` : ''}.</span></div>`;
    chart?.destroy();
    const long = series.meta.bucket_minutes >= 120;
    chart = mountChart(panel.querySelector('#h-chart'), {
      ariaLabel: `Dissolved oxygen versus ${ov.label}`,
      series: [
        { name: 'Dissolved Oxygen (mg/L)', color: '#0d9488', points: series.data.map((r) => ({ x: new Date(r.bucket_start), y: r.do_mg_l })), dots: false },
        { name: `${ov.short} (${ov.unit})`, color: '#8b5cf6', axis: 'right', width: 1.8, points: series.data.map((r) => ({ x: new Date(r.bucket_start), y: r[st.overlay] })), dots: false, format: (v) => fmtNum(v, ov.d) },
      ],
      refLines: [{ y: 5, label: 'Boundary 5.0', color: '#d97706' }, { y: 3, label: 'Critical 3.0', color: '#e11d48' }],
      xFormat: (dt) => (long ? fmtDate(dt.toISOString()).replace(/, \d{4}$/, '') : fmtTime(dt.toISOString())),
      tooltipX: (dt) => fmtDateTime(dt.toISOString()), leftLabel: 'DO mg/L',
    });
  }

  async function loadTable() {
    const panel = root.querySelector('#h-table-panel');
    try {
      const r = await get(`/api/history/observations${qs({ ...rangeParams(), page: st.page, page_size: st.pageSize })}`);
      const v = (row, k, st2, d) => (row[st2] === 'VALID' ? fmtNum(row[k], d) : raw(`<span class="aq-muted" title="${row[st2]}">${row[st2] === 'MISSING' ? '—' : 'ERR'}</span>`));
      panel.innerHTML = html`<div class="history2-section-header"><div><span class="history2-eyebrow">HISTORICAL RECORDS</span><h3>Observation Records</h3>
          <p>Measurements per 10-minute cycle with the recorded risk state. ERR marks a sensor reading that was not valid.</p></div><span class="history2-table-count">${r.meta.total} records</span></div>
        <div class="history2-table-container"><table class="history2-table">
          <thead><tr><th>Timestamp</th><th>DO <small>mg/L</small></th><th>Water Temp <small>°C</small></th><th>pH</th><th>Light <small>lux</small></th>
            <th>Air Temp <small>°C</small></th><th>Humidity <small>%</small></th><th>Pressure <small>hPa</small></th><th>Aeration Record</th><th>Recorded Risk State</th></tr></thead>
          <tbody>${r.data.length ? r.data.map((row) => raw(html`<tr>
            <td class="history2-timestamp">${fmtDateTime(row.timestamp_utc)}</td>
            <td class="history2-do-value">${v(row, 'do_mg_l', 'do_mg_l_status', 2)}</td>
            <td>${v(row, 'water_temp_c', 'water_temp_status', 1)}</td><td>${v(row, 'ph_value', 'ph_status', 2)}</td><td>${v(row, 'light_lux', 'light_status', 0)}</td>
            <td>${v(row, 'air_temp_c', 'air_temp_status', 1)}</td><td>${v(row, 'relative_humidity_pct', 'humidity_status', 0)}</td><td>${v(row, 'atmospheric_pressure_hpa', 'pressure_status', 1)}</td>
            <td><span class="history2-aeration-badge ${row.aeration_recorded === 'NONE' ? 'off' : 'on'}">${row.aeration_recorded === 'NONE' ? 'OFF record' : row.aeration_recorded === 'MANUALLY_LOGGED' ? 'ON (logged)' : 'ON record'}</span></td>
            <td><span class="history2-risk-badge ${riskKey(row.recorded_risk_state) === 'unknown' ? 'data' : riskKey(row.recorded_risk_state)}">${row.recorded_risk_state ? riskLabel(row.recorded_risk_state) : 'NOT ASSESSED'}</span></td></tr>`))
            : raw('<tr><td colspan="10" class="activity2-empty-table">No observations in this range.</td></tr>')}</tbody></table></div>
        ${raw(paginationHtml('history2', { page: st.page, pageSize: st.pageSize, total: r.meta.total, noun: 'historical records' }))}
        <div class="history2-table-footer"><span>Historical range: ${rangeText()}.</span><span>Data are read from Supabase; timestamps are shown in station time (Asia/Manila).</span></div>`;
      wirePagination(panel, (c) => { Object.assign(st, c); loadTable(); });
    } catch (err) { panel.innerHTML = errorBox(err); }
  }

  root.querySelector('#h-range').addEventListener('change', (e) => {
    const custom = e.target.value === 'custom';
    root.querySelector('#h-custom').classList.toggle('aq-hidden', !custom);
    if (custom) {
      if (!st.from) { st.from = isoToLocalInput(new Date(Date.now() - 48 * 3600e3).toISOString()); st.to = isoToLocalInput(new Date().toISOString()); }
      root.querySelector('#h-from').value = st.from; root.querySelector('#h-to').value = st.to;
      return;
    }
    st.range = e.target.value; st.page = 1; loadAll();
  });
  root.querySelector('#h-apply').addEventListener('click', () => {
    const f = root.querySelector('#h-from').value; const t = root.querySelector('#h-to').value;
    if (!f || !t) { toast('Choose both a start and an end date/time.', 'error'); return; }
    if (new Date(localInputToIso(f)) >= new Date(localInputToIso(t))) { toast('The start must be earlier than the end.', 'error'); return; }
    Object.assign(st, { range: 'custom', from: f, to: t, page: 1 });
    loadAll();
  });
  root.querySelector('#h-overlay').addEventListener('change', async (e) => {
    st.overlay = e.target.value;
    try {
      const p = rangeParams();
      const [sum, series] = await Promise.all([get(`/api/history/summary${qs(p)}`), get(`/api/history/series${qs(p)}`)]);
      renderChart(series, sum.data);
    } catch (err) { toast(err.message, 'error'); }
  });

  await loadAll();
  return () => chart?.destroy();
}
