// App shell: authentication screens, navigation, freshness banners, polling.
import { get, post, onAuthProblem } from './api.js';
import { toast, setTimezone, formData, esc } from './ui.js';
import { pages } from './pages.js';

const state = { profile: null, current: null, cleanup: null, pollTimer: null };
const $ = (s) => document.querySelector(s);
const ADMIN_PAGES = new Set(['evaluation', 'users', 'settings']);

// ---------- auth screens ----------
function showAuth(view = 'login', message = '', kind = '') {
  stopPolling();
  state.profile = null;
  $('#shell').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  for (const id of ['login', 'request', 'forgot']) $(`#${id}-form`).classList.toggle('hidden', id !== view);
  const msg = $('#auth-msg');
  msg.className = `notice ${kind}`;
  msg.textContent = message;
  msg.classList.toggle('hidden', !message);
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-auth-view]');
  if (a) { e.preventDefault(); showAuth(a.dataset.authView); }
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter; btn.disabled = true;
  try {
    const r = await post('/api/auth/login', {
      email: $('#login-email').value, password: $('#login-password').value, remember: $('#login-remember').checked,
    }, { silentAuth: true });
    $('#login-password').value = '';
    enterApp(r.data.profile);
  } catch (err) {
    showAuth('login', err.message, 'error');
  } finally { btn.disabled = false; }
});

$('#request-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter; btn.disabled = true;
  try {
    const r = await post('/api/auth/request-access', formData(e.target), { silentAuth: true });
    e.target.reset();
    showAuth('login', r.data.message || 'Request submitted. Verify your email, then wait for approval.', 'ok');
  } catch (err) {
    showAuth('request', err.message, 'error');
  } finally { btn.disabled = false; }
});

$('#forgot-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await post('/api/auth/forgot-password', formData(e.target), { silentAuth: true });
    showAuth('login', r.data.message, 'ok');
  } catch (err) { showAuth('forgot', err.message, 'error'); }
});

$('#logout-btn').addEventListener('click', async () => {
  try { await post('/api/auth/logout', {}, { silentAuth: true }); } catch { /* clear locally anyway */ }
  showAuth('login', 'You have been signed out.', 'ok');
});

// Session expired / suspended while using the app -> back to sign-in with the reason
onAuthProblem((err) => {
  const reasons = {
    SESSION_EXPIRED: 'Your session expired. Please sign in again.',
    SESSION_MISSING: 'Please sign in.',
  };
  showAuth('login', reasons[err.code] || err.message, 'error');
});

// ---------- app shell ----------
function enterApp(profile) {
  state.profile = profile;
  $('#auth').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  document.querySelector('[data-bind=whoName]').textContent = profile.full_name || profile.email;
  document.querySelector('[data-bind=whoRole]').textContent = profile.role === 'ADMIN' ? 'Administrator' : 'BFAR Staff';
  document.querySelectorAll('.admin-only').forEach((el) => el.classList.toggle('hidden', profile.role !== 'ADMIN'));
  route();
  startPolling();
}

function route() {
  if (!state.profile) return;
  let name = (location.hash || '#live').slice(1);
  if (!pages[name] || (ADMIN_PAGES.has(name) && state.profile.role !== 'ADMIN')) name = 'live';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
  if (state.cleanup) { state.cleanup(); state.cleanup = null; }
  state.current = name;
  const root = $('#page');
  root.innerHTML = '<div class="loading">Loading...</div>';
  Promise.resolve(pages[name](root, { profile: state.profile, setBanner, onCleanup: (fn) => { state.cleanup = fn; } }))
    .catch((err) => { root.innerHTML = `<div class="error-box">${esc(err.message)}</div>`; });
}
window.addEventListener('hashchange', route);

// ---------- freshness banner + badges (refreshed every 60 s) ----------
function setBanner(freshness) {
  const box = $('#banners');
  const parts = [];
  if (!navigator.onLine) parts.push('<div class="banner-BROWSER_OFFLINE">Your device is offline. Showing the last loaded data.</div>');
  if (freshness && freshness.state !== 'LIVE') {
    parts.push(`<div class="banner-${esc(freshness.state)}"><strong>${esc(freshness.state.replace('_', ' '))}</strong> - ${esc(freshness.message)}</div>`);
  }
  box.innerHTML = parts.join('');
}

async function refreshGlobal() {
  try {
    const live = await get('/api/live');
    setBanner(live.meta.freshness);
    setTimezone(live.data.station?.timezone);
    const ac = live.data.active_alerts;
    const badge = document.querySelector('[data-bind=alertCount]');
    badge.textContent = ac; badge.classList.toggle('hidden', !ac);
    if (state.profile?.role === 'ADMIN') {
      const u = await get('/api/users?status=PENDING');
      const pb = document.querySelector('[data-bind=pendingCount]');
      pb.textContent = u.meta.counts.PENDING; pb.classList.toggle('hidden', !u.meta.counts.PENDING);
    }
  } catch (err) {
    if (['SUPABASE_UNAVAILABLE', 'BACKEND_UNREACHABLE', 'BROWSER_OFFLINE'].includes(err.code)) {
      $('#banners').innerHTML = `<div class="banner-OFFLINE"><strong>${esc(err.code.replaceAll('_', ' '))}</strong> - ${esc(err.message)}</div>`;
    }
  }
}
function startPolling() { stopPolling(); refreshGlobal(); state.pollTimer = setInterval(refreshGlobal, 60_000); }
function stopPolling() { if (state.pollTimer) clearInterval(state.pollTimer); state.pollTimer = null; }
window.addEventListener('online', refreshGlobal);
window.addEventListener('offline', () => setBanner(null));

// ---------- boot: restore a remembered session ----------
(async function boot() {
  if (new URLSearchParams(location.search).get('verified')) toast('Email verified. An Administrator must still approve your access.');
  try {
    const r = await get('/api/auth/session', { silentAuth: true });
    enterApp(r.data.profile);
  } catch (err) {
    showAuth('login', err.code === 'SESSION_MISSING' ? '' : err.message, err.code === 'SESSION_MISSING' ? '' : 'error');
  }
})();
