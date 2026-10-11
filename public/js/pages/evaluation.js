// Model Evaluation (ADMIN): registered forecast models and operational accuracy per horizon,
// plus a predicted-vs-observed chart. Operational metrics only, not thesis results.
import { get } from '../api.js';
import { html, raw, ic, fmtNum, fmtDateTime, titleCase, errorBox, loadingBox } from '../ui.js';
import { mountChart } from '../chart.js';
import { accuracyChartConfig } from './shared.js';

export default async function evaluation(root, ctx) {
  let chart = null;
  root.innerHTML = html`<div class="model2-page">${raw(loadingBox('Loading model evaluation…'))}</div>`;
  const page = root.firstElementChild;
  let r;
  try { r = await get('/api/evaluation'); } catch (err) { page.innerHTML = errorBox(err); return undefined; }
  const { models, horizons, data_since_utc: since } = r.data;
  const ready = horizons.some((x) => x.samples > 0);
  const deployed = models.filter((m) => m.deployment_status === 'DEPLOYED');
  const totalSamples = horizons.reduce((s, x) => s + x.samples, 0);
  const best = horizons.filter((x) => x.mae !== null).sort((a, b) => a.mae - b.mae)[0];

  page.innerHTML = html`
    <section class="dashboard-panel model2-overview-panel">
      <div class="model2-header">
        <div class="model2-heading"><div class="model2-heading-icon">${ic('brain-circuit', 22)}</div>
          <div><div class="model2-title-row"><h2>Forecast Model Evaluation</h2><span class="model2-admin-badge">ADMIN ONLY</span></div>
            <p>Operational accuracy of the deployed DO forecasting models, computed from stored forecasts matched to the observed DO at each target time.</p></div></div>
        <div class="model2-evaluation-status"><span>Evaluation status</span><strong class="${ready ? 'ready' : 'pending'}">${ready ? 'Metrics available' : 'Awaiting matched samples'}</strong></div>
      </div>
      <div class="model2-overview-grid">
        ${card('boxes', 'Deployed Models', `${deployed.length} / 4`, 'One deployed model per forecast horizon.')}
        ${card('database', 'Matched Samples', totalSamples, 'Valid forecasts with a valid observation at the target time.')}
        ${card('target', 'Lowest MAE', best ? `${fmtNum(best.mae, 3)} mg/L` : '--', best ? `+${best.horizon_minutes} min horizon.` : 'No matched samples yet.')}
        ${card('calendar-clock', 'Data Since', since ? fmtDateTime(since) : '--', 'Earliest observation stored in the database.')}
      </div>
    </section>

    <section class="dashboard-panel model2-context-panel">
      <div class="model2-section-header"><div><span class="model2-eyebrow">EVALUATION CONTEXT</span><h3>How These Numbers Are Computed</h3></div></div>
      <div class="model2-context-grid">
        <div class="model2-context-row"><span>Target variable</span><strong>Dissolved oxygen (mg/L)</strong></div>
        <div class="model2-context-row"><span>Horizons</span><strong>+30, +60, +90, +120 minutes</strong></div>
        <div class="model2-context-row"><span>Sampling interval</span><strong>10 minutes</strong></div>
        <div class="model2-context-row"><span>Matching rule</span><strong>Forecast target time = observation time, both VALID</strong></div>
      </div>
      <div class="model2-method-note">${ic('info', 15)}<p><strong>Caution.</strong> ${r.meta.caution}</p></div>
    </section>

    <section class="dashboard-panel model2-performance-panel">
      <div class="model2-section-header"><div><span class="model2-eyebrow">PERFORMANCE</span><h3>Accuracy by Forecast Horizon</h3>
        <p>${r.meta.basis}</p></div></div>
      <div class="model2-table-container"><table class="model2-table">
        <thead><tr><th>Horizon</th><th>Deployed Model</th><th>Samples</th><th>MAE</th><th>RMSE</th><th>R²</th><th>Mean Bias</th><th>Status</th></tr></thead>
        <tbody>${horizons.map((x) => raw(html`<tr>
          <td><div class="model2-horizon-cell"><strong>+${x.horizon_minutes} min</strong><small>${x.lead_steps} steps ahead</small></div></td>
          <td>${x.deployed_model ? `${x.deployed_model.model_name} ${x.deployed_model.version}` : '—'}${x.deployed_model ? raw(html`<br><small class="aq-muted">${x.deployed_model.algorithm}</small>`) : ''}</td>
          <td>${x.samples}</td>
          <td><span class="model2-metric-value">${x.mae === null ? '--' : fmtNum(x.mae, 3)}</span></td>
          <td><span class="model2-metric-value">${x.rmse === null ? '--' : fmtNum(x.rmse, 3)}</span></td>
          <td><span class="model2-metric-value">${x.r2 === null ? '--' : fmtNum(x.r2, 3)}</span></td>
          <td><span class="model2-metric-value">${x.mean_bias === null ? '--' : `${x.mean_bias > 0 ? '+' : ''}${fmtNum(x.mean_bias, 3)}`}</span></td>
          <td><span class="model2-status-badge ${x.samples ? 'ready' : 'pending'}">${x.samples ? 'Available' : 'No samples'}</span></td></tr>`))}</tbody></table></div>
      <div class="model2-metric-guide">
        <article>${ic('ruler', 15)}<div><strong>MAE</strong><p>Average absolute error in mg/L. Lower is better.</p></div></article>
        <article>${ic('sigma', 15)}<div><strong>RMSE</strong><p>Penalises large misses more than MAE. Lower is better.</p></div></article>
        <article>${ic('chart-scatter', 15)}<div><strong>R²</strong><p>Share of DO variation explained. Closer to 1 is better.</p></div></article>
        <article>${ic('scale', 15)}<div><strong>Mean bias</strong><p>Positive = forecasts tend to be higher than observed.</p></div></article>
      </div>
    </section>

    <section class="dashboard-panel model2-performance-panel">
      <div class="model2-section-header"><div><span class="model2-eyebrow">PREDICTED VS MEASURED</span><h3>Forecasts Against Measured DO (last 48 h)</h3>
        <p>Solid line: measured DO. Dashed line: what the model had predicted for that same time. Inside the light band = accurate; orange dots = misses.</p></div>
        <div class="history2-select-wrapper"><select id="ev-h">${[30, 60, 90, 120].map((h) => raw(`<option value="${h}" ${h === 60 ? 'selected' : ''}>+${h} min horizon</option>`))}</select>${ic('chevron-down', 14)}</div></div>
      <p class="aq-chart-summary" id="ev-summary"></p>
      <div class="history2-chart-wrapper" id="ev-chart" style="height:420px"></div>
    </section>

    <section class="dashboard-panel model2-performance-panel">
      <div class="model2-section-header"><div><span class="model2-eyebrow">MODEL REGISTRY</span><h3>Registered Forecast Models</h3></div></div>
      <div class="model2-table-container"><table class="model2-table"><thead><tr><th>Model</th><th>Algorithm</th><th>Horizon</th><th>Training Window</th><th>Model File</th><th>Status</th></tr></thead>
        <tbody>${models.length ? models.map((m) => raw(html`<tr><td><strong>${m.model_name}</strong> ${m.version}</td><td>${m.algorithm}</td><td>+${m.forecast_horizon_min} min</td>
          <td>${m.training_start_utc ? `${fmtDateTime(m.training_start_utc)} – ${fmtDateTime(m.training_end_utc)}` : '—'}</td><td><span class="user2-mono">${m.model_file_name || '—'}</span></td>
          <td><span class="model2-status-badge ${m.deployment_status === 'DEPLOYED' ? 'ready' : 'pending'}">${titleCase(m.deployment_status)}</span></td></tr>`))
          : raw('<tr><td colspan="6">No models registered in forecast_models.</td></tr>')}</tbody></table></div>
    </section>
    <div class="model2-prototype-note">${ic('info', 15)}<p>These are live operational metrics from the data in Supabase. When the data are simulated (mock edge), they are not thesis results.</p></div>`;

  function card(i, label, value, note) {
    return raw(html`<article class="model2-overview-card"><div class="model2-overview-icon">${ic(i, 17)}</div><span>${label}</span><strong>${value}</strong><p>${note}</p></article>`);
  }

  async function loadSeries(h) {
    const host = page.querySelector('#ev-chart');
    const sum = page.querySelector('#ev-summary');
    host.innerHTML = loadingBox();
    try {
      const pts = (await get(`/api/evaluation/series?horizon=${h}&range=48h`)).data.points;
      chart?.destroy();
      if (pts.length) {
        const errs = pts.map((p) => p.predicted - p.observed);
        const mae = errs.reduce((a, e) => a + Math.abs(e), 0) / errs.length;
        const worst = errs.reduce((a, e) => (Math.abs(e) > Math.abs(a) ? e : a), 0);
        const within = Math.round((errs.filter((e) => Math.abs(e) <= 0.3).length / errs.length) * 100);
        sum.innerHTML = html`Across ${pts.length} forecasts, the <strong>+${h} min</strong> model was off by <strong>${fmtNum(mae, 2)} mg/L</strong> on average and within ±0.3 mg/L <strong>${within}%</strong> of the time. The largest miss was ${worst > 0 ? '+' : ''}${fmtNum(worst, 2)} mg/L.`;
      } else sum.textContent = 'No forecast in the last 48 hours has a measured value to compare with yet.';
      chart = mountChart(host, accuracyChartConfig(pts.map((p) => ({ t: p.target_timestamp_utc, measured: p.observed, forecast: p.predicted })), h, ctx?.live?.()?.rule_reference, { label: 'Prediction' }));
    } catch (err) { host.innerHTML = errorBox(err); }
  }
  page.querySelector('#ev-h').addEventListener('change', (e) => loadSeries(Number(e.target.value)));
  await loadSeries(60);
  return () => { chart?.destroy(); };
}
