// System Settings (ADMIN): only settings that exist in the database.
// study_metadata (editable fields), aerator mode request (controller must acknowledge),
// locked study guardrails (read-only), and mock-edge tools when the simulator is enabled.
import { get, post, patch } from '../api.js';
import { html, raw, ic, esc, fmtNum, fmtDateTime, ago, titleCase, isoToLocalInput, localInputToIso, toast, errorBox, loadingBox, openModal, busy } from '../ui.js';

const TEXT_FIELDS = [
  ['site_description', 'Site description', 'Station / pond description shown across the dashboard.', true],
  ['culture_species', 'Culture species', 'e.g. Nile tilapia (Oreochromis niloticus)'],
  ['culture_stage', 'Culture stage', 'e.g. Grow-out'],
  ['culture_system', 'Culture system', 'e.g. Earthen pond, semi-intensive'],
  ['timezone', 'Station time zone', 'IANA name, e.g. Asia/Manila'],
];
const NUM_FIELDS = [
  ['pond_length_m', 'Pond length (m)'], ['pond_width_m', 'Pond width (m)'], ['pond_depth_m', 'Pond depth (m)'], ['probe_depth_m', 'Probe depth (m)'],
];

export default async function settings(root, ctx) {
  root.innerHTML = html`<div class="settings2-page">${raw(loadingBox('Loading settings…'))}</div>`;
  const page = root.firstElementChild;
  let pollT;

  async function load() {
    let s; let dev = null;
    try {
      [s, dev] = await Promise.all([get('/api/settings'), get('/api/dev/mock-edge').catch(() => null)]);
    } catch (err) { page.innerHTML = errorBox(err); return; }
    render(s.data, dev?.data || null);
  }

  function render(d, dev) {
    const { study, aerator: a, locked } = d;
    const rule = locked.risk_rule;
    const area = study ? study.pond_length_m * study.pond_width_m : null;
    page.innerHTML = html`
      <section class="dashboard-panel settings2-overview-panel">
        <div class="settings2-header">
          <div class="settings2-heading"><div class="settings2-heading-icon">${ic('settings', 22)}</div>
            <div><div class="settings2-title-row"><h2>System Settings</h2><span class="settings2-admin-badge">ADMIN ONLY</span></div>
              <p>Study and station details stored in Supabase. Study-design guardrails (sampling interval, horizons, risk thresholds) are locked and shown read-only.</p></div></div>
          <button type="submit" form="st-form" class="settings2-save-button" id="st-save" ${study ? '' : 'disabled'}>${ic('save', 16)}Save Changes</button>
        </div>
        <div class="settings2-summary-grid">
          <article class="settings2-summary-card"><div class="settings2-summary-icon">${ic('map-pin', 17)}</div><span>Deployment</span><strong>${study ? fmtDateTime(study.deployment_start_utc) : 'Not set'}</strong><p>${study?.deployment_end_utc ? `Ends ${fmtDateTime(study.deployment_end_utc)}` : 'Ongoing deployment'}</p></article>
          <article class="settings2-summary-card"><div class="settings2-summary-icon">${ic('power', 17)}</div><span>Aerator Mode</span><strong>${a?.initialized ? (a.mode.applied_mode || 'Not acknowledged') : '--'}</strong><p>${a?.initialized ? (a.mode.acknowledged ? 'Acknowledged by the controller' : `Requested ${a.mode.requested_mode}; waiting for controller`) : 'Settings row not initialised'}</p></article>
          <article class="settings2-summary-card"><div class="settings2-summary-icon">${ic('shield-check', 17)}</div><span>Risk Rule</span><strong>${rule.rule_version}</strong><p>Critical ≤ ${fmtNum(rule.critical_do_mg_l, 1)} mg/L · Watch boundary ${fmtNum(rule.watch_boundary_do_mg_l, 1)} mg/L</p></article>
        </div>
      </section>

      <section class="dashboard-panel settings2-profile-panel">
        <div class="settings2-section-header">${ic('building-complex', 18)}<div><span class="settings2-eyebrow">STUDY &amp; STATION</span><h3>Station Profile</h3>
          <p>Saved to study_metadata through an audited RPC. Only changed fields are sent.</p></div><span class="settings2-status-badge editable">EDITABLE</span></div>
        ${study ? raw(html`<form id="st-form" class="settings2-form-grid" novalidate>
          ${TEXT_FIELDS.map(([k, label, hint, span]) => raw(html`<label class="settings2-form-group ${span ? 'settings2-form-span' : ''}"><span>${label}</span>
            ${span ? raw(html`<textarea name="${k}" rows="2" maxlength="2000">${study[k] || ''}</textarea>`) : raw(html`<input name="${k}" maxlength="200" value="${study[k] || ''}">`)}<small>${hint}</small></label>`))}
          ${NUM_FIELDS.map(([k, label]) => raw(html`<label class="settings2-form-group"><span>${label}</span><input name="${k}" type="number" min="0.01" step="0.01" value="${study[k] ?? ''}"><small>Positive number, metres.</small></label>`))}
          <label class="settings2-form-group"><span>Deployment end (station time)</span><input name="deployment_end_utc" type="datetime-local" value="${study.deployment_end_utc ? isoToLocalInput(study.deployment_end_utc) : ''}"><small>Leave blank while the deployment is ongoing.</small></label>
          <label class="settings2-form-group"><span>Deployment start</span><input value="${fmtDateTime(study.deployment_start_utc)}" disabled><small>Set by the edge device; read-only.</small></label>
          <label class="settings2-form-group settings2-form-span"><span>Notes</span><textarea name="notes" rows="3" maxlength="2000">${study.notes || ''}</textarea><small>Internal notes about this deployment.</small></label>
        </form>
        <div class="settings2-save-message neutral aq-hidden" id="st-msg"></div>`) : raw('<div class="aq-state"><strong>No study_metadata row yet</strong><p>The edge device creates it at first start-up. Nothing to edit until then.</p></div>')}
      </section>

      <section class="dashboard-panel settings2-guardrails-panel">
        <div class="settings2-section-header">${ic('lock', 18)}<div><span class="settings2-eyebrow">STUDY GUARDRAILS</span><h3>Locked Study Parameters</h3>
          <p>${locked.note}</p></div><span class="settings2-status-badge locked">LOCKED</span></div>
        <div class="settings2-guardrail-grid">
          ${guard('timer', 'Sampling interval', `${locked.sampling_interval_min ?? '--'} minutes`, 'One observation and forecast cycle per interval.')}
          ${guard('trending-up', 'Forecast horizons', locked.forecast_horizons_min.map((h) => `+${h}`).join(' / ') + ' min', 'One deployed model per horizon.')}
          ${guard('area-chart', 'Pond area', area ? `${fmtNum(area, 1)} m²` : '--', study ? `${fmtNum(study.pond_depth_m, 2)} m deep · probe at ${fmtNum(study.probe_depth_m, 2)} m` : '')}
          ${guard('boxes', 'Deployed models', `${locked.deployed_models.length} / 4`, locked.deployed_models.map((m) => `+${m.forecast_horizon_min}: ${m.model_name} ${m.version}`).join(' · ') || 'None deployed')}
        </div>
        <div class="settings2-risk-rules"><div class="settings2-risk-rules-heading">${ic('scale', 16)}<div><strong>${rule.rule_version}</strong><span>${rule.source}</span></div></div>
          <div class="settings2-risk-rule-grid">${rule.description.slice(0, 4).map((line) => {
            const [state, text] = line.split(/:\s(.+)/);
            return raw(html`<div class="settings2-risk-rule ${state.toLowerCase()}"><span>${state}</span><p>${text}</p></div>`);
          })}</div></div>
      </section>

      <section class="dashboard-panel settings2-storage-panel">
        <div class="settings2-section-header">${ic('power', 18)}<div><span class="settings2-eyebrow">AERATOR CONTROL</span><h3>Aerator Mode</h3>
          <p>Requests a mode change. The Raspberry Pi applies it and acknowledges with the same revision number.</p></div></div>
        ${a?.initialized ? raw(html`<div class="settings2-storage-grid">
          <article><span>Requested mode</span><strong>${a.mode.requested_mode}</strong><p>Revision ${a.mode.settings_revision}${a.mode.mode_requested_at_utc ? ` · ${fmtDateTime(a.mode.mode_requested_at_utc)}` : ''}</p></article>
          <article><span>Controller mode</span><strong>${a.mode.applied_mode || 'Not acknowledged'}</strong><p>${a.mode.applied_revision !== null ? `Applied revision ${a.mode.applied_revision}` : 'No acknowledgement yet'}${a.mode.mode_applied_at_utc ? ` · ${ago(a.mode.mode_applied_at_utc)}` : ''}</p></article>
          <article><span>Controller output</span><strong>${a.controller.output_state || 'Unknown'}</strong><p>${a.controller.output_reported_at_utc ? `Reported ${ago(a.controller.output_reported_at_utc)}${a.controller.stale ? ' (stale)' : ''}` : 'No report yet'}</p></article>
        </div>
        <div class="aq-mode-toggle">
          <button type="button" class="aq-btn ${a.mode.requested_mode === 'MANUAL' ? 'primary' : ''}" data-mode="MANUAL" ${a.mode.requested_mode === 'MANUAL' ? 'disabled' : ''}>${ic('hand', 15)}Request MANUAL mode</button>
          <button type="button" class="aq-btn ${a.mode.requested_mode === 'AUTOMATIC' ? 'primary' : ''}" data-mode="AUTOMATIC" ${a.mode.requested_mode === 'AUTOMATIC' ? 'disabled' : ''}>${ic('bot', 15)}Request AUTOMATIC mode</button>
        </div>
        <div class="settings2-storage-note">${ic(a.mode.acknowledged ? 'check-check' : 'clock', 15)}<p><strong>${a.mode.acknowledged ? 'In sync.' : 'Waiting for acknowledgement.'}</strong> ${a.mode.status_text} Manual ON/OFF from Live Status only works when MANUAL is acknowledged.</p></div>`)
        : raw(`<div class="aq-state"><strong>Aerator settings not initialised</strong><p>${esc(a?.message || '')}</p></div>`)}
      </section>

      ${dev ? raw(html`<section class="dashboard-panel settings2-tools-panel">
        <div class="settings2-section-header">${ic('flask-conical', 18)}<div><span class="settings2-eyebrow danger">TEST TOOLS</span><h3>Mock Edge Simulator</h3>
          <p>Only available while MOCK_EDGE_ENABLED=true. Use it to demonstrate live, delayed and offline states. Turn it off for real deployments.</p></div><span class="settings2-status-badge prototype">TEST DATA</span></div>
        <div class="settings2-storage-grid">
          <article><span>Simulated edge</span><strong>${dev.offline ? 'Offline' : 'Online'}</strong><p>${dev.mode === 'on-request' ? `Serverless mode: catches up missing cycles while the dashboard is open (checks every ${dev.tick_seconds} s)` : `Checks for a new cycle every ${dev.tick_seconds} s`}</p></article>
          <article><span>Latest cycle</span><strong>${dev.latest_cycle_utc ? ago(dev.latest_cycle_utc) : 'None yet'}</strong><p>${dev.latest_cycle_utc ? fmtDateTime(dev.latest_cycle_utc) : 'No observations stored'}</p></article>
          <article><span>Command ack delay</span><strong>${dev.ack_delay_seconds} s</strong><p>${dev.last_error ? `Last error: ${dev.last_error}` : 'No errors'}</p></article>
        </div>
        <div class="settings2-reset-row"><div class="settings2-reset-copy"><div class="settings2-reset-icon">${ic(dev.offline ? 'wifi' : 'wifi-off', 18)}</div>
          <div><strong>${dev.offline ? 'Bring the simulated edge back online' : 'Take the simulated edge offline'}</strong><p>${dev.offline ? 'Cycles resume on the next tick.' : 'Stops new cycles so the dashboard shows Sync Delayed, then Offline.'}</p></div></div>
          <div class="aq-mode-toggle" style="margin-top:0"><button type="button" class="aq-btn" id="dev-tick">${ic('refresh-cw', 14)}Push a cycle now</button>
          <button type="button" class="settings2-reset-button" id="dev-offline">${dev.offline ? 'Go online' : 'Go offline'}</button></div></div>
      </section>`) : ''}
      <div class="settings2-prototype-note">${ic('info', 15)}<p>Only settings that exist in the database are shown. Changes are recorded in the activity log with your name.</p></div>`;

    const form = page.querySelector('#st-form');
    if (form) {
      const saveBtn = page.querySelector('#st-save');
      const changed = () => {
        const out = {};
        for (const [k] of TEXT_FIELDS) if (form[k].value.trim() !== (study[k] || '')) out[k] = form[k].value.trim();
        for (const [k] of NUM_FIELDS) if (form[k].value !== '' && Number(form[k].value) !== Number(study[k])) out[k] = Number(form[k].value);
        if (form.notes.value.trim() !== (study.notes || '')) out.notes = form.notes.value.trim();
        const endIso = form.deployment_end_utc.value ? localInputToIso(form.deployment_end_utc.value) : '';
        const cur = study.deployment_end_utc ? new Date(study.deployment_end_utc).toISOString() : '';
        if (endIso !== cur) out.deployment_end_utc = endIso;
        return out;
      };
      form.addEventListener('input', () => {
        const n = Object.keys(changed()).length;
        saveBtn.classList.toggle('changed', n > 0);
        const m = page.querySelector('#st-msg');
        m.className = `settings2-save-message neutral ${n ? '' : 'aq-hidden'}`;
        m.textContent = n ? `${n} unsaved change${n > 1 ? 's' : ''}.` : '';
      });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const body = changed();
        if (!Object.keys(body).length) { toast('No changes to save.'); return; }
        busy(saveBtn, async () => {
          try { await patch('/api/settings/study', body); toast('Station profile saved.', 'success'); ctx.refreshLive(); await load(); } catch (err) {
            const m = page.querySelector('#st-msg'); m.className = 'settings2-save-message error'; m.textContent = err.message;
          }
        });
      });
    }

    page.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => confirmMode(b.dataset.mode)));
    page.querySelector('#dev-offline')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
      try { await post('/api/dev/mock-edge', { offline: !dev.offline }); toast(dev.offline ? 'Simulated edge is back online.' : 'Simulated edge is now offline.', 'success'); await load(); ctx.refreshLive(); } catch (err) { toast(err.message, 'error'); }
    }));
    page.querySelector('#dev-tick')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
      try { await post('/api/dev/mock-edge', { tick: true }); toast('Cycle pushed.', 'success'); await load(); ctx.refreshLive(); } catch (err) { toast(err.message, 'error'); }
    }));
  }

  function guard(i, label, value, note) {
    return raw(html`<article class="settings2-guardrail-card"><div>${ic(i, 16)}</div><span>${label}</span><strong>${value}</strong><p>${note}</p></article>`);
  }

  function confirmMode(mode) {
    openModal({
      overlayClass: 'settings2-modal-overlay', modalClass: 'settings2-modal',
      content: html`<div class="settings2-modal-header"><div><span>AERATOR MODE</span><h3>Request ${mode} mode?</h3>
          <p>${mode === 'AUTOMATIC' ? 'The controller will switch the aerator by its own rule (AUTO-RULE-1.0). Manual ON/OFF requests will be blocked.' : 'Operators can request aerator ON/OFF from Live Status once the controller acknowledges MANUAL mode.'}</p></div>
          <button type="button" data-close aria-label="Close">${ic('x', 18)}</button></div>
        <div class="settings2-modal-body"><div class="settings2-modal-safety">${ic('shield-alert', 16)}<span>This only records a request. Nothing changes until the Raspberry Pi acknowledges the new revision. Pending manual commands may be cancelled by the controller.</span></div></div>
        <div class="settings2-modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button type="button" class="danger" id="mode-go">Request ${mode}</button></div>`,
      onMount: (m, close) => m.querySelector('#mode-go').addEventListener('click', (e) => busy(e.currentTarget, async () => {
        try {
          const r = await post('/api/aerator/mode', { mode });
          toast(r.meta.message, 'success'); close(); await load();
          clearTimeout(pollT); pollT = setTimeout(load, 15_000);
        } catch (err) { toast(err.message, 'error'); }
      })),
    });
  }

  await load();
  return () => clearTimeout(pollT);
}
