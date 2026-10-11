// Alerts (risk notifications): active (unacknowledged, last 24 h) and acknowledged history.
// Acknowledging records who reviewed it; it does not mean the pond condition is resolved.
import { get, post } from '../api.js';
import { html, raw, ic, fmtNum, fmtDateTime, ago, riskKey, riskLabel, toast, errorBox, loadingBox, openModal, busy } from '../ui.js';

const SEV_ICON = { CRITICAL: 'octagon-alert', WARNING: 'triangle-alert', WATCH: 'eye' };

export default async function alerts(root, ctx) {
  root.innerHTML = html`<div class="alerts2-page">
    <section class="dashboard-panel alerts2-overview-panel" id="al-overview">${raw(loadingBox())}</section>
    <section class="dashboard-panel alerts2-active-panel" id="al-active"></section>
    <section class="dashboard-panel alerts2-history-panel" id="al-history"></section>
  </div>`;

  async function load() {
    try {
      const [active, history] = await Promise.all([
        get('/api/alerts?status=active&page_size=50'),
        get('/api/alerts?status=acknowledged&range=7d&page_size=30'),
      ]);
      render(active, history);
    } catch (err) {
      root.querySelector('#al-overview').innerHTML = errorBox(err);
    }
  }

  function render(active, history) {
    const list = active.data;
    const highest = active.meta.highest_severity === 'NONE' ? 'NORMAL' : active.meta.highest_severity;
    const crit = list.filter((a) => a.current_risk_state === 'CRITICAL').length;
    const warn = list.filter((a) => a.current_risk_state === 'WARNING').length;
    const station = ctx.station();
    root.querySelector('#al-overview').innerHTML = html`
      <div class="alerts2-header">
        <div class="alerts2-heading"><div class="alerts2-heading-icon">${ic('bell-ring', 22)}</div>
          <div><div class="alerts2-title-row"><h2>Alerts &amp; Risk Notifications</h2><span class="alerts2-live-badge">LIVE REVIEW</span></div>
            <p>Risk escalations recorded by the edge rule engine. Each alert is the cycle where the official risk state changed into Watch, Warning or Critical.</p></div></div>
        <div class="alerts2-highest-state ${riskKey(highest)}"><span>Highest active state</span><strong>${riskLabel(highest)}</strong></div>
      </div>
      <div class="alerts2-summary-grid">
        <article class="alerts2-summary-card"><div class="alerts2-summary-top">${ic('bell', 15)}<span>Active Alerts</span></div><strong>${list.length}</strong><p>Unacknowledged escalations in the last 24 hours.</p></article>
        <article class="alerts2-summary-card"><div class="alerts2-summary-top">${ic('octagon-alert', 15)}<span>Critical / Warning</span></div><strong>${crit} / ${warn}</strong><p>Active alerts at the two highest severity levels.</p></article>
        <article class="alerts2-summary-card"><div class="alerts2-summary-top">${ic('check-check', 15)}<span>Reviewed (7 days)</span></div><strong>${history.meta.total ?? history.data.length}</strong><p>Alerts acknowledged by an operator in the past week.</p></article>
      </div>`;

    root.querySelector('#al-active').innerHTML = html`
      <div class="alerts2-section-header"><div><span class="alerts2-eyebrow">ACTIVE ALERTS</span><h3>Alerts Requiring Review</h3>
        <p>Newest first. Acknowledge after you have reviewed the pond condition and decided on a response.</p></div>
        <span class="alerts2-count-pill ${list.length ? '' : 'neutral'}">${list.length} active</span></div>
      <div class="alerts2-active-list">${list.length ? list.map((a) => raw(alertCard(a, station))) : raw(html`<div class="alerts2-empty-state">${ic('shield-check', 28)}<strong>No active alerts</strong><p>No unacknowledged Watch, Warning or Critical escalation in the last 24 hours.</p></div>`)}</div>
      <div class="alerts2-control-note">${ic('info', 16)}<span>Alerts never switch the aerator. Manual aeration is requested by an operator from Live Status, and the controller acknowledgement is shown there.</span></div>`;

    root.querySelector('#al-history').innerHTML = html`
      <div class="alerts2-section-header"><div><span class="alerts2-eyebrow">ALERT HISTORY</span><h3>Acknowledged Alerts</h3>
        <p>Alerts reviewed in the past 7 days, with the reviewer and note saved in the audit log.</p></div><span class="alerts2-archive-badge">Past 7 days</span></div>
      <div class="alerts2-history-list">${history.data.length ? history.data.map((a) => raw(html`
        <article class="alerts2-history-card">
          <div class="alerts2-history-content"><div class="alerts2-history-title"><strong>${titleFor(a)}</strong><span>${fmtDateTime(a.observation_timestamp_utc)}</span></div>
            <p>DO ${fmtNum(a.do_mg_l)} mg/L${a.min_forecast_do_mg_l !== null ? ` · lowest forecast ${fmtNum(a.min_forecast_do_mg_l)} mg/L` : ''}${a.acknowledgement_note ? ` · Note: ${a.acknowledgement_note}` : ''}</p>
            <div class="alerts2-acknowledged-by">${ic('user-check', 14)}<span>Acknowledged by ${a.acknowledged_by_name || 'an operator'} · ${fmtDateTime(a.acknowledged_at)}</span></div></div>
          <span class="alerts2-severity-badge ${riskKey(a.current_risk_state)}">${ic(SEV_ICON[a.current_risk_state] || 'bell', 13)}${a.current_risk_state}</span></article>`))
        : raw('<div class="alerts2-no-history">No alerts were acknowledged in the past 7 days.</div>')}</div>
      <div class="alerts2-prototype-note">Acknowledging an alert records that it was reviewed. It does not change the recorded risk state or mean the condition is resolved.</div>`;

    root.querySelectorAll('[data-ack]').forEach((b) => b.addEventListener('click', () => acknowledge(b.dataset.ack, list.find((a) => a.risk_id === b.dataset.ack))));
  }

  function titleFor(a) {
    const prev = a.previous_risk_state ? riskLabel(a.previous_risk_state) : 'start of record';
    return `${a.current_risk_state === 'CRITICAL' ? 'Critical DO risk' : a.current_risk_state === 'WARNING' ? 'DO warning' : 'DO watch'} (from ${prev})`;
  }

  function alertCard(a, station) {
    return html`<article class="alerts2-alert-card ${riskKey(a.current_risk_state)}">
      <div class="alerts2-alert-top"><span class="alerts2-severity-badge ${riskKey(a.current_risk_state)}">${ic(SEV_ICON[a.current_risk_state] || 'bell', 13)}${a.current_risk_state}</span>
        <span class="alerts2-alert-time">${ic('clock', 13)}${fmtDateTime(a.observation_timestamp_utc)} · ${ago(a.observation_timestamp_utc)}</span></div>
      <div class="alerts2-alert-main"><div class="alerts2-alert-title-line"><h3>${titleFor(a)}</h3><span class="alerts2-station">${station}</span></div>
        <p>${a.forecast_outlook ? `Forecast outlook: ${a.forecast_outlook.replace(/_/g, ' ').toLowerCase()}.` : 'Recorded by the edge risk rule.'}
          ${a.expected_threshold_crossing_utc ? ` Expected critical threshold crossing around ${fmtDateTime(a.expected_threshold_crossing_utc)}.` : ''}</p></div>
      <div class="alerts2-evidence-grid">
        <div class="alerts2-evidence-card">${ic('droplets', 15)}<div><span>Observed DO</span><strong>${a.do_mg_l_status === 'VALID' ? `${fmtNum(a.do_mg_l)} mg/L` : a.do_mg_l_status}</strong></div></div>
        <div class="alerts2-evidence-card">${ic('trending-down', 15)}<div><span>Lowest forecast</span><strong>${a.min_forecast_do_mg_l !== null ? `${fmtNum(a.min_forecast_do_mg_l)} mg/L` : '--'}</strong></div></div>
        <div class="alerts2-evidence-card">${ic('scale', 15)}<div><span>Rule</span><strong>${a.rule_reference?.rule_version || a.rule_version || '--'}</strong></div></div>
      </div>
      <div class="alerts2-guidance">${ic('clipboard-check', 15)}<div><span>${a.guidance.title}</span>${a.guidance.steps.map((s) => raw(html`<p>• ${s}</p>`))}</div></div>
      <div class="alerts2-alert-footer"><div class="alerts2-alert-id">Alert <strong>${a.risk_id.slice(0, 8)}</strong></div>
        <button type="button" class="alerts2-acknowledge-button" data-ack="${a.risk_id}">${ic('check', 15)}Acknowledge</button></div>
    </article>`;
  }

  function acknowledge(id, a) {
    openModal({
      overlayClass: 'user2-modal-overlay', modalClass: 'user2-modal',
      content: html`<div class="user2-modal-header"><div><span>ACKNOWLEDGE ALERT</span><h3>${a ? titleFor(a) : 'Alert'}</h3>
          <p>Confirms you reviewed this alert. The pond condition is not marked resolved.</p></div>
          <button type="button" data-close aria-label="Close">${ic('x', 18)}</button></div>
        <form class="user2-form"><div class="user2-form-group"><label>Review note (optional)</label>
          <textarea class="aq-input" name="note" rows="3" maxlength="500" placeholder="e.g. Checked probe; started manual aeration from Live Status."></textarea></div>
          <div class="user2-form-actions"><button type="button" class="secondary" data-close>Cancel</button><button type="submit" class="primary">Acknowledge</button></div></form>`,
      onMount: (m, close) => m.querySelector('form').addEventListener('submit', (e) => {
        e.preventDefault();
        busy(e.submitter, async () => {
          try {
            await post(`/api/alerts/${id}/acknowledge`, { note: e.target.note.value });
            toast('Alert acknowledged and saved to the audit log.', 'success');
            close(); ctx.refreshLive(); load();
          } catch (err) { toast(err.message, 'error'); }
        });
      }),
    });
  }

  await load();
  const t = setInterval(load, 60_000);
  return () => clearInterval(t);
}
