// Risk alerts on this device + "install as an app" support.
//
// While the dashboard is open (in a tab or as the installed home-screen app) it polls /api/live.
// When the official risk state rises to WARNING or CRITICAL this module:
//   - shows an in-dashboard alert (CRITICAL uses the full-screen takeover from app.js),
//   - plays an alert tone (if sound is on) and vibrates (Android),
//   - shows a phone/desktop notification when the dashboard is in the background
//     (needs permission; on iPhone only for the app added to the Home Screen, iOS 16.4+),
//   - keeps a badge on the app icon and a marker in the tab title until DO recovers.
// CRITICAL repeats a reminder every 30 minutes while it lasts. Nothing is sent when the app is closed.
import { html, raw, ic, fmtNum, fmtTime, openModal, toast } from './ui.js';

const KEY = 'aq-alert-state';
const SOUND_KEY = 'aq-alert-sound';
const LEVEL = { WARNING: 1, CRITICAL: 2 };
const REMIND_MS = 30 * 60_000;
const STALE_MS = 60 * 60_000; // never sound an alarm for data older than this
const BASE_TITLE = 'AquaCast System';

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// ---------------- sound ----------------
let audioCtx = null;
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* no audio */ }
}
['pointerdown', 'keydown', 'touchstart'].forEach((ev) => window.addEventListener(ev, unlockAudio, { passive: true }));

export const soundEnabled = () => store.get(SOUND_KEY, true);
function playTone(level) {
  if (!soundEnabled() || !audioCtx || audioCtx.state !== 'running') return;
  const seq = level === 2 ? [880, 660, 880, 660, 880, 660] : [740, 990];
  const t0 = audioCtx.currentTime + 0.02;
  seq.forEach((f, i) => {
    const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
    o.type = 'square'; o.frequency.value = f;
    const start = t0 + i * 0.28;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, start + 0.24);
    o.connect(g).connect(audioCtx.destination);
    o.start(start); o.stop(start + 0.26);
  });
}

// ---------------- notifications ----------------
export const notifySupported = () => 'Notification' in window && 'serviceWorker' in navigator;
async function systemNotify(title, body, level) {
  if (!notifySupported() || Notification.permission !== 'granted') return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(title, {
      body, tag: 'aquacast-risk', renotify: true, requireInteraction: level === 2,
      icon: '/img/icons/icon-192.png', badge: '/img/icons/icon-192.png',
      vibrate: level === 2 ? [400, 150, 400, 150, 400] : [300, 150, 300], data: { url: '/#live' },
    });
    return true;
  } catch { return false; }
}

// ---------------- persistent indicators ----------------
function setIndicators(level) {
  document.title = level === 2 ? '(!) CRITICAL DO · AquaCast' : level === 1 ? '(!) DO Warning · AquaCast' : BASE_TITLE;
  try { if (level) navigator.setAppBadge?.(1); else navigator.clearAppBadge?.(); } catch { /* unsupported */ }
}
export function clearIndicators() { setIndicators(0); document.querySelector('.aq-risk-alert')?.remove(); }

// ---------------- in-dashboard warning banner ----------------
function showWarningBanner({ doText, timeText, navigate }) {
  document.querySelector('.aq-risk-alert')?.remove();
  const el = document.createElement('div');
  el.className = 'aq-risk-alert warning';
  el.setAttribute('role', 'alert');
  el.innerHTML = html`<div class="aq-risk-alert-icon">${ic('triangle-alert', 22)}</div>
    <div class="aq-risk-alert-copy"><span>WARNING • New reading ${timeText}</span>
      <strong>Dissolved oxygen is ${doText}, below the normal boundary.</strong>
      <p>Check the pond and the forecast. Consider manual aeration if DO keeps falling.</p></div>
    <div class="aq-risk-alert-actions">
      <button type="button" class="primary" data-a="aeration">${ic('fan', 15)}Aeration control</button>
      <button type="button" data-a="forecast">View forecast</button>
      <button type="button" class="close" data-a="close" aria-label="Dismiss alert">${ic('x', 16)}</button></div>`;
  el.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    el.remove();
    if (a === 'aeration') navigate('live', { focus: 'aeration' });
    if (a === 'forecast') navigate('forecast');
  });
  document.body.append(el);
}

// ---------------- the check, called after every /api/live refresh ----------------
/**
 * @param live   state.live from app.js
 * @param opts   { navigate, showCritical }  showCritical() opens the full-screen critical dialog
 */
export function checkRisk(live, { navigate, showCritical }) {
  const state = live?.risk?.current_risk_state;
  const level = LEVEL[state] || 0;
  const prev = store.get(KEY, { level: 0, at: 0 });
  setIndicators(level);
  if (!level) {
    if (prev.level) store.set(KEY, { level: 0, at: Date.now() });
    document.querySelector('.aq-risk-alert')?.remove();
    return;
  }
  const now = Date.now();
  if (level < prev.level) { store.set(KEY, { level, at: now }); return; } // improved: remember, no alarm
  const escalated = level > prev.level;
  const remind = level === 2 && now - prev.at > REMIND_MS;
  if (!escalated && !remind) return;
  store.set(KEY, { level, at: now, riskId: live.risk.risk_id });

  const obsAt = live.observation?.timestamp_utc;
  const fresh = obsAt && now - new Date(obsAt).getTime() < STALE_MS;
  const doR = live.observation?.readings?.do_mg_l;
  const doText = doR?.usable ? `${fmtNum(doR.value)} mg/L` : 'unavailable';
  const timeText = obsAt ? fmtTime(obsAt) : '';

  if (level === 2) showCritical();
  else showWarningBanner({ doText, timeText, navigate });
  if (!fresh) return; // old data: show it, but do not sound an alarm

  playTone(level);
  try { navigator.vibrate?.(level === 2 ? [400, 150, 400, 150, 400] : [300, 150, 300]); } catch { /* unsupported */ }
  if (document.visibilityState !== 'visible') {
    systemNotify(level === 2 ? 'CRITICAL: low dissolved oxygen' : 'Warning: dissolved oxygen dropping',
      `DO ${doText} at ${timeText}. ${level === 2 ? 'Immediate operator review needed.' : 'Below the normal boundary.'}`, level);
  }
}

// ---------------- install as an app ----------------
let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; });
window.addEventListener('appinstalled', () => { installEvent = null; toast('AquaCast was added to this device.', 'success'); });
const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(() => { /* app still works without it */ });
  navigator.serviceWorker.addEventListener?.('message', (e) => {
    if (e.data?.type === 'navigate' && e.data.hash) location.hash = e.data.hash;
  });
}

// ---------------- "Alerts & app" dialog ----------------
export function openAlertSettings() {
  const perm = notifySupported() ? Notification.permission : 'unsupported';
  const permText = { granted: 'Allowed on this device', denied: 'Blocked in this browser’s site settings', default: 'Not enabled yet', unsupported: isIos() && !isStandalone() ? 'Add AquaCast to your Home Screen first (iPhone needs this for notifications)' : 'Not supported by this browser' }[perm];
  const installHtml = isStandalone()
    ? '<p class="aq-settings-ok">AquaCast is installed and running as an app on this device.</p>'
    : isIos()
      ? '<ol class="aq-steps"><li>Open this site in <b>Safari</b>.</li><li>Tap the <b>Share</b> button.</li><li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li></ol>'
      : installEvent
        ? '<button type="button" class="aq-btn primary" data-act="install">Install AquaCast app</button>'
        : '<ol class="aq-steps"><li>Open this site in <b>Chrome</b> (Android) or Chrome/Edge (computer).</li><li>Open the browser menu <b>⋮</b>.</li><li>Choose <b>Add to Home screen</b> or <b>Install app</b>.</li></ol>';
  openModal({
    overlayClass: 'user2-modal-overlay', modalClass: 'user2-modal aq-alert-settings',
    content: html`<div class="user2-modal-header"><div><span>THIS DEVICE</span><h3>Alerts &amp; App</h3>
        <p>How this phone or computer warns you when dissolved oxygen reaches Warning or Critical.</p></div>
        <button type="button" data-close aria-label="Close">${ic('x', 18)}</button></div>
      <div class="aq-settings-body">
        <section><h4>${ic('bell-ring', 16)}Notifications</h4>
          <p>Shows a phone/computer notification when a Warning or Critical reading arrives while AquaCast is open in the background.</p>
          <div class="aq-settings-row"><span>Status: <b>${permText}</b></span>
            ${perm === 'default' ? raw('<button type="button" class="aq-btn primary" data-act="perm">Enable notifications</button>') : ''}</div></section>
        <section><h4>${ic('volume-2', 16)}Alert sound</h4>
          <label class="aq-switch"><input type="checkbox" data-act="sound" ${soundEnabled() ? 'checked' : ''}><span>Play an alert tone (and vibrate on Android)</span></label>
          <button type="button" class="aq-btn" data-act="test">${ic('play', 14)}Test the alert</button></section>
        <section><h4>${ic('smartphone', 16)}Home screen app</h4>${raw(installHtml)}</section>
        <p class="aq-settings-note">Alerts work while AquaCast is open (on screen or in the background). If the app is fully closed or the phone is asleep for a long time, the phone may pause it; you will see the alert as soon as you open it again.</p>
      </div>`,
    onMount: (m, close) => {
      m.querySelector('[data-act=perm]')?.addEventListener('click', async () => {
        unlockAudio();
        const r = await Notification.requestPermission();
        toast(r === 'granted' ? 'Notifications enabled on this device.' : 'Notifications were not allowed.', r === 'granted' ? 'success' : 'error');
        close(); openAlertSettings();
      });
      m.querySelector('[data-act=sound]')?.addEventListener('change', (e) => { store.set(SOUND_KEY, e.target.checked); unlockAudio(); });
      m.querySelector('[data-act=test]')?.addEventListener('click', async () => {
        unlockAudio();
        setTimeout(() => playTone(1), 50);
        try { navigator.vibrate?.([300, 150, 300]); } catch { /* unsupported */ }
        const shown = await systemNotify('AquaCast test alert', 'This is how a Warning or Critical DO alert will appear on this device.', 1);
        toast(shown ? 'Test sent: you should hear a tone and see a notification.' : 'Test tone played. Enable notifications to also get a system notification.', 'success');
      });
      m.querySelector('[data-act=install]')?.addEventListener('click', async () => {
        if (!installEvent) return;
        installEvent.prompt();
        await installEvent.userChoice.catch(() => null);
        installEvent = null; close();
      });
    },
  });
}
