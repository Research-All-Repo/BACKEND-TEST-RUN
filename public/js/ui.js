// Shared DOM, formatting and risk helpers for the AquaCast dashboard.
import { icon } from './icons.js';
import { lang, GUIDANCE_FIL } from './i18n.js';

export { icon };

let tz = 'Asia/Manila';
export function setTimezone(z) { if (z) tz = z; }
export function getTimezone() { return tz; }

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Tagged template: escapes every interpolation unless wrapped in raw(). Arrays are joined. */
export function html(strings, ...values) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += render(values[i]);
  });
  return out;
}
function render(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v && v.__raw) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
}
export const raw = (value) => ({ __raw: true, value: String(value ?? '') });
export const ic = (name, size = 16, cls = '') => raw(icon(name, size, cls));

// ---------------- formatting ----------------
const fmtCache = new Map();
function dtf(opts) {
  const key = tz + JSON.stringify(opts);
  if (!fmtCache.has(key)) fmtCache.set(key, new Intl.DateTimeFormat('en-PH', { timeZone: tz, ...opts }));
  return fmtCache.get(key);
}
export function fmtDateTime(iso) {
  if (!iso) return '--';
  return dtf({ month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}
export function fmtTime(iso, seconds = false) {
  if (!iso) return '--';
  return dtf({ hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hour12: false }).format(new Date(iso));
}
export function fmtDate(iso) {
  if (!iso) return '--';
  return dtf({ month: 'short', day: '2-digit', year: 'numeric' }).format(new Date(iso));
}
export function fmtNum(v, d = 2) {
  if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return '--';
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
export function ago(iso) {
  if (!iso) return 'Never';
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  if (m < 43200) return `${Math.round(m / 1440)}d ago`;
  return fmtDate(iso);
}
export function initials(name) {
  return String(name || '?').replace(/^(Dr|Engr|Mr|Ms|Mrs)\.?\s+/i, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
}
export const roleLabel = (r) => (r === 'ADMIN' ? 'Administrator' : 'BFAR Staff');
export const titleCase = (s) => String(s || '').toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** "2026-10-05T14:30" (datetime-local, station time) -> ISO UTC. Manila has no DST, so +08:00 is fixed. */
export function localInputToIso(v) { return v ? new Date(`${v}:00+08:00`).toISOString() : ''; }
export function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() + 8 * 3600000);
  return d.toISOString().slice(0, 16);
}

// ---------------- risk helpers ----------------
export const RISK_KEY = { NORMAL: 'normal', WATCH: 'watch', WARNING: 'warning', CRITICAL: 'critical', DATA_UNAVAILABLE: 'unknown' };
export const riskKey = (s) => RISK_KEY[s] || 'unknown';
export const riskLabel = (s) => (s === 'DATA_UNAVAILABLE' || !s ? 'DATA UNAVAILABLE' : s);

/** Threshold band for one DO value, using the rule reference (critical/watch boundary). */
export function doBand(value, rule) {
  if (value === null || value === undefined || !rule || rule.critical_do_mg_l === null) return 'unknown';
  if (value <= rule.critical_do_mg_l) return 'critical';
  if (value < rule.watch_boundary_do_mg_l) return 'watch';
  return 'normal';
}

export const GUIDANCE = {
  CRITICAL: { title: 'Immediate operator review', description: 'Verify the current sensor reading and observable pond conditions promptly, then determine the appropriate management response according to authorized pond procedures.',
    steps: ['Confirm the current DO reading and check for sensor or data-quality issues.', 'Inspect current pond conditions and review recent management activities.', 'Determine the appropriate operator response. Manual aeration remains operator-initiated from Live Status.'] },
  WARNING: { title: 'Prepare for operator response', description: 'AquaCast indicates that operator attention is needed before conditions deteriorate further.',
    steps: ['Verify the current DO reading and review the forecast progression.', 'Check the projected timing of any critical threshold crossing and recent pond activities.', 'Select the appropriate management response. If manual aeration is chosen, use the Manual Aeration control on Live Status.'] },
  WATCH: { title: 'Increase observation', description: 'Forecast deterioration is developing, but a critical condition is not yet indicated by the current classification.',
    steps: ['Monitor the next forecast cycles more closely.', 'Review the horizon where DO first enters the suboptimal range.', 'Check recent feeding, aeration, water exchange, maintenance, or other recorded pond activities.'] },
  NORMAL: { title: 'Continue routine monitoring', description: 'No elevated dissolved oxygen concern is indicated by the current observation and forecast window.',
    steps: ['Continue regular monitoring of current DO and forecast updates.', 'Maintain normal pond observation and activity logging.', 'Review any new alerts if the risk state changes in a later cycle.'] },
  DATA_UNAVAILABLE: { title: 'Verify data availability', description: 'AquaCast cannot provide complete decision support until valid current and forecast information is available.',
    steps: ['Check whether the current DO observation is available.', 'Verify that all required forecast horizons were generated successfully.', 'Review sensor and device status if data remain unavailable.'] },
};
export const guidanceFor = (s) => { const G = lang() === 'fil' ? GUIDANCE_FIL : GUIDANCE; return G[s] || G.DATA_UNAVAILABLE; };

// ---------------- feedback ----------------
export function toast(message, kind = '') {
  let host = document.querySelector('.aq-toasts');
  if (!host) { host = document.createElement('div'); host.className = 'aq-toasts'; host.setAttribute('aria-live', 'polite'); document.body.append(host); }
  const el = document.createElement('div');
  el.className = `aq-toast ${kind}`;
  el.innerHTML = icon(kind === 'error' ? 'triangle-alert' : kind === 'success' ? 'circle-check' : 'info', 16) + `<span>${esc(message)}</span>`;
  host.append(el);
  // leave the way it came (down), quickly, then remove
  setTimeout(() => { el.classList.add('leaving'); setTimeout(() => el.remove(), 220); }, kind === 'error' ? 7000 : 4500);
}

const ERROR_TEXT = {
  SUPABASE_UNAVAILABLE: ['Database unreachable', 'Supabase could not be reached. The page will retry automatically.'],
  SUPABASE_REQUEST_FAILED: ['Database request failed', 'Supabase rejected or failed this request. Try again shortly.'],
  BACKEND_UNREACHABLE: ['Server unreachable', 'The AquaCast server could not be reached.'],
  BROWSER_OFFLINE: ['You are offline', 'Your device has no internet connection.'],
  FORBIDDEN: ['Not authorized', 'Your role does not have access to this information.'],
};
export function stateBox(kind, title, text, iconName) {
  const ico = iconName || (kind === 'error' ? 'triangle-alert' : kind === 'loading' ? 'loader-circle' : 'info');
  return `<div class="aq-state ${kind === 'error' ? 'error' : ''}">${icon(ico, 22, kind === 'loading' ? 'aq-spin' : '')}<strong>${esc(title)}</strong>${text ? `<p>${esc(text)}</p>` : ''}</div>`;
}
export function errorBox(err) {
  const [t, d] = ERROR_TEXT[err?.code] || ['Something went wrong', err?.message || 'Unexpected error.'];
  return stateBox('error', t, d);
}
export const loadingBox = (text = 'Loading…') => `<div class="aq-page-loading">${icon('loader-circle', 20, 'aq-spin')}<span>${esc(text)}</span></div>`;

/**
 * Generic modal. `overlayClass`/`modalClass` pick a prototype modal style
 * (e.g. 'activity2-modal-overlay' + 'activity2-modal'). Returns close().
 */
export function openModal({ overlayClass, modalClass, content, onMount, dismissable = true }) {
  const overlay = document.createElement('div');
  overlay.className = overlayClass;
  overlay.innerHTML = `<div class="${modalClass}" role="dialog" aria-modal="true">${content}</div>`;
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape' && dismissable) close(); };
  overlay.addEventListener('click', (e) => {
    if ((e.target === overlay && dismissable) || e.target.closest('[data-close]')) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  onMount?.(overlay.firstElementChild, close);
  overlay.querySelector('input, select, textarea')?.focus();
  return close;
}

export function formData(form) { return Object.fromEntries(new FormData(form).entries()); }

/** Disable a button while an async action runs. */
export async function busy(button, fn) {
  if (button) button.disabled = true;
  try { return await fn(); } finally { if (button && button.isConnected) button.disabled = false; }
}
