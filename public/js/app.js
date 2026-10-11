// AquaCast dashboard shell: sign-in screens, sidebar + header, routing, global polling,
// operator advisory banner, critical takeover, profile and logout dialogs.
// All data comes from the backend API (see docs/API.md); no Supabase keys in the browser.
import { get, post, onAuthProblem } from './api.js';
import { html, raw, ic, esc, icon, toast, openModal, formData, setTimezone, initials, roleLabel, fmtNum, fmtTime, ago, busy, loadingBox, errorBox } from './ui.js';
import { checkRisk, checkTestAlert, clearIndicators, openAlertSettings, registerServiceWorker, stopCriticalAlarm } from './alerts.js';

const LOGO = '/img/aquacast-logo.webp';
// Installed home-screen app or a phone/tablet: stay signed in by default (persistent cookies,
// renewed on every use). Shared desktop computers keep the opt-in "Remember me".
const KEEP_SIGNED_IN = (() => {
  try { return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true || window.matchMedia('(pointer: coarse)').matches; } catch { return false; }
})();
const root = document.getElementById('root');

const NAV = [
  { section: 'Main Monitoring', items: [
    { id: 'live', label: 'Live Status', icon: 'gauge' },
    { id: 'forecast', label: 'Forecast & Risk', icon: 'trending-up' },
    { id: 'history', label: 'History & Trends', icon: 'rotate-ccw-clock' },
    { id: 'alerts', label: 'Alerts', icon: 'bell', badge: 'alerts' },
    { id: 'activities', label: 'Activity Log', icon: 'list-checks' },
    { id: 'sensors', label: 'Sensors & Device', icon: 'cpu' },
  ] },
  { section: 'Analytics & AI', cls: 'analytics-nav-section', admin: true, items: [
    { id: 'evaluation', label: 'Model Evaluation', icon: 'brain-circuit', iconCls: 'analytics-sidebar-icon', adminBadge: true },
  ] },
  { section: 'Administration', cls: 'administration-nav-section', admin: true, items: [
    { id: 'users', label: 'User Directory', icon: 'users', badge: 'pending' },
    { id: 'settings', label: 'System Settings', icon: 'settings' },
  ] },
];
const ALL_PAGES = NAV.flatMap((s) => s.items.map((i) => ({ ...i, admin: !!s.admin })));
const PAGE_MODULES = {
  live: () => import('./pages/live.js'), forecast: () => import('./pages/forecast.js'), history: () => import('./pages/history.js'),
  alerts: () => import('./pages/alerts.js'), activities: () => import('./pages/activities.js'), sensors: () => import('./pages/sensors.js'),
  evaluation: () => import('./pages/evaluation.js'), users: () => import('./pages/users.js'), settings: () => import('./pages/settings.js'),
};

const state = {
  profile: null, page: null, cleanup: null, poll: null, live: null, liveError: null,
  pendingUsers: 0, sidebarOpen: false,
};

// =====================================================================
// Sign-in screens (auth2 layout from the prototype)
// =====================================================================
function authFrame(inner) {
  return html`<div class="auth2-page">
    <div class="auth2-grid-overlay"></div><div class="auth2-glow auth2-glow-one"></div><div class="auth2-glow auth2-glow-two"></div>
    <div class="auth2-water-line auth2-water-line-one"></div><div class="auth2-water-line auth2-water-line-two"></div>
    <main class="auth2-card">
      <div class="auth2-brand"><img class="auth2-logo" src="${LOGO}" alt="AquaCast logo"><div><h1>AquaCast</h1><p>Early-Warning &amp; Decision-Support System</p></div></div>
      <div class="auth2-view">${raw(inner)}</div>
    </main>
    <footer class="auth2-footer">AquaCast • Early-Warning &amp; Decision-Support System</footer>
  </div>`;
}
const authMessage = (msg) => (msg ? html`<div class="auth2-message ${msg.kind || 'neutral'}">${ic(msg.kind === 'error' ? 'triangle-alert' : msg.kind === 'success' ? 'circle-check' : 'info', 16)}<span>${msg.text}</span></div>` : '');

function showLogin(msg) {
  stopPolling();
  clearIndicators();
  state.profile = null;
  root.innerHTML = authFrame(html`
    <div class="auth2-heading"><span>Authorized Access</span><h2>Sign in to AquaCast</h2><p>Use your authorized account to access the monitoring dashboard.</p></div>
    ${raw(authMessage(msg))}
    <form class="auth2-form" id="login-form" novalidate>
      <div class="auth2-form-group"><label for="login-email">Email Address</label>
        <div class="auth2-input">${ic('mail', 17)}<input id="login-email" name="email" type="email" autocomplete="username" placeholder="name@organization.gov.ph" required></div></div>
      <div class="auth2-form-group"><label for="login-password">Password</label>
        <div class="auth2-input">${ic('lock', 17)}<input id="login-password" name="password" type="password" autocomplete="current-password" placeholder="Enter your password" required>
          <button type="button" class="auth2-password-toggle" aria-label="Show password">${ic('eye', 17)}</button></div></div>
      <div class="auth2-options"><label class="auth2-remember"><input type="checkbox" name="remember" ${KEEP_SIGNED_IN ? 'checked' : ''}><span>${KEEP_SIGNED_IN ? 'Keep me signed in' : 'Remember me'}</span></label>
        <button type="button" class="auth2-text-button" data-auth="forgot">Forgot Password?</button></div>
      <button type="submit" class="auth2-primary-button">${ic('log-in', 17)}Sign In</button>
    </form>
    <div class="auth2-divider"><span>Access Management</span></div>
    <div class="auth2-request-link"><p>Need authorized AquaCast access?</p><button type="button" data-auth="request">Request Access</button></div>
    <div class="auth2-security-note">${ic('shield-check', 16)}<p>Sign-in is verified by Supabase Auth. Access also requires a verified email and an account approved by an AquaCast Administrator.</p></div>`);
  wireAuthLinks();
  const toggle = root.querySelector('.auth2-password-toggle');
  toggle.addEventListener('click', () => {
    const input = root.querySelector('#login-password');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.innerHTML = icon(show ? 'eye-off' : 'eye', 17);
    toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
  root.querySelector('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    if (!f.email || !f.password) { showLogin({ kind: 'error', text: 'Enter your email address and password.' }); return; }
    const btn = e.submitter || e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.innerHTML = `${icon('loader-circle', 17, 'aq-spin')}Signing in…`;
    try {
      const r = await post('/api/auth/login', { email: f.email, password: f.password, remember: !!f.remember }, { silentAuth: true });
      enterApp(r.data.profile);
    } catch (err) {
      showLogin({ kind: 'error', text: err.message });
      root.querySelector('#login-email').value = f.email;
    }
  });
}

function showRequest(msg) {
  root.innerHTML = authFrame(html`
    <button type="button" class="auth2-back-button" data-auth="login">${ic('arrow-left', 16)}Back to Sign In</button>
    <div class="auth2-heading"><span>Access Request</span><h2>Request AquaCast Access</h2><p>Create your sign-in credentials. An Administrator reviews every request before access is granted.</p></div>
    ${raw(authMessage(msg))}
    <form class="auth2-form" id="request-form">
      <div class="auth2-form-group"><label>Full Name</label><input name="full_name" type="text" placeholder="Enter your full name" required maxlength="120"></div>
      <div class="auth2-form-group"><label>Official Email Address</label><input name="email" type="email" placeholder="name@organization.gov.ph" required autocomplete="email"></div>
      <div class="auth2-form-group"><label>Organization / Assignment</label><input name="organization" type="text" placeholder="e.g. BFAR TOS • Looc, Castillejos, Zambales" required></div>
      <div class="auth2-form-group"><label>Position (optional)</label><input name="position" type="text" placeholder="e.g. Station Operator"></div>
      <div class="auth2-form-group"><label>Password</label><input name="password" type="password" minlength="10" placeholder="At least 10 characters" required autocomplete="new-password"></div>
      <div class="auth2-request-status">${ic('user-plus', 18)}<div><strong>Administrator Approval Required</strong><p>Verify your email using the link we send, then wait for an Administrator to approve your account in the User Directory.</p></div></div>
      <button type="submit" class="auth2-primary-button">${ic('user-plus', 17)}Submit Access Request</button>
    </form>`);
  wireAuthLinks();
  root.querySelector('#request-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter;
    btn.disabled = true;
    try {
      const r = await post('/api/auth/request-access', formData(e.target), { silentAuth: true });
      showLogin({ kind: 'success', text: r.data.message || 'Request submitted. Verify your email, then wait for Administrator approval.' });
    } catch (err) { showRequest({ kind: 'error', text: err.message }); }
  });
}

function showForgot(msg) {
  root.innerHTML = authFrame(html`
    <button type="button" class="auth2-back-button" data-auth="login">${ic('arrow-left', 16)}Back to Sign In</button>
    <div class="auth2-heading"><span>Account Recovery</span><h2>Reset your password</h2><p>Enter your account email. If it is registered, Supabase sends a reset link.</p></div>
    ${raw(authMessage(msg))}
    <form class="auth2-form" id="forgot-form">
      <div class="auth2-form-group"><label>Email Address</label><div class="auth2-input">${ic('mail', 17)}<input name="email" type="email" placeholder="name@organization.gov.ph" required></div></div>
      <button type="submit" class="auth2-primary-button">${ic('send', 17)}Send Reset Link</button>
    </form>`);
  wireAuthLinks();
  root.querySelector('#forgot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    e.submitter.disabled = true;
    try {
      const r = await post('/api/auth/forgot-password', formData(e.target), { silentAuth: true });
      showLogin({ kind: 'success', text: r.data.message });
    } catch (err) { showForgot({ kind: 'error', text: err.message }); }
  });
}

function wireAuthLinks() {
  root.querySelectorAll('[data-auth]').forEach((b) => b.addEventListener('click', () => {
    ({ login: showLogin, request: showRequest, forgot: showForgot })[b.dataset.auth]();
  }));
}

// =====================================================================
// Dashboard shell
// =====================================================================
function enterApp(profile) {
  state.profile = profile;
  const isAdmin = profile.role === 'ADMIN';
  root.innerHTML = html`<div class="dashboard-shell">
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-brand">
        <div class="brand-logo custom-aquacast-logo"><img src="${LOGO}" alt="AquaCast logo"></div>
        <div class="sidebar-brand-copy"><h1>AquaCast</h1><p>Early-Warning &amp;<br>Decision-Support System</p></div>
        <button type="button" class="sidebar-mobile-close" aria-label="Close navigation menu">${ic('x', 18)}</button>
      </div>
      <nav class="sidebar-navigation" aria-label="Main navigation">
        ${NAV.filter((s) => !s.admin || isAdmin).map((s) => raw(html`<div class="sidebar-nav-section ${s.cls || ''}">
          <p class="sidebar-section-title">${s.section}</p>
          <div class="sidebar-menu">${s.items.map((i) => raw(html`<button type="button" class="sidebar-item" data-nav="${i.id}">
            ${ic(i.icon, 19, i.iconCls || '')}<span>${i.label}</span>
            ${i.adminBadge ? raw('<span class="sidebar-admin-badge">ADMIN</span>') : ''}
            ${i.badge === 'alerts' ? raw('<span class="alert-badge aq-hidden" data-badge="alerts"></span>') : ''}
            ${i.badge === 'pending' ? raw('<span class="pending-user-badge aq-hidden" data-badge="pending"></span>') : ''}
          </button>`))}</div></div>`))}
      </nav>
      <div class="sidebar-account-area">
        <button type="button" class="sidebar-profile-button" data-open="profile">
          <div class="sidebar-user-avatar">${initials(profile.full_name || profile.email)}</div>
          <div class="sidebar-user-info"><strong>${profile.full_name || profile.email}</strong><span>${roleLabel(profile.role)}</span></div>
          ${ic('shield-check', 16, 'sidebar-session-icon')}
        </button>
        <button type="button" class="sidebar-logout-button" data-open="logout" aria-label="Log out" title="Log out">${ic('log-out', 18)}</button>
      </div>
    </aside>
    <div id="sidebar-backdrop"></div>
    <main class="dashboard-main">
      <header class="dashboard-header"><div class="dashboard-header-inner">
        <div class="dashboard-header-left">
          <button type="button" class="dashboard-menu-button" aria-label="Open navigation menu">${ic('menu', 20)}</button>
          <div><p class="dashboard-eyebrow">AquaCast Monitoring System</p><h2 id="page-title">Live Status</h2></div>
        </div>
        <div class="aq-header-right">
          <button type="button" class="aq-header-alerts" data-open="alerts" aria-label="Alerts and app settings for this device" title="Alerts &amp; app settings">${ic('bell-ring', 18)}<span>Alerts</span></button>
          <div class="system-status" id="system-status"><span class="status-dot"></span>${roleLabel(profile.role)}</div>
        </div>
      </div></header>
      <section class="dashboard-content"><div class="dashboard-content-inner">
        <div id="freshness"></div>
        <div id="advisory"></div>
        <div id="page"></div>
      </div></section>
    </main>
  </div>`;

  root.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => { navigate(b.dataset.nav); setSidebar(false); }));
  root.querySelector('.dashboard-menu-button').addEventListener('click', () => setSidebar(true));
  root.querySelector('.sidebar-mobile-close').addEventListener('click', () => setSidebar(false));
  root.querySelector('[data-open=profile]').addEventListener('click', openProfile);
  root.querySelector('[data-open=logout]').addEventListener('click', openLogout);
  root.querySelector('[data-open=alerts]').addEventListener('click', openAlertSettings);
  route();
  startPolling();
}

function setSidebar(open) {
  state.sidebarOpen = open;
  document.getElementById('sidebar')?.classList.toggle('sidebar-mobile-open', open);
  const holder = document.getElementById('sidebar-backdrop');
  if (!holder) return;
  holder.innerHTML = open ? '<button type="button" class="dashboard-sidebar-backdrop" aria-label="Close navigation menu"></button>' : '';
  holder.firstElementChild?.addEventListener('click', () => setSidebar(false));
}

export function navigate(page, opts = {}) {
  if (location.hash.slice(1) === page) route(opts);
  else { state.pendingNavOpts = opts; location.hash = page; }
}

async function route(opts) {
  if (!state.profile) return;
  const navOpts = opts || state.pendingNavOpts || {};
  state.pendingNavOpts = null;
  let id = location.hash.slice(1) || 'live';
  const meta = ALL_PAGES.find((p) => p.id === id);
  if (!meta || (meta.admin && state.profile.role !== 'ADMIN')) id = 'live';
  const page = ALL_PAGES.find((p) => p.id === id);
  root.querySelectorAll('[data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === id));
  document.getElementById('page-title').textContent = page.label;
  document.title = `${page.label} · AquaCast System`;
  if (state.cleanup) { try { state.cleanup(); } catch { /* ignore */ } state.cleanup = null; }
  state.page = id;
  const host = document.getElementById('page');
  host.innerHTML = loadingBox();
  window.scrollTo(0, 0);
  try {
    const mod = await PAGE_MODULES[id]();
    if (state.page !== id) return;
    const cleanup = await mod.default(host, ctx(navOpts));
    if (state.page === id) state.cleanup = typeof cleanup === 'function' ? cleanup : null;
  } catch (err) {
    if (!['SESSION_EXPIRED', 'SESSION_MISSING'].includes(err.code)) host.innerHTML = errorBox(err);
  }
}
window.addEventListener('hashchange', () => route());

function ctx(opts) {
  return {
    profile: state.profile,
    isAdmin: state.profile.role === 'ADMIN',
    opts,
    live: () => state.live,
    refreshLive,
    navigate,
    station: () => state.live?.station?.site_description || 'AquaCast station',
  };
}

// =====================================================================
// Global polling: freshness banner, advisory, badges, critical takeover
// =====================================================================
const FRESH_TITLE = { SYNC_DELAYED: 'Sync delayed', OFFLINE: 'Edge device offline', NO_DATA: 'No data yet' };
function renderFreshness(fresh, err) {
  const el = document.getElementById('freshness');
  if (!el) return;
  let code = null; let title = ''; let text = '';
  if (!navigator.onLine) { code = 'browser_offline'; title = 'You are offline'; text = 'Showing the last loaded data. It will refresh when your connection returns.'; }
  else if (err && ['SUPABASE_UNAVAILABLE', 'BACKEND_UNREACHABLE', 'SUPABASE_REQUEST_FAILED'].includes(err.code)) {
    code = err.code.toLowerCase(); title = err.code === 'BACKEND_UNREACHABLE' ? 'Server unreachable' : 'Database unreachable'; text = `${err.message} Retrying every minute.`;
  } else if (fresh && fresh.state !== 'LIVE') { code = fresh.state.toLowerCase(); title = FRESH_TITLE[fresh.state] || fresh.state; text = fresh.message; }
  el.innerHTML = code ? html`<div class="aq-freshness ${code}" role="status">${ic(code === 'sync_delayed' ? 'clock-3' : code === 'browser_offline' ? 'wifi-off' : 'triangle-alert', 18)}<div><strong>${title}</strong>${text}</div></div>` : '';
  const dot = document.querySelector('#system-status .status-dot');
  if (dot) dot.style.background = code ? (code === 'sync_delayed' ? '#f59e0b' : '#e11d48') : '';
}

function renderAdvisory() {
  const el = document.getElementById('advisory');
  if (!el) return;
  const risk = state.live?.risk?.current_risk_state;
  if (!['WARNING', 'CRITICAL'].includes(risk) || state.page === 'live') { el.innerHTML = ''; return; }
  const crit = risk === 'CRITICAL';
  el.innerHTML = html`<aside class="dashboard-aeration-advisory ${crit ? 'critical' : 'warning'}">
    <div class="dashboard-aeration-advisory-icon">${ic('triangle-alert', 20)}</div>
    <div class="dashboard-aeration-advisory-copy"><span class="dashboard-aeration-advisory-kicker">${risk} • Operator attention</span>
      <strong>${crit ? 'Critical low dissolved oxygen condition.' : 'Dissolved oxygen deterioration detected.'}</strong>
      <p>Review pond conditions and consider manual aeration if appropriate.</p></div>
    <button type="button" class="dashboard-aeration-advisory-action">${ic('fan', 16)}Open Aeration Control</button>
  </aside>`;
  el.querySelector('button').addEventListener('click', () => navigate('live', { focus: 'aeration' }));
}

/** Full-screen critical dialog. Called by alerts.js when DO enters CRITICAL (and every 30 min while it lasts),
 *  or with `test` for an admin test broadcast. Touching the dialog stops the repeating alarm. */
function showCriticalTakeover(test = null) {
  const r = state.live?.risk;
  if (!test && (!r || r.current_risk_state !== 'CRITICAL')) return;
  if (document.querySelector('.critical-takeover-overlay')) return;
  const doR = state.live?.observation?.readings?.do_mg_l;
  const head = test
    ? html`<div class="critical-takeover-icon">${ic('triangle-alert', 30)}</div>
      <span class="critical-takeover-eyebrow">TEST ALERT • Critical</span>
      <h2>This is a test of the Critical alert</h2>
      <p class="critical-takeover-description">Sent by ${test.sentBy} at ${test.time} to check this device's alert screen, urgent sound and notification. It is not a real reading.</p>
      <div class="critical-takeover-reading"><span>Test only</span><div><strong>TEST</strong></div><p>Real Critical alerts show the measured DO here.</p></div>`
    : html`<div class="critical-takeover-icon">${ic('triangle-alert', 30)}</div>
      <span class="critical-takeover-eyebrow">Critical • Immediate operator review</span>
      <h2>Critical low dissolved oxygen</h2>
      <p class="critical-takeover-description">The latest observation is at or below the critical threshold. Verify the reading and pond conditions, then decide on a management response.</p>
      <div class="critical-takeover-reading"><span>Current DO</span><div><strong>${doR?.usable ? fmtNum(doR.value) : '--'}</strong><small>mg/L</small></div><p>Observed ${fmtTime(state.live.observation?.timestamp_utc)} • ${ago(state.live.observation?.timestamp_utc)}</p></div>`;
  openModal({
    overlayClass: 'critical-takeover-overlay', modalClass: 'critical-takeover-dialog', dismissable: false,
    content: html`${raw(head)}
      <div class="aq-crit-aerator" id="crit-aerator"></div>
      <div class="critical-takeover-actions">
        <button type="button" class="critical-takeover-button secondary" data-go="aeration">${ic('fan', 17)}Aeration panel</button>
        <button type="button" class="critical-takeover-button secondary" data-go="forecast">${ic('trending-down', 17)}Forecast &amp; Risk</button>
      </div>
      <button type="button" class="critical-takeover-button secondary critical-takeover-acknowledge" data-go="dismiss">${test ? 'Stop the test alarm' : 'I have seen this alert'}</button>
      ${test ? '' : raw('<p class="critical-takeover-note">Acknowledge the alert formally on the Alerts page so it is recorded with your name.</p>')}`,
    onMount: (dlg, done) => {
      // any touch on the dialog counts as "someone is responding": stop the repeating alarm
      dlg.addEventListener('pointerdown', stopCriticalAlarm);
      dlg.addEventListener('keydown', stopCriticalAlarm);
      renderCriticalAerator(dlg.querySelector('#crit-aerator'), !!test);
      dlg.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => {
        stopCriticalAlarm();
        done();
        if (b.dataset.go === 'aeration') navigate('live', { focus: 'aeration' });
        if (b.dataset.go === 'forecast') navigate('forecast');
      }));
    },
  });
}

/**
 * Aerator section of the critical dialog. MANUAL mode: "Turn ON aerator" sends an ON request.
 * AUTOMATIC mode: the controller switches the aerator itself; if it still reports OFF, an
 * Administrator can switch to MANUAL and request ON in one tap. The dashboard only REQUESTS;
 * the Raspberry Pi applies it, and its acknowledgement is shown here.
 */
function renderCriticalAerator(box, test) {
  if (!box) return;
  const a = state.live?.aerator;
  const isAdmin = state.profile?.role === 'ADMIN';
  const set = (cls, inner) => { box.className = `aq-crit-aerator ${cls}`; box.innerHTML = inner; };
  if (!a?.initialized) { set('muted', html`${ic('power', 16)}<p>The aerator controller has not reported in yet, so it cannot be switched from here.</p>`); return; }
  const out = a.controller?.output_state;
  const reported = a.controller?.output_reported_at_utc ? ` (reported ${ago(a.controller.output_reported_at_utc).toLowerCase()})` : '';
  const auto = a.mode?.applied_mode === 'AUTOMATIC';
  const modePending = !a.mode?.acknowledged;
  if (out === 'ON' && !test) { set('ok', html`${ic('circle-check', 16)}<p><strong>Aerator is ON</strong> according to the controller${reported}. Keep checking DO.</p>`); return; }
  if (a.pending_command && a.pending_command.effective_status === 'PENDING' && !test) {
    set('wait', html`${ic('loader-circle', 16, 'aq-spin')}<p>An ${a.pending_command.requested_state} request is waiting for the controller.</p>`);
    watchCommand(box, a.pending_command.command_id); return;
  }
  if (auto && !modePending) {
    set('info', html`<p><strong>Automatic mode:</strong> the controller switches the aerator on by itself at Warning/Critical. It reports the aerator ${out || 'UNKNOWN'}${reported}.</p>
      ${isAdmin ? raw(html`<button type="button" class="aq-crit-aer-btn" data-aer="manual-on">${ic('power', 16)}${test ? '(Test) ' : ''}Switch to manual &amp; turn ON</button>`)
    : raw('<p class="aq-crit-aer-note">Only an Administrator can switch to manual mode.</p>')}`);
  } else if (a.can_request_manual_command || test) {
    set('action', html`<button type="button" class="aq-crit-aer-btn" data-aer="on">${ic('power', 16)}${test ? '(Test) ' : ''}Turn ON aerator</button>
      <p class="aq-crit-aer-note">Sends an ON request to the Raspberry Pi controller. Controller now reports: ${out || 'UNKNOWN'}.</p>`);
  } else {
    set('muted', html`${ic('info', 16)}<p>${a.manual_command_blocked_reason || a.mode?.status_text || 'Manual control is not available right now.'}</p>`);
  }
  box.querySelector('[data-aer]')?.addEventListener('click', (e) => {
    stopCriticalAlarm();
    if (test) { set('info', html`<p><strong>Test only:</strong> no command was sent. In a real Critical alert this button sends an ON request to the controller.</p>`); return; }
    const btn = e.currentTarget;
    busy(btn, async () => {
      try {
        if (btn.dataset.aer === 'manual-on') {
          set('wait', html`${ic('loader-circle', 16, 'aq-spin')}<p>Requesting MANUAL mode. Waiting for the controller to acknowledge…</p>`);
          await post('/api/aerator/mode', { mode: 'MANUAL' });
          const ok = await waitFor(async () => (await get('/api/aerator')).data.can_request_manual_command, 120_000);
          if (!ok) { set('bad', html`${ic('triangle-alert', 16)}<p>The controller did not acknowledge MANUAL mode in time. Use the aeration panel to try again.</p>`); return; }
        }
        const r = await post('/api/aerator/commands', { requested_state: 'ON' }, { headers: { 'Idempotency-Key': crypto.randomUUID() } });
        set('wait', html`${ic('loader-circle', 16, 'aq-spin')}<p>ON request sent. Waiting for the controller to apply it…</p>`);
        watchCommand(box, r.data.command_id);
      } catch (err) { set('bad', html`${ic('triangle-alert', 16)}<p>${err.message}</p>`); }
    });
  });
}
async function waitFor(check, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await check()) return true; } catch { /* keep trying */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}
async function watchCommand(box, id) {
  const done = await waitFor(async () => {
    if (!box.isConnected) return true;
    const c = (await get(`/api/aerator/commands/${id}`)).data;
    if (c.effective_status === 'PENDING') return false;
    const ok = c.effective_status === 'APPLIED';
    box.className = `aq-crit-aerator ${ok ? 'ok' : 'bad'}`;
    box.innerHTML = html`${ic(ok ? 'circle-check' : 'triangle-alert', 16)}<p><strong>${ok ? 'Controller applied ON.' : `Request ${c.effective_status.replace(/_/g, ' ').toLowerCase()}.`}</strong> ${c.status_text}${ok ? ' This is the controller\'s acknowledgement, not proof the motor is running.' : ''}</p>`;
    refreshLive();
    return true;
  }, 180_000);
  if (!done && box.isConnected) { box.className = 'aq-crit-aerator bad'; box.innerHTML = html`${ic('triangle-alert', 16)}<p>No answer from the controller yet. Check the aeration panel.</p>`; }
}

async function refreshLive() {
  try {
    const r = await get('/api/live');
    state.live = { ...r.data, freshness: r.meta.freshness };
    state.liveError = null;
    setTimezone(r.data.station?.timezone);
    renderFreshness(r.meta.freshness, null);
    const ab = document.querySelector('[data-badge=alerts]');
    if (ab) { ab.textContent = r.data.active_alerts; ab.classList.toggle('aq-hidden', !r.data.active_alerts); }
    renderAdvisory();
    checkRisk(state.live, { navigate, showCritical: showCriticalTakeover });
    checkTestAlert(state.live, { navigate, showCritical: showCriticalTakeover });
  } catch (err) {
    state.liveError = err;
    renderFreshness(state.live?.freshness, err);
  }
  if (state.profile?.role === 'ADMIN') {
    try {
      const u = await get('/api/users?status=PENDING');
      state.pendingUsers = u.meta.counts.PENDING;
      const pb = document.querySelector('[data-badge=pending]');
      if (pb) { pb.textContent = state.pendingUsers; pb.classList.toggle('aq-hidden', !state.pendingUsers); }
    } catch { /* badge only */ }
  }
  return state.live;
}
function startPolling() { stopPolling(); refreshLive(); state.poll = setInterval(refreshLive, 60_000); }
function stopPolling() { if (state.poll) clearInterval(state.poll); state.poll = null; }
window.addEventListener('online', refreshLive);
// phones pause background pages: refresh the moment the dashboard is shown again
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.poll) refreshLive(); });
window.addEventListener('offline', () => renderFreshness(state.live?.freshness, null));
// re-render the advisory when the page changes (it is hidden on Live Status)
window.addEventListener('hashchange', () => setTimeout(renderAdvisory, 0));

// =====================================================================
// Profile + logout dialogs
// =====================================================================
function openProfile() {
  const p = state.profile;
  openModal({
    overlayClass: 'account-modal-overlay', modalClass: 'account-profile-modal',
    content: html`<div class="account-modal-header"><div class="account-modal-heading"><div class="account-modal-avatar">${initials(p.full_name || p.email)}</div>
        <div><h3>User Profile</h3><p>Current authenticated AquaCast session</p></div></div>
        <button type="button" class="account-modal-close" data-close aria-label="Close">${ic('x', 18)}</button></div>
      <div class="account-profile-name"><strong>${p.full_name || p.email}</strong><span class="account-role-badge ${p.role === 'ADMIN' ? 'administrator' : 'operator'}">${roleLabel(p.role)}</span></div>
      <div class="account-profile-details">
        ${[['briefcase-business', 'Position', p.position || 'Not specified'], ['id-card', 'User ID', p.user_id.slice(0, 8).toUpperCase(), true], ['mail', 'Email', p.email, true],
          ['building-complex', 'Organization', p.organization || 'Not specified'], ['badge-check', 'Role', roleLabel(p.role)], ['clock-3', 'Last sign-in', p.last_login_at ? ago(p.last_login_at) : 'This session']]
          .map(([ico, label, val, mono]) => raw(html`<div class="account-profile-row"><div class="account-profile-label">${ic(ico, 15)}<span>${label}</span></div><strong class="${mono ? 'account-mono' : ''}">${val}</strong></div>`))}
      </div>
      <div class="account-profile-note">${ic('shield-check', 16)}<p>Credentials are managed by Supabase Auth. Role and access status are managed by Administrators in the User Directory.</p></div>
      <div class="account-modal-actions"><button type="button" class="account-secondary-button" data-close>Close Profile</button>
        <button type="button" class="account-logout-action" data-logout>${ic('log-out', 16)}Log Out</button></div>`,
    onMount: (m, close) => m.querySelector('[data-logout]').addEventListener('click', () => { close(); openLogout(); }),
  });
}

function openLogout() {
  const p = state.profile;
  openModal({
    overlayClass: 'account-modal-overlay', modalClass: 'logout-confirm-modal',
    content: html`<div class="logout-warning-icon">${ic('triangle-alert', 24)}</div>
      <h3>Log Out of AquaCast?</h3><p>Your session will end on this device. You will return to the AquaCast sign-in screen.</p>
      <div class="logout-session-summary"><div class="logout-mini-avatar">${initials(p.full_name || p.email)}</div><div><strong>${p.full_name || p.email}</strong><span>${roleLabel(p.role)}</span></div></div>
      <div class="logout-confirm-actions"><button type="button" class="account-secondary-button" data-close>Cancel</button>
        <button type="button" class="account-logout-action" data-confirm>${ic('log-out', 16)}Log Out</button></div>`,
    onMount: (m, close) => m.querySelector('[data-confirm]').addEventListener('click', (e) => busy(e.currentTarget, async () => {
      try { await post('/api/auth/logout', {}, { silentAuth: true }); } catch { /* cookies are cleared server-side when reachable */ }
      close();
      if (state.cleanup) state.cleanup();
      history.replaceState(null, '', location.pathname);
      showLogin({ kind: 'success', text: 'You have been signed out.' });
    })),
  });
}

// Session expired or account suspended mid-session -> back to sign-in with the reason
onAuthProblem((err) => {
  if (!state.profile) return;
  document.querySelectorAll('[class$="-overlay"]').forEach((o) => o.remove());
  if (state.cleanup) { try { state.cleanup(); } catch { /* ignore */ } state.cleanup = null; }
  const text = { SESSION_EXPIRED: 'Your session expired. Please sign in again.', SESSION_MISSING: 'Please sign in to continue.' }[err.code] || err.message;
  showLogin({ kind: 'error', text });
});

// =====================================================================
// Boot: restore a remembered session
// =====================================================================
(async function boot() {
  registerServiceWorker();
  const params = new URLSearchParams(location.search);
  try {
    const r = await get('/api/auth/session', { silentAuth: true });
    enterApp(r.data.profile);
  } catch (err) {
    if (params.get('verified')) showLogin({ kind: 'success', text: 'Email verified. An Administrator must approve your account before you can sign in.' });
    else if (err.code === 'SESSION_MISSING') showLogin();
    else showLogin({ kind: 'error', text: err.message });
  }
})();

export { esc };
