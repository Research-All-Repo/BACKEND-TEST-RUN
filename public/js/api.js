// Thin fetch wrapper for the AquaCast backend.
// - Session lives in httpOnly cookies, so the browser never sees a token or a Supabase key.
// - Every state-changing call sends X-AquaCast-Client (required by the server's CSRF guard).
// - Errors are normalized to { code, message, status } so pages can switch on `code`.

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status; this.code = code; this.details = details;
  }
}

const listeners = new Set();
/** Subscribe to auth-level failures (session expired, account suspended...). */
export function onAuthProblem(fn) { listeners.add(fn); }

const AUTH_CODES = new Set(['SESSION_MISSING', 'SESSION_EXPIRED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_REVOKED',
  'ACCOUNT_PENDING', 'ACCOUNT_NOT_AUTHORIZED', 'ACCOUNT_NOT_ACTIVE', 'EMAIL_NOT_VERIFIED']);

export async function api(method, path, body, { headers = {}, silentAuth = false } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        'X-AquaCast-Client': 'dashboard', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, navigator.onLine ? 'BACKEND_UNREACHABLE' : 'BROWSER_OFFLINE',
      navigator.onLine ? 'The AquaCast server could not be reached.' : 'Your device appears to be offline.');
  }
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const e = json?.error || {};
    const err = new ApiError(res.status, e.code || `HTTP_${res.status}`, e.message || `Request failed (${res.status})`, e.details);
    if (!silentAuth && AUTH_CODES.has(err.code)) listeners.forEach((fn) => fn(err));
    throw err;
  }
  return json;
}

export const get = (p, o) => api('GET', p, undefined, o);
export const post = (p, b, o) => api('POST', p, b ?? {}, o);
export const patch = (p, b, o) => api('PATCH', p, b, o);

/** Query-string helper that skips empty values. */
export function qs(params) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, v);
  const out = s.toString();
  return out ? `?${out}` : '';
}
