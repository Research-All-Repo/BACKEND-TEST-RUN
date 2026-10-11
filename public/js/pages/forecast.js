// Forecast & Risk: the four official horizons of the latest cycle (+30/+60/+90/+120 min),
// the official risk assessment built from them, interpretation, decision support, forecast-vs-observed.
import { get, qs } from '../api.js';
import { html, raw, ic, fmtNum, fmtTime, fmtDateTime, riskKey, riskLabel, doBand, guidanceFor, errorBox } from '../ui.js';
import { mountChart, doZones, doThresholds, DO_COLOR, FORECAST_COLOR } from '../chart.js';

const BAND_LABEL = { normal: 'NORMAL RANGE', watch: 'WATCH RANGE', critical: '≤ CRITICAL THRESHOLD', unknown: 'DATA UNAVAILABLE' };
const BAND_TEXT = {
  normal: 'Forecast remains at or above the normal/watch boundary.',
  watch: 'Forecast falls within the watch range: above the critical threshold but below the normal/watch boundary.',
  critical: 'Forecast reaches or crosses the configured critical dissolved oxygen threshold. This describes the forecast only; the cycle risk state is shown separately.',
  unknown: 'No valid forecast value is available for this horizon.',
};

function interpretation(risk, cur, rule, firstCrit, firstSub) {
  const c = rule.critical_do_mg_l; const w = rule.watch_boundary_do_mg_l;
  switch (risk) {
    case 'CRITICAL': return { title: 'Critical low-DO condition is already present.', text: 'The current observed dissolved oxygen has reached or crossed the configured critical threshold. This is an existing critical condition, not only a future forecast concern.',
      why: `Current DO is ${fmtNum(cur)} mg/L, at or below the ${fmtNum(c)} mg/L critical threshold.`, timing: 'Current observation' };
    case 'WARNING': {
      const sub = cur !== null && cur > c && cur < w;
      let why = 'AquaCast detected a condition that requires operator attention.';
      if (sub && firstCrit) why = `Current DO is already between ${fmtNum(c)} and ${fmtNum(w)} mg/L, and the +${firstCrit.horizon_minutes} min forecast reaches ${fmtNum(firstCrit.predicted_do_mg_l)} mg/L.`;
      else if (sub) why = `Current DO is ${fmtNum(cur)} mg/L: above the critical threshold but below the ${fmtNum(w)} mg/L normal/watch boundary.`;
      else if (firstCrit) why = `Current DO remains at or above ${fmtNum(w)} mg/L, but the +${firstCrit.horizon_minutes} min forecast reaches ${fmtNum(firstCrit.predicted_do_mg_l)} mg/L.`;
      return { title: 'Operator attention is needed.', text: 'AquaCast classified this monitoring cycle as Warning because suboptimal dissolved oxygen is already present and/or a forecast reaches the critical threshold.',
        why, timing: firstCrit ? `+${firstCrit.horizon_minutes} min` : 'Current condition' };
    }
    case 'WATCH': return { title: 'Developing deterioration is forecast.', text: 'Current dissolved oxygen remains at or above the normal/watch boundary, but at least one forecast enters the suboptimal range without reaching the critical threshold.',
      why: firstSub ? `The first suboptimal forecast is ${fmtNum(firstSub.predicted_do_mg_l)} mg/L at +${firstSub.horizon_minutes} min.` : 'At least one forecast is below the normal/watch boundary.', timing: firstSub ? `+${firstSub.horizon_minutes} min` : 'Within forecast window' };
    case 'NORMAL': return { title: 'No elevated low-DO risk is indicated.', text: 'The current dissolved oxygen and all required forecast horizons remain at or above the normal/watch boundary for this monitoring cycle.',
      why: `Current DO and all forecasts remain at or above ${fmtNum(w)} mg/L.`, timing: 'No threshold crossing' };
    default: return { title: 'Risk classification is unavailable.', text: 'AquaCast does not have enough valid information to establish the risk state for this monitoring cycle.',
      why: 'Verify the current observation, forecast availability, and edge device status.', timing: 'Unavailable' };
  }
}

export default async function forecast(root) {
  let charts = [];
  const { data: d } = await get('/api/forecast/latest');
  if (!d) { root.innerHTML = '<div class="aq-state"><strong>No forecast cycle yet</strong><p>Forecasts appear after the edge device syncs its first observation and the four model outputs.</p></div>'; return undefined; }
  const rule = d.rule_reference;
  const cur = d.origin.do_mg_l_status === 'VALID' ? d.origin.do_mg_l : null;
  const risk = d.risk.current_risk_state || 'DATA_UNAVAILABLE';
  const rk = riskKey(risk);
  const hz = d.horizons.map((h) => ({ ...h, band: h.forecast_status === 'VALID' ? doBand(h.predicted_do_mg_l, rule) : 'unknown' }));
  const firstCrit = hz.find((h) => h.band === 'critical');
  const firstSub = hz.find((h) => h.band === 'watch' || h.band === 'critical');
  const interp = interpretation(risk, cur, rule, firstCrit, firstSub);
  const g = guidanceFor(risk);
  const model = hz.find((h) => h.model)?.model;
  let selected = 60;

  root.innerHTML = html`<div class="forecast-redesign-page">
    <section class="dashboard-panel forecast-redesign-overview">
      <div class="forecast-redesign-header">
        <div class="forecast-redesign-heading"><div class="forecast-redesign-heading-icon">${ic('brain-circuit', 22)}</div>
          <div><h2>Dissolved Oxygen Forecast &amp; Risk</h2><p>Multi-horizon dissolved oxygen forecasting, risk interpretation, and decision-support evidence for the latest AquaCast prediction cycle (origin ${fmtDateTime(d.origin.forecast_origin_utc)}).</p>
            <div class="forecast-model-group"><span class="forecast-model-badge">${model ? `${model.model_name.replace(/ DO \+\d+ min$/, '')} • ${model.version}` : 'XGBoost Regression'}</span>
              <span class="forecast-prototype-badge">${d.summary.valid_horizons}/4 HORIZONS VALID</span></div></div></div>
        <div class="forecast-overall-risk ${rk === 'unknown' ? 'unknown' : rk}"><span>AquaCast Risk State</span><strong class="forecast-risk-${rk}">${riskLabel(risk)}</strong></div>
      </div>
      <div class="forecast-summary-grid">
        ${[['activity', 'Forecast Origin', cur === null ? '--' : `${fmtNum(cur)} mg/L`, 'Observed DO used as the starting reference for this forecast cycle.'],
          ['clock-3', 'Forecast Window', '120 minutes', 'Four separate horizons at 30-minute intervals.'],
          ['triangle-alert', 'Earliest Critical', cur !== null && cur <= rule.critical_do_mg_l ? 'Current condition' : firstCrit ? `+${firstCrit.horizon_minutes} min` : 'Not within 120 min', 'First forecast at or below the configured critical threshold.'],
          ['gauge', 'Projected Change', d.summary.projected_change_120_mg_l === null ? '--' : `${d.summary.projected_change_120_mg_l > 0 ? '+' : ''}${fmtNum(d.summary.projected_change_120_mg_l)} mg/L`, 'Change from forecast origin to the +120-minute prediction.']]
          .map(([i, l, v, s]) => raw(html`<div class="forecast-summary-card"><div class="forecast-summary-card-top">${ic(i, 14)}${l}</div><strong>${v}</strong><small>${s}</small></div>`))}
      </div>
      <div class="forecast-section-heading"><h3>Forecast Horizons</h3><p>Horizon-specific AquaCast outputs for +30, +60, +90, and +120 minutes.</p></div>
      <div class="forecast-redesign-horizon-grid forecast-four-horizons">
        ${hz.map((h) => raw(html`<article class="forecast-redesign-horizon-card ${h.band}">
          <div class="forecast-redesign-horizon-top"><span>+${h.horizon_minutes} Minute Forecast</span><span class="forecast-band ${h.band}">${BAND_LABEL[h.band]}</span></div>
          <div class="forecast-redesign-horizon-value"><strong>${h.forecast_status === 'VALID' ? fmtNum(h.predicted_do_mg_l) : '--'}</strong><span>${h.forecast_status === 'VALID' ? 'mg/L' : h.forecast_status.replace(/_/g, ' ')}</span></div>
          <p>${BAND_TEXT[h.band]}</p></article>`))}
      </div>
    </section>

    <section class="dashboard-panel forecast-redesign-analysis">
      <div class="forecast-analysis-header">
        <div class="forecast-analysis-title">${ic('trending-down', 19)}<div><h3>Forecast Progression</h3><p>Observed forecast origin followed by predictions at +30, +60, +90, and +120 minutes.</p></div></div>
        <div class="forecast-analysis-outlook">${firstCrit ? raw(html`The configured critical threshold is first reached at <strong>+${firstCrit.horizon_minutes} min</strong>.`) : 'None of the current forecasts reaches the configured critical threshold within 120 minutes.'}</div>
      </div>
      <div class="forecast-redesign-chart" id="fc-chart"></div>
      <div class="forecast-redesign-selector forecast-four-selector">
        ${hz.map((h) => raw(html`<button type="button" data-h="${h.horizon_minutes}"><span class="forecast-selector-left">${ic('circle-dot', 13)}+${h.horizon_minutes} min</span><strong>${h.forecast_status === 'VALID' ? fmtNum(h.predicted_do_mg_l) : '--'}</strong></button>`))}
      </div>
      <div class="forecast-redesign-inspector" id="fc-inspector"></div>
      <div class="forecast-redesign-note">${ic('triangle-alert', 15)}<span>Horizon badges show forecast threshold status. The AquaCast Risk State is the cycle-level classification produced by the edge device from the current DO and the four horizons using rule ${rule.rule_version}.</span></div>
    </section>

    <section class="forecast-support-grid">
      <article class="dashboard-panel forecast-risk-interpretation-panel">
        <div class="forecast-support-header"><div class="forecast-support-title"><div class="forecast-support-icon">${ic('shield-alert', 18)}</div>
          <div><h3>Risk Interpretation</h3><p>Explanation of the official AquaCast risk state.</p></div></div>
          <span class="forecast-support-risk-badge forecast-support-risk-${rk}">${riskLabel(risk)}</span></div>
        <div class="forecast-interpretation-main"><span>WHAT THIS STATE MEANS</span><strong>${interp.title}</strong><p>${interp.text}</p></div>
        <div class="forecast-evidence-grid">
          <div class="forecast-evidence-card"><span>Why this state?</span><strong>${interp.why}</strong></div>
          <div class="forecast-evidence-card"><span>Projected timing</span><strong>${d.risk.expected_threshold_crossing_utc ? `${interp.timing} (≈ ${fmtTime(d.risk.expected_threshold_crossing_utc)})` : interp.timing}</strong></div>
          <div class="forecast-evidence-card"><span>Current DO</span><strong>${cur === null ? 'Unavailable' : `${fmtNum(cur)} mg/L`}</strong></div>
          <div class="forecast-evidence-card"><span>Risk references</span><strong>Boundary ${fmtNum(rule.watch_boundary_do_mg_l)} • Critical ≤ ${fmtNum(rule.critical_do_mg_l)} mg/L</strong></div>
        </div>
      </article>
      <article class="dashboard-panel forecast-decision-support-panel">
        <div class="forecast-support-header"><div class="forecast-support-title"><div class="forecast-support-icon">${ic('shield-check', 18)}</div>
          <div><h3>Decision Support</h3><p>Risk-responsive guidance for the pond operator.</p></div></div><span class="forecast-human-loop-badge">HUMAN-IN-THE-LOOP</span></div>
        <div class="forecast-decision-main"><span>CURRENT GUIDANCE</span><strong>${g.title}</strong><p>${g.description}</p></div>
        <div class="forecast-decision-steps">${g.steps.map((s, i) => raw(html`<div class="forecast-decision-step"><span class="forecast-step-number">${i + 1}</span><p>${s}</p></div>`))}</div>
        <div class="forecast-control-note">${ic('eye', 15)}<span>This page provides analysis and decision-support information only. Manual aeration requests are made on Live Status by an authorized operator.</span></div>
      </article>
    </section>

    <section class="dashboard-panel forecast-redesign-analysis">
      <div class="forecast-analysis-header">
        <div class="forecast-analysis-title">${ic('activity', 19)}<div><h3>How Accurate Were Recent Forecasts? (last 24 h)</h3><p>Each forecast is drawn at the time it was predicting, next to the DO actually measured then.</p></div></div>
        <div class="history2-select-wrapper"><select id="fvo-h">${[30, 60, 90, 120].map((h) => raw(`<option value="${h}" ${h === 60 ? 'selected' : ''}>+${h} min horizon</option>`))}</select>${ic('chevron-down', 15)}</div>
      </div>
      <p class="aq-chart-summary" id="fvo-summary"></p>
      <div class="forecast-redesign-chart" id="fvo-chart" style="height:400px"></div>
    </section>
  </div>`;

  const origin = new Date(d.origin.forecast_origin_utc);
  charts.push(mountChart(root.querySelector('#fc-chart'), {
    ariaLabel: 'Forecast progression from now to 120 minutes ahead',
    panels: [{ title: 'Forecast dissolved oxygen', unit: 'mg/L', includeThresholds: true, zones: doZones(rule), thresholds: doThresholds(rule),
      series: [{ name: 'Forecast DO', color: FORECAST_COLOR, dashed: true, dots: true,
        points: [{ x: origin, y: cur, fill: DO_COLOR, r: 5 }, ...hz.map((h) => ({ x: new Date(origin.getTime() + h.horizon_minutes * 60000), y: h.forecast_status === 'VALID' ? h.predicted_do_mg_l : null }))] }] }],
    xTicks: [0, 30, 60, 90, 120].map((m) => new Date(origin.getTime() + m * 60000)),
    xFormat: (dt, o) => { const m = Math.round((dt - origin) / 60000); return m <= 0 ? 'Now' : o?.narrow ? `+${m}m` : `+${m} min`; },
    tooltipX: (dt) => { const m = Math.round((dt - origin) / 60000); return m <= 0 ? `Now (observed) · ${fmtTime(dt.toISOString())}` : `+${m} min forecast · ${fmtTime(dt.toISOString())}`; },
    legend: false,
  }));

  const inspector = root.querySelector('#fc-inspector');
  function select(h) {
    selected = h;
    root.querySelectorAll('[data-h]').forEach((b) => b.classList.toggle('active', Number(b.dataset.h) === h));
    const f = hz.find((x) => x.horizon_minutes === h);
    inspector.innerHTML = html`<div class="forecast-inspector-primary-new"><span class="forecast-inspector-eyebrow-new">Selected Forecast Horizon</span><h3>+${h} Minute Forecast</h3>
        <div class="forecast-inspector-big-value"><strong>${f.forecast_status === 'VALID' ? fmtNum(f.predicted_do_mg_l) : '--'}</strong><span>mg/L</span></div><p>${BAND_TEXT[f.band]}</p></div>
      <div class="forecast-inspector-details-new">
        <div class="forecast-detail-new">${ic('clock-3', 15)}<span>Target Time</span><strong>${f.target_timestamp_utc ? fmtDateTime(f.target_timestamp_utc) : `${h} minutes ahead`}</strong></div>
        <div class="forecast-detail-new">${ic('activity', 15)}<span>Change vs Forecast Origin</span><strong>${f.change_from_origin_mg_l === null ? '--' : `${f.change_from_origin_mg_l > 0 ? '+' : ''}${fmtNum(f.change_from_origin_mg_l)} mg/L`}</strong></div>
        <div class="forecast-detail-new">${ic('shield-alert', 15)}<span>Forecast Threshold Status</span><strong class="forecast-risk-${f.band === 'unknown' ? 'unknown' : f.band}">${BAND_LABEL[f.band]}</strong></div>
        <div class="forecast-detail-new">${ic('gauge', 15)}<span>Model / Status</span><strong>${f.model ? `${f.model.version} • ${f.forecast_status}` : f.forecast_status}</strong></div>
      </div>`;
  }
  root.querySelectorAll('[data-h]').forEach((b) => b.addEventListener('click', () => select(Number(b.dataset.h))));
  select(selected);

  const fvoHost = root.querySelector('#fvo-chart');
  let fvo = null;
  async function loadFvo() {
    fvo?.destroy();
    fvoHost.innerHTML = '';
    try {
      const { data } = await get(`/api/forecast/history${qs({ horizon: root.querySelector('#fvo-h').value, range: '24h' })}`);
      const h = Number(root.querySelector('#fvo-h').value);
      const pairs = data.points.filter((p) => Number.isFinite(p.observed_do_mg_l) && Number.isFinite(p.predicted_do_mg_l));
      const sumBox = root.querySelector('#fvo-summary');
      if (pairs.length) {
        const errs = pairs.map((p) => p.predicted_do_mg_l - p.observed_do_mg_l);
        const mae = errs.reduce((a, e) => a + Math.abs(e), 0) / errs.length;
        const within = Math.round((errs.filter((e) => Math.abs(e) <= 0.3).length / errs.length) * 100);
        const bias = errs.reduce((a, e) => a + e, 0) / errs.length;
        sumBox.innerHTML = html`Over the last 24 hours the <strong>+${h} min</strong> forecast missed the measured DO by <strong>${fmtNum(mae)} mg/L</strong> on average, and was within ±0.3 mg/L <strong>${within}%</strong> of the time. ${Math.abs(bias) < 0.05 ? 'It shows no consistent over- or under-prediction.' : `It tends to ${bias > 0 ? 'over' : 'under'}-predict by about ${fmtNum(Math.abs(bias))} mg/L.`}`;
      } else sumBox.textContent = 'No forecast in the last 24 hours has a measured value to compare with yet.';
      fvo = mountChart(fvoHost, {
        ariaLabel: `Forecast versus measured DO for the +${h} minute horizon, last 24 hours`,
        panels: [
          { title: 'Dissolved oxygen at the target time', unit: 'mg/L', weight: 1.6, zones: doZones(rule), thresholds: doThresholds(rule),
            series: [
              { name: 'Measured', color: DO_COLOR, points: pairs.map((p) => ({ x: new Date(p.target_timestamp_utc), y: p.observed_do_mg_l })), dots: false },
              { name: `Forecast made ${h} min earlier`, color: FORECAST_COLOR, dashed: true, points: pairs.map((p) => ({ x: new Date(p.target_timestamp_utc), y: p.predicted_do_mg_l })), dots: false },
            ] },
          { title: 'Forecast miss (forecast − measured)', unit: 'mg/L', weight: 1, allowNegative: true,
            zones: [{ from: -0.3, to: 0.3, fill: '#10b98114', solid: '#10b981', label: 'Within ±0.3', legend: 'Within ±0.3 mg/L' }],
            thresholds: [{ y: 0, label: '0' }],
            series: [{ name: 'Forecast miss', color: '#64748b', width: 1.5, points: pairs.map((p) => ({ x: new Date(p.target_timestamp_utc), y: Math.round((p.predicted_do_mg_l - p.observed_do_mg_l) * 1000) / 1000 })), dots: false,
              format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}` }] },
        ],
        tooltipX: (dt) => `Target time ${fmtDateTime(dt.toISOString())}`,
      });
    } catch (err) { fvoHost.innerHTML = errorBox(err); }
  }
  root.querySelector('#fvo-h').addEventListener('change', loadFvo);
  loadFvo();
  charts.push({ destroy: () => fvo?.destroy() });
  return () => { charts.forEach((c) => c.destroy()); charts = []; };
}
