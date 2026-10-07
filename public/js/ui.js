// Small DOM + formatting helpers shared by the placeholder pages.

let tz = 'Asia/Manila';
export function setTimezone(z) { if (z) tz = z; }

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Tagged template that escapes interpolations unless wrapped with raw(). */
export function html(strings, ...values) {
  return strings.reduce((out, s, i) => {
    if (i >= values.length) return out + s;
    const v = values[i];
    const val = v && v.__raw ? v.value : Array.isArray(v) ? v.map((x) => (x && x.__raw ? x.value : esc(x))).join('') : esc(v);
    return out + s + val;
  }, '');
}
export const raw = (value) => ({ __raw: true, value });

export function fmtTime(iso, opts = {}) {
  if (!iso) return '--';
  return new Intl.DateTimeFormat('en-PH', { timeZone: tz, month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, ...opts })
    .format(new Date(iso));
}
export function fmtClock(iso) { return iso ? fmtTime(iso, { month: undefined, day: undefined }) : '--'; }
export function fmtNum(v, d = 2) { return v === null || v === undefined || Number.isNaN(Number(v)) ? '--' : Number(v).toFixed(d); }
export function ago(iso) {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}
export const pill = (text, cls = text) => raw(`<span class="pill ${esc(cls)}">${esc(String(text ?? '--').replaceAll('_', ' '))}</span>`);

/** datetime-local value <-> ISO, interpreted in the station time zone (+08:00 for Manila). */
export function localInputToIso(v) { return v ? new Date(`${v}:00+08:00`).toISOString() : ''; }

export function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 5000);
}

export function modal(innerHtml, onMount) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${innerHtml}</div>`;
  const close = () => bg.remove();
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('[data-close]')) close(); });
  document.body.append(bg);
  onMount?.(bg.querySelector('.modal'), close);
  return close;
}

export function errorBox(err) {
  const map = {
    SUPABASE_UNAVAILABLE: 'The database is unreachable right now. Data will load when it is back.',
    SUPABASE_REQUEST_FAILED: 'The database request failed. Try again.',
    BACKEND_UNREACHABLE: 'The AquaCast server could not be reached.',
    BROWSER_OFFLINE: 'Your device is offline.',
    FORBIDDEN: 'Your role is not authorized to view this.',
  };
  return `<div class="error-box"><strong>${esc(err.code || 'ERROR')}</strong><br>${esc(map[err.code] || err.message)}</div>`;
}

export function formData(form) { return Object.fromEntries(new FormData(form).entries()); }
