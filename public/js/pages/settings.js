// System Settings (ADMIN): only settings that exist in the database.
// study_metadata (editable fields), aerator mode request (controller must acknowledge),
// locked study guardrails (read-only), and mock-edge tools when the simulator is enabled.
import { get, post, patch, put } from '../api.js';
import { html, raw, ic, esc, fmtNum, fmtDateTime, ago, isoToLocalInput, localInputToIso, toast, errorBox, loadingBox, openModal, busy } from '../ui.js';

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
    let s; let dev = null; let calib = null; let errs = null; let diag = null;
    try {
      [s, dev, calib, errs, diag] = await Promise.all([get('/api/settings'), get('/api/dev/mock-edge').catch(() => null),
        get('/api/settings/calibration').catch(() => null), get('/api/errors').catch(() => null), get('/api/push/diagnostics').catch(() => null)]);
    } catch (err) { page.innerHTML = errorBox(err); return; }
    render(s.data, dev?.data || null, calib?.data || null, errs?.data || null, diag?.data || null);
  }

  function render(d, dev, calib, errs, diag) {
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

      ${raw(diagnosticsHtml(diag))}

      <section class="dashboard-panel settings2-storage-panel" id="data-export">
        <div class="settings2-section-header">${ic('download', 18)}<div><span class="settings2-eyebrow">RESEARCH DATA</span><h3>Data Export &amp; Backup</h3>
          <p>Download the study data as CSV files (open in Excel or Google Sheets). Do this at the end of every month and keep the files somewhere safe (Google Drive, USB): this is your backup outside the cloud database.</p></div></div>
        <div class="aq-export-row">
          <label class="aq-field">Month<input type="month" id="export-month" value="${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }).slice(0, 7)}"></label>
          <p class="aq-export-note" id="export-range"></p>
        </div>
        <div class="aq-export-grid" id="export-links"></div>
        <p class="aq-settings-note">Each file covers one month (Philippine time). Person names appear only in the alerts and audit files; share those only within the research team.</p>
      </section>

      <section class="dashboard-panel settings2-storage-panel">
        <div class="settings2-section-header">${ic('wrench', 18)}<div><span class="settings2-eyebrow">SENSOR CALIBRATION</span><h3>Calibration Mode</h3>
          <p>Turn this on while the DO probe is being calibrated or tested. Every dashboard then marks readings as uncalibrated, and no risk or "no data" alarms are sent (test alerts still work). Turn it off when the probe is ready.</p></div></div>
        ${calib && calib.installed !== false ? raw(html`<div class="aq-calib-row ${calib.enabled ? 'on' : ''}">
          <div><strong>${calib.enabled ? 'On: alerts are paused' : 'Off: alerts are active'}</strong><p>${calib.enabled ? `Turned on${calib.by ? ` by ${calib.by}` : ''}${calib.since ? ` at ${fmtDateTime(calib.since)}` : ''}. Switches itself off at ${fmtDateTime(calib.until)}.${calib.note ? ` Note: ${calib.note}` : ''}` : 'Readings are treated as real and trigger alerts.'}</p></div>
          <button type="button" class="aq-btn ${calib.enabled ? 'primary' : 'aq-test-warning'}" id="calib-toggle">${ic(calib.enabled ? 'bell-ring' : 'wrench', 15)}${calib.enabled ? 'Turn off (resume alerts)' : 'Turn on calibration mode'}</button></div>`)
          : raw('<div class="settings2-storage-note"><p>Run <strong>supabase/migrations/004_reliability.sql</strong> in Supabase to enable calibration mode.</p></div>')}
      </section>

      <section class="dashboard-panel settings2-storage-panel">
        <div class="settings2-section-header">${ic('bug', 18)}<div><span class="settings2-eyebrow">ERROR LOG</span><h3>Recent Errors</h3>
          <p>Unexpected problems from the server and from users' browsers, newest first (kept 30 days). An empty list is good news.</p></div></div>
        ${errs === null ? raw('<div class="settings2-storage-note"><p>The error log could not be loaded. Run <strong>004_reliability.sql</strong> in Supabase if you have not yet.</p></div>')
          : errs.length ? raw(html`<div class="aq-error-list">${errs.slice(0, 20).map((e) => raw(html`<details class="aq-error-item"><summary><span class="aq-error-src ${e.source.toLowerCase()}">${e.source === 'SERVER' ? 'Server' : 'Browser'}</span><strong>${e.message}</strong><time>${fmtDateTime(e.created_at)}</time></summary>
            <div class="aq-error-detail"><p>${e.path || ''}</p>${e.detail ? raw(html`<pre>${e.detail}</pre>`) : ''}<p class="aq-muted">${e.user_agent || ''}</p></div></details>`))}</div>`)
          : raw(`<div class="aq-state small"><strong>No errors recorded</strong><p>Nothing has gone wrong in the last 30 days.</p></div>`)}
      </section>

      <section class="dashboard-panel settings2-storage-panel">
        <div class="settings2-section-header">${ic('bell-ring', 18)}<div><span class="settings2-eyebrow">ALERT TEST</span><h3>Test Alerts on All Devices</h3>
          <p>Sends a test alert to every phone and computer with AquaCast notifications on, even when the app is closed. It is marked TEST and creates no readings.</p></div></div>
        <div class="aq-test-row">
          <button type="button" class="aq-btn aq-test-warning" data-test-alert="WARNING">${ic('bell-ring', 15)}Send test Warning</button>
          <button type="button" class="aq-btn aq-test-critical" data-test-alert="CRITICAL">${ic('triangle-alert', 15)}Send test Critical</button>
        </div>
        <div class="settings2-storage-note">${ic('info', 15)}<p><strong>Before testing:</strong> on each phone open AquaCast, tap the bell and turn on notifications (iPhone: from the Home Screen app). After a test, Phone Alert Diagnostics below shows which phones confirmed they received it.</p></div>
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
    page.querySelectorAll('[data-test-alert]').forEach((b) => b.addEventListener('click', (e) => busy(e.currentTarget, async () => {
      try {
        const r = await post('/api/alerts/test-broadcast', { level: b.dataset.testAlert });
        toast(r.meta.message, 'success');
        ctx.refreshLive();
      } catch (err) { toast(err.message, 'error'); }
    })));
    const EXPORTS = [['observations', 'Sensor readings', 'Every 10-minute reading with its recorded risk level'], ['forecasts', 'Forecasts', '+30 to +120 min predictions'],
      ['risk', 'Risk assessments', 'Risk level and forecast outlook per reading'], ['alerts', 'Alerts', 'Warning / Critical alerts and who acknowledged them'],
      ['activities', 'Activity log', 'Feeding, aeration, water exchange and other records'], ['aerator', 'Aerator', 'Requests and controller answers'],
      ['deliveries', 'Alert delivery', 'Devices sent / confirmed for each alert'], ['audit', 'Audit log', 'Every recorded action (who, what, when)']];
    const exportLinks = () => {
      const ym = page.querySelector('#export-month')?.value;
      if (!ym) return;
      const [y, mo] = ym.split('-').map(Number);
      const from = `${ym}-01T00:00:00+08:00`;
      const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
      const to = `${next}-01T00:00:00+08:00`;
      const q = `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      page.querySelector('#export-range').textContent = `${new Date(`${ym}-15T00:00:00+08:00`).toLocaleDateString('en-PH', { month: 'long', year: 'numeric', timeZone: 'Asia/Manila' })}: one CSV per dataset.`;
      page.querySelector('#export-links').innerHTML = EXPORTS.map(([id, name, note]) => html`<a class="aq-export-link" href="/api/export/${id}.csv${q}" download>${ic('download', 15)}<span><strong>${name}</strong><small>${note}</small></span></a>`).join('');
    };
    page.querySelector('#export-month')?.addEventListener('change', exportLinks);
    exportLinks();
    page.querySelector('#calib-toggle')?.addEventListener('click', (e) => {
      const turnOn = !calib.enabled;
      const go = (note, hours) => busy(e.currentTarget, async () => {
        try { const r = await put('/api/settings/calibration', { enabled: turnOn, note, ...(hours ? { hours } : {}) }); toast(r.meta.message, 'success'); await load(); ctx.refreshLive(); } catch (err) { toast(err.message, 'error'); }
      });
      if (!turnOn) { go(null); return; }
      openModal({ overlayClass: 'settings2-modal-overlay', modalClass: 'settings2-modal',
        content: html`<div class="settings2-modal-header"><div><span>SENSOR CALIBRATION</span><h3>Pause alerts while calibrating?</h3>
          <p>All dashboards will show readings as uncalibrated and no risk or "no data" alarms will be sent. It switches itself off after the time you choose, so alarms can never stay silent by accident.</p></div>
          <button type="button" data-close aria-label="Close">${ic('x', 18)}</button></div>
          <div class="settings2-modal-body"><label class="aq-field">Pause alerts for<select id="calib-hours"><option value="0.5">30 minutes</option><option value="1">1 hour</option><option value="2" selected>2 hours</option><option value="4">4 hours</option><option value="8">8 hours</option></select></label>
            <label class="aq-field">Note for the team (optional)<input id="calib-note" maxlength="300" placeholder="e.g. 2-point calibration of the DO probe"></label></div>
          <div class="settings2-modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button type="button" class="danger" id="calib-go">Turn on calibration mode</button></div>`,
        onMount: (m, close) => m.querySelector('#calib-go').addEventListener('click', () => { const note = m.querySelector('#calib-note').value.trim() || null; const hours = Number(m.querySelector('#calib-hours').value); close(); go(note, hours); }),
      });
    });
    page.querySelector('#dev-offline')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
      try { await post('/api/dev/mock-edge', { offline: !dev.offline }); toast(dev.offline ? 'Simulated edge is back online.' : 'Simulated edge is now offline.', 'success'); await load(); ctx.refreshLive(); } catch (err) { toast(err.message, 'error'); }
    }));
    page.querySelector('#dev-tick')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
      try { await post('/api/dev/mock-edge', { tick: true }); toast('Cycle pushed.', 'success'); await load(); ctx.refreshLive(); } catch (err) { toast(err.message, 'error'); }
    }));
  }

  const KIND = { RISK: 'Risk', STALE: 'No data', RECOVERY: 'Data back', ESCALATION: 'Escalation', TEST: 'Test' };

  /** Raspberry Pi link: green when the Pi checked in within 2 minutes. */
  function edgeRow(e, row) {
    if (!e) return '';
    if (!e.key_configured) return row(false, 'Raspberry Pi connection', 'EDGE_API_KEY is not set in Vercel (at least 32 characters). The Pi cannot send readings until it is.');
    const minsAgo = (iso) => (iso ? Math.round((Date.now() - new Date(iso)) / 60000) : null);
    const contact = minsAgo(e.last_contact_at);
    const st = e.status || {};
    const parts = [contact === null ? 'The Pi has not checked in yet.' : `Last check-in ${contact} min ago.`];
    if (e.latest_reading_utc) parts.push(`Newest reading ${fmtDateTime(e.latest_reading_utc)}.`);
    if (st.outbox_backlog > 0) parts.push(`${st.outbox_backlog} reading(s) still waiting on the Pi's SD card (uploading).`);
    if (st.edge_version) parts.push(`Pi program ${st.edge_version}${st.hostname ? ` on ${st.hostname}` : ''}.`);
    if (Number.isFinite(st.clock_skew_s) && Math.abs(st.clock_skew_s) > 60) parts.push(`Pi clock is ${Math.abs(st.clock_skew_s)} s ${st.clock_skew_s > 0 ? 'ahead' : 'behind'}: check its internet time / RTC.`);
    if (st.last_rejected) parts.push(`Last refused reading: ${st.last_rejected}`);
    return row(contact !== null && contact <= 2, 'Raspberry Pi connection', parts.join(' '));
  }

  /** Every link of the phone-alert chain, green or red, so a broken one is obvious. */
  function diagnosticsHtml(g) {
    if (!g) return html`<section class="dashboard-panel settings2-storage-panel"><div class="settings2-section-header">${ic('activity', 18)}<div><span class="settings2-eyebrow">PHONE ALERTS</span><h3>Phone Alert Diagnostics</h3><p>Could not load diagnostics. Make sure the latest update is deployed.</p></div></div></section>`;
    const mins = g.background_check ? Math.round((Date.now() - new Date(g.background_check.at)) / 60000) : null;
    const beatOk = mins !== null && mins <= 11;
    const row = (ok, title, text) => raw(html`<li class="${ok === true ? 'ok' : ok === false ? 'bad' : 'info'}"><span class="aq-diag-mark">${ok === true ? '✓' : ok === false ? '!' : 'i'}</span><div><strong>${title}</strong><p>${text}</p></div></li>`);
    const service = (h) => (/fcm|google/.test(h) ? 'Android / Chrome' : /apple/.test(h) ? 'iPhone / Safari' : /mozilla/.test(h) ? 'Firefox' : /windows|notify\.windows/.test(h) ? 'Windows / Edge' : h);
    const device = (ua) => (/iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'Device');
    return html`<section class="dashboard-panel settings2-storage-panel" id="push-diagnostics">
      <div class="settings2-section-header">${ic('activity', 18)}<div><span class="settings2-eyebrow">PHONE ALERTS</span><h3>Phone Alert Diagnostics</h3>
        <p>Every link from a new reading to a phone notification. A red item is where alerts stop.</p></div></div>
      <ul class="aq-diag">
        ${row(g.vapid_configured, 'Server push keys', g.vapid_configured ? 'VAPID keys are set on the server.' : `Phones cannot receive alerts: ${g.vapid_error || 'VAPID keys are missing in Vercel.'} Check VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT (mailto:your@email) in Vercel.`)}
        ${row(g.hook_secret_configured, 'Hook secret', g.hook_secret_configured ? 'PUSH_HOOK_SECRET is set.' : 'PUSH_HOOK_SECRET is missing in Vercel; the Supabase webhook and 5-minute job are refused.')}
        ${row(beatOk, 'Background check (Supabase, every 5 min)', mins === null ? 'Never received. Run 005_stale_data_check.sql with the same secret as PUSH_HOOK_SECRET; with the simulator on, nothing is generated while all apps are closed until this works.' : `Last run ${mins} min ago${g.background_check.simulator ? ` · simulator ${g.background_check.simulator}` : ''} · ${g.background_check.result}.${beatOk ? '' : ' Expected every 5 minutes: check the 005 job and its responses (403 = wrong secret).'}`)}
        ${row(null, 'Data source', g.simulator_enabled ? 'Simulator is ON: readings come from the background check every 5 minutes (and from open dashboards).' : 'Simulator is OFF: readings come from the Raspberry Pi; the Supabase webhook sends alerts the moment a reading is stored.')}
        ${g.simulator_enabled ? '' : edgeRow(g.edge, row)}
        ${row(g.subscriptions.length > 0, 'Registered devices', g.subscriptions.length ? `${g.subscriptions.length} device(s) will receive alerts.` : 'No device has turned on alerts. On each phone: bell → Enable notifications.')}
        ${coverageRow(g, row)}
      </ul>
      ${g.coverage?.length ? raw(html`<details class="aq-diag-more" ${g.coverage.length <= 8 ? 'open' : ''}><summary>Who gets alerts (${g.coverage.length} active users)</summary><div class="aq-diag-table"><table><thead><tr><th>User</th><th>App devices</th><th>Phone last confirmed an alert</th><th>Status</th></tr></thead><tbody>
        ${[...g.coverage].sort((x, y) => Number(x.reachable) - Number(y.reachable)).map((p) => raw(html`<tr><td>${p.name}${p.role === 'ADMIN' ? raw(' <em>(Admin)</em>') : ''}</td>
          <td>${p.devices ? `${p.devices}${p.devices_with_errors ? ` (${p.devices_with_errors} with a problem)` : ''}` : 'None'}</td>
          <td>${p.last_confirmed_at ? fmtDateTime(p.last_confirmed_at) : 'Not yet'}</td>
          <td class="${p.reachable ? '' : 'bad'}">${p.reachable ? (p.devices_with_errors === p.devices ? 'Device has a problem' : 'Gets alerts') : 'Will NOT get alerts'}</td></tr>`))}
      </tbody></table></div></details>`) : ''}
      ${g.alerts?.length ? raw(html`<h4 class="aq-diag-sub">Last alerts and what reached people</h4><ul class="aq-diag-alerts">
        ${g.alerts.map((a) => raw(html`<li><span class="aq-diag-kind ${a.level.toLowerCase()}">${KIND[a.kind] || a.kind}</span><div><strong>${a.title}</strong>
          <p>${fmtDateTime(a.created_at)} · ${a.push_sent} sent, ${a.push_confirmed} confirmed by the phone${a.push_failed ? `, ${a.push_failed} failed` : ''}</p></div></li>`))}
      </ul>`) : ''}
      ${g.subscriptions.length ? raw(html`<h4 class="aq-diag-sub">Registered app devices</h4><div class="aq-diag-table"><table><thead><tr><th>User</th><th>Device</th><th>Last delivered</th><th>Last problem</th></tr></thead><tbody>
        ${g.subscriptions.map((x) => raw(html`<tr><td>${x.user_name}${x.user_status !== 'ACTIVE' ? raw(' <em>(not active)</em>') : ''}</td><td>${device(x.user_agent || '')} · ${service(x.push_service)}</td>
          <td>${x.last_success_at ? fmtDateTime(x.last_success_at) : 'Never yet'}</td><td class="${x.last_error ? 'bad' : ''}">${x.last_error || '—'}</td></tr>`))}
      </tbody></table></div>`) : ''}
      ${!g.alerts?.length && g.recent_pushes.length ? raw(html`<p class="aq-diag-recent"><b>Recent sends:</b> ${g.recent_pushes.slice(0, 5).map((r) => `${fmtDateTime(r.created_at)} ${r.action === 'ALERT_TEST_BROADCAST' ? 'test' : r.action === 'PUSH_STALE_SENT' ? 'no-data' : (r.details?.state || 'risk')} → ${r.details?.sent ?? 'not recorded'}${r.details?.sent !== undefined ? ' sent' : ''}${r.details?.failed ? `, ${r.details.failed} failed` : ''}`).join(' · ')}</p>`) : ''}
    </section>`;
  }

  function coverageRow(g, row) {
    if (!g.coverage?.length) return '';
    const missing = g.coverage.filter((p) => !p.reachable);
    return row(!missing.length, 'Everyone reachable', missing.length
      ? `${missing.slice(0, 6).map((p) => p.name).join(', ')}${missing.length > 6 ? ` and ${missing.length - 6} more` : ''} will NOT get alerts: no phone or computer has notifications on. Ask them to open AquaCast → bell → turn on notifications (iPhone: from the Home Screen app).`
      : `All ${g.coverage.length} active user(s) have at least one device with notifications on.`);
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
