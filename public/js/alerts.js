// Risk alerts on this device + "install as an app" support.
//
// While the dashboard is open (in a tab or as the installed home-screen app) it polls /api/live.
// When the official risk state rises to WARNING or CRITICAL this module:
//   - shows an in-dashboard alert (CRITICAL uses the full-screen takeover from app.js),
//   - plays an alert tone (if sound is on) and vibrates (Android),
//   - shows a phone/desktop notification when the dashboard is in the background
//     (needs permission; on iPhone only for the app added to the Home Screen, iOS 16.4+),
//   - keeps a badge on the app icon and a marker in the tab title until DO recovers.
// CRITICAL repeats a reminder every 30 minutes while it lasts, and its alarm sound repeats every
// 20 s while the critical dialog is open. Nothing is sent when the app is closed.
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
/**
 * WARNING  = an "attention" chime: two soft two-note dings (like a doorbell), ~1.6 s.
 * CRITICAL = an urgent alarm: a rising-falling siren under fast high beeps, ~3 s, louder.
 * `force` plays even when the sound switch is off (used by the test buttons).
 */
function playTone(level, force = false) {
  if ((!soundEnabled() && !force) || !audioCtx) return false;
  if (audioCtx.state !== 'running') { try { audioCtx.resume(); } catch { return false; } }
  const ctx = audioCtx;
  const out = ctx.createDynamicsCompressor(); out.connect(ctx.destination);
  const t0 = ctx.currentTime + 0.03;
  const note = (freq, start, dur, { type = 'sine', peak = 0.3 } = {}) => {
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, start);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(peak, start + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g).connect(out); o.start(start); o.stop(start + dur + 0.02);
  };
  if (level === 1) {
    // ding-dong, ding-dong (E5 -> C5), with a soft overtone so it carries on phone speakers
    [[0, 659], [0.32, 523], [0.85, 659], [1.17, 523]].forEach(([dt, f]) => {
      note(f, t0 + dt, 0.55, { type: 'sine', peak: 0.32 });
      note(f * 2, t0 + dt, 0.3, { type: 'sine', peak: 0.06 });
    });
    return true;
  }
  // CRITICAL: siren sweep (square) + rapid beeps on top
  const siren = ctx.createOscillator(); const sg = ctx.createGain();
  siren.type = 'sawtooth';
  for (let k = 0; k < 6; k += 1) {
    siren.frequency.setValueAtTime(620, t0 + k * 0.5);
    siren.frequency.linearRampToValueAtTime(1250, t0 + k * 0.5 + 0.25);
    siren.frequency.linearRampToValueAtTime(620, t0 + k * 0.5 + 0.5);
  }
  sg.gain.setValueAtTime(0.0001, t0);
  sg.gain.exponentialRampToValueAtTime(0.16, t0 + 0.05);
  sg.gain.setValueAtTime(0.16, t0 + 2.9);
  sg.gain.exponentialRampToValueAtTime(0.0001, t0 + 3.05);
  siren.connect(sg).connect(out); siren.start(t0); siren.stop(t0 + 3.1);
  for (let k = 0; k < 12; k += 1) note(1760, t0 + k * 0.25, 0.09, { type: 'square', peak: 0.12 });
  return true;
}

// While the Critical dialog is open the alarm repeats every 20 s (max 10 min) until someone taps it.
let alarmTimer = null;
function startCriticalAlarm(force = false) {
  stopCriticalAlarm();
  let n = 0;
  alarmTimer = setInterval(() => {
    n += 1;
    if (n > 30 || !document.querySelector('.critical-takeover-overlay')) { stopCriticalAlarm(); return; }
    playTone(2, force);
    try { navigator.vibrate?.([400, 150, 400, 150, 400]); } catch { /* unsupported */ }
  }, 20_000);
}
export function stopCriticalAlarm() { if (alarmTimer) clearInterval(alarmTimer); alarmTimer = null; }

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
function showWarningBanner({ doText, timeText, navigate, test = null }) {
  document.querySelector('.aq-risk-alert')?.remove();
  const el = document.createElement('div');
  el.className = 'aq-risk-alert warning';
  el.setAttribute('role', 'alert');
  el.innerHTML = html`<div class="aq-risk-alert-icon">${ic('triangle-alert', 22)}</div>
    <div class="aq-risk-alert-copy">${test
    ? raw(html`<span>TEST ALERT • Warning • sent by ${test.sentBy} at ${test.time}</span>
      <strong>This is a test of the Warning alert.</strong><p>Not a real reading. A real Warning shows the measured DO here.</p>`)
    : raw(html`<span>WARNING • New reading ${timeText}</span>
      <strong>Dissolved oxygen is ${doText}, below the normal boundary.</strong>
      <p>Check the pond and the forecast. Consider manual aeration if DO keeps falling.</p>`)}</div>
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
  if (level === 2) startCriticalAlarm();
  try { navigator.vibrate?.(level === 2 ? [400, 150, 400, 150, 400] : [300, 150, 300]); } catch { /* unsupported */ }
  if (document.visibilityState !== 'visible') {
    systemNotify(level === 2 ? 'CRITICAL: low dissolved oxygen' : 'Warning: dissolved oxygen dropping',
      `DO ${doText} at ${timeText}. ${level === 2 ? 'Immediate operator review needed.' : 'Below the normal boundary.'}`, level);
  }
}

// ---------------- admin "test alert" broadcast ----------------
const SEEN_TESTS = 'aq-test-alerts-seen';
/** Plays a test alert once per broadcast (sent from System Settings) on every signed-in device. */
export function checkTestAlert(live, { navigate, showCritical }) {
  const t = live?.test_alert;
  if (!t?.id) return;
  const seen = store.get(SEEN_TESTS, []);
  if (seen.includes(t.id)) return;
  store.set(SEEN_TESTS, [...seen.slice(-20), t.id]);
  const level = t.level === 'WARNING' ? 1 : 2;
  const test = { sentBy: t.sent_by, time: fmtTime(t.sent_at) };
  if (level === 2) showCritical(test);
  else showWarningBanner({ navigate, test });
  playTone(level, true);
  if (level === 2) startCriticalAlarm(true);
  try { navigator.vibrate?.(level === 2 ? [400, 150, 400, 150, 400] : [300, 150, 300]); } catch { /* unsupported */ }
  systemNotify(level === 2 ? 'TEST: Critical DO alert' : 'TEST: DO Warning alert',
    `Test sent by ${test.sentBy} at ${test.time}. Not a real reading.`, level);
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
          <div class="aq-test-row">
            <button type="button" class="aq-btn aq-test-warning" data-act="test-warning">${ic('play', 14)}Test Warning sound</button>
            <button type="button" class="aq-btn aq-test-critical" data-act="test-critical">${ic('play', 14)}Test Critical sound</button>
          </div>
          <p>Warning plays a two-note chime. Critical plays an urgent siren and repeats every 20 seconds until someone taps the critical alert.</p></section>
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
      const test = (level) => async () => {
        unlockAudio();
        const played = await new Promise((r) => setTimeout(() => r(playTone(level, true)), 60));
        try { navigator.vibrate?.(level === 2 ? [400, 150, 400, 150, 400] : [300, 150, 300]); } catch { /* unsupported */ }
        const shown = await systemNotify(level === 2 ? 'AquaCast test: CRITICAL' : 'AquaCast test: Warning',
          'This is how a DO alert will appear on this device.', level);
        if (!played) toast('Sound could not play. Check that the phone is not on silent and the volume is up.', 'error');
        else toast(shown ? 'Test sent: tone played and a notification was shown.' : 'Test tone played. Enable notifications to also get a system notification.', 'success');
        if (!soundEnabled()) toast('Note: alert sound is switched off for real alerts on this device.', '');
      };
      m.querySelector('[data-act=test-warning]')?.addEventListener('click', test(1));
      m.querySelector('[data-act=test-critical]')?.addEventListener('click', test(2));
      m.querySelector('[data-act=install]')?.addEventListener('click', async () => {
        if (!installEvent) return;
        installEvent.prompt();
        await installEvent.userChoice.catch(() => null);
        installEvent = null; close();
      });
    },
  });
}
