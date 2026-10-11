'use strict';
/**
 * Integration tests: run against a running backend + Supabase project.
 *   TEST_BASE_URL=http://localhost:3000 TEST_ADMIN_EMAIL=... TEST_ADMIN_PASSWORD=... npm test
 * Needs SUPABASE_* env (service role) to create throwaway test users,
 * and MOCK_EDGE_ENABLED=true on the server for the aerator acknowledgement test.
 * Do NOT point this at production data.
 */
require('../src/load-env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
const ADMIN = { email: process.env.TEST_ADMIN_EMAIL || 'admin@aquacast.test', password: process.env.TEST_ADMIN_PASSWORD || 'AdminPass#2026' };
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const RUN = crypto.randomBytes(3).toString('hex');

class Client {
  constructor() { this.jar = new Map(); }
  cookieHeader() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  async call(method, path, body, headers = {}) {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'content-type': 'application/json', 'X-AquaCast-Client': 'dashboard', cookie: this.cookieHeader(), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i); const v = pair.slice(i + 1);
      if (!v || /Expires=Thu, 01 Jan 1970/i.test(c)) this.jar.delete(k); else this.jar.set(k, v);
    }
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* csv */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  get(p) { return this.call('GET', p); }
  post(p, b, h) { return this.call('POST', p, b || {}, h); }
  patch(p, b) { return this.call('PATCH', p, b); }
  login(email, password) { return this.post('/api/auth/login', { email, password }); }
}

async function makeUser(email, password, { confirmed = true, name = 'Test User' } = {}) {
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: confirmed, user_metadata: { full_name: name, organization: 'BFAR TOS' } });
  if (error) throw error;
  return data.user.id;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const adminC = new Client();
const staffC = new Client();
const staffEmail = `staff-${RUN}@aquacast.test`;
const staffPw = 'StaffPass#2026';
let staffId;

test('rejects wrong password with INVALID_CREDENTIALS', async () => {
  const r = await new Client().login(ADMIN.email, 'wrong-password');
  assert.equal(r.status, 401);
  assert.equal(r.json.error.code, 'INVALID_CREDENTIALS');
});

test('admin login sets httpOnly session cookies and no tokens in the body', async () => {
  const r = await adminC.login(ADMIN.email, ADMIN.password);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.data.profile.role, 'ADMIN');
  const cookies = r.headers.getSetCookie().join('\n');
  assert.match(cookies, /aq_at=.*HttpOnly/);
  assert.match(cookies, /aq_rt=.*HttpOnly/);
  assert.ok(!JSON.stringify(r.json).includes('access_token'));
});

test('no session -> SESSION_MISSING; garbage token -> SESSION_EXPIRED', async () => {
  const r = await new Client().get('/api/live');
  assert.equal(r.json.error.code, 'SESSION_MISSING');
  const c = new Client(); c.jar.set('aq_at', 'not-a-token');
  const r2 = await c.get('/api/live');
  assert.equal(r2.status, 401);
  assert.equal(r2.json.error.code, 'SESSION_EXPIRED');
});

test('state-changing request without dashboard header is rejected (CSRF)', async () => {
  const r = await adminC.call('POST', '/api/activities', { event_type: 'FEEDING' }, { 'X-AquaCast-Client': '' });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, 'CSRF_REJECTED');
});

test('request access creates a PENDING account that cannot sign in', async () => {
  const noConsent = await new Client().post('/api/auth/request-access', { full_name: 'Pending Person', email: staffEmail, password: staffPw, organization: 'BFAR TOS' });
  assert.equal(noConsent.status, 400, 'the Privacy Notice must be accepted');
  const r = await new Client().post('/api/auth/request-access', { full_name: 'Pending Person', email: staffEmail, password: staffPw, organization: 'BFAR TOS', privacy_consent: true });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  const { data } = await admin.from('user_access_profiles').select('*').eq('email', staffEmail).single();
  const { data: au } = await admin.auth.admin.getUserById(data.user_id);
  assert.ok(au.user.user_metadata?.privacy_consent_at, 'consent time is stored with the account');
  assert.equal(data.status, 'PENDING');
  assert.equal(data.role, 'BFAR_STAFF');
  staffId = data.user_id;
  // local test stack auto-confirms email; production requires the verification link first
  await admin.auth.admin.updateUserById(staffId, { email_confirm: true });
  const l = await staffC.login(staffEmail, staffPw);
  assert.equal(l.status, 403);
  assert.equal(l.json.error.code, 'ACCOUNT_PENDING');
  assert.equal(staffC.jar.has('aq_at'), false);
});

test('unverified email cannot sign in', async () => {
  const email = `unverified-${RUN}@aquacast.test`;
  const id = await makeUser(email, staffPw, { confirmed: false });
  await admin.from('user_access_profiles').update({ status: 'ACTIVE' }).eq('user_id', id);
  const r = await new Client().login(email, staffPw);
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, 'EMAIL_NOT_VERIFIED');
});

test('admin approves the pending user; staff can then sign in', async () => {
  const r = await adminC.post(`/api/users/${staffId}/approve`, { role: 'BFAR_STAFF' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.data.status, 'ACTIVE');
  const l = await staffC.login(staffEmail, staffPw);
  assert.equal(l.status, 200, JSON.stringify(l.json));
  assert.equal(l.json.data.profile.role, 'BFAR_STAFF');
});

test('staff is forbidden from admin endpoints', async () => {
  for (const p of ['/api/users', '/api/settings', '/api/evaluation']) {
    const r = await staffC.get(p);
    assert.equal(r.status, 403, p);
    assert.equal(r.json.error.code, 'FORBIDDEN');
  }
});

test('live status returns the latest cycle with 4 horizons, risk, health and freshness', async () => {
  const r = await staffC.get('/api/live');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const d = r.json.data;
  assert.ok(d.observation.readings.do_mg_l);
  for (const k of ['water_temp_c', 'ph_value', 'light_lux', 'air_temp_c', 'relative_humidity_pct', 'atmospheric_pressure_hpa']) assert.ok(k in d.observation.readings, k);
  assert.deepEqual(d.forecasts.map((f) => f.horizon_minutes), [30, 60, 90, 120]);
  assert.ok(['NORMAL', 'WATCH', 'WARNING', 'CRITICAL', 'DATA_UNAVAILABLE'].includes(d.risk.current_risk_state));
  assert.ok(d.system_health);
  assert.equal(r.json.meta.freshness.state, 'LIVE');
  assert.equal(d.aerator.physical_feedback.available, false);
});

test('forecast, history, sensors, alerts endpoints respond', async () => {
  const f = await staffC.get('/api/forecast/latest');
  assert.equal(f.status, 200); assert.equal(f.json.data.horizons.length, 4);
  const s = await staffC.get('/api/history/series?range=7d');
  assert.equal(s.status, 200); assert.ok(s.json.data.length > 50);
  const o = await staffC.get('/api/history/observations?range=24h&page_size=10');
  assert.equal(o.status, 200); assert.equal(o.json.data.length, 10); assert.ok(o.json.meta.total >= 140);
  const sm = await staffC.get('/api/history/summary?range=24h');
  assert.equal(sm.status, 200); assert.ok(sm.json.data.records > 0);
  const csv = await staffC.get('/api/history/export.csv?range=24h');
  assert.equal(csv.status, 200); assert.match(csv.text, /^observation_id,timestamp_utc/);
  const sen = await staffC.get('/api/sensors');
  assert.equal(sen.status, 200); assert.ok(sen.json.data.sensors.length >= 5);
  assert.ok(sen.json.data.sensors.some((x) => x.latest_calibration));
  const al = await staffC.get('/api/alerts?status=all&range=7d');
  assert.equal(al.status, 200);
  const bad = await staffC.get('/api/history/series?from=nonsense');
  assert.equal(bad.status, 400);
});

test('staff records a pond activity; it is stored in Supabase and shown with the actor', async () => {
  const key = crypto.randomUUID();
  const r = await staffC.post('/api/activities', { event_type: 'FEEDING', notes: `Test feeding ${RUN}` }, { 'Idempotency-Key': key });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const again = await staffC.post('/api/activities', { event_type: 'FEEDING', notes: `Test feeding ${RUN}` }, { 'Idempotency-Key': key });
  assert.equal(again.json.data.event_id, r.json.data.event_id, 'idempotent retry');
  const { data } = await admin.from('management_events').select('*').eq('event_id', key).single();
  assert.equal(data.event_type, 'FEEDING');
  const feed = await staffC.get(`/api/activities?q=${RUN}`);
  assert.ok(feed.json.data.some((a) => a.ref_id === key && a.actor_name === 'Pending Person'));
  const bad = await staffC.post('/api/activities', { event_type: 'AERATION' });
  assert.equal(bad.status, 400);
});

test('database blocks direct writes even with a valid user token (RLS + grants)', async () => {
  const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data: s } = await anon.auth.signInWithPassword({ email: staffEmail, password: staffPw });
  const userDb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY,
    { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${s.session.access_token}` } } });
  const ins = await userDb.from('aerator_commands').insert({ command_id: crypto.randomUUID(), requested_state: 'ON', command_source: 'MANUAL_DASHBOARD',
    requested_by_user_id: staffId, requested_at_utc: new Date().toISOString(), expires_at_utc: new Date(Date.now() + 60000).toISOString(),
    command_status: 'APPLIED', applied_at_utc: new Date().toISOString(), status_updated_at_utc: new Date().toISOString() });
  assert.ok(ins.error, 'direct insert must fail');
  const upd = await userDb.from('aerator_control_settings').update({ controller_output_state: 'ON' }).eq('singleton_slot', 1).select();
  assert.ok(upd.error || upd.data.length === 0, 'direct settings update must fail');
  const prof = await userDb.from('user_access_profiles').update({ role: 'ADMIN' }).eq('user_id', staffId).select();
  assert.ok(prof.error || prof.data.length === 0, 'self-promotion must fail');
  const others = await userDb.from('user_access_profiles').select('*');
  assert.equal(others.data.length, 1, 'staff only sees own profile');
  const pureAnon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const anonRead = await pureAnon.from('raw_observations').select('*').limit(1);
  assert.ok(anonRead.error || anonRead.data.length === 0, 'anon cannot read');
  const rpc = await userDb.rpc('admin_set_user_access', { p_user_id: staffId, p_action: 'CHANGE_ROLE', p_role: 'ADMIN', p_reason: null });
  assert.equal(rpc.error?.message, 'ADMIN_REQUIRED');
  await anon.auth.signOut();
});

test('aerator: request is PENDING, duplicate is refused, controller acknowledgement arrives later', async () => {
  const before = await staffC.get('/api/aerator');
  const target = before.json.data.controller.output_state === 'ON' ? 'OFF' : 'ON';
  const r = await staffC.post('/api/aerator/commands', { requested_state: target });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.equal(r.json.data.command_status, 'PENDING');
  const dup = await staffC.post('/api/aerator/commands', { requested_state: target });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, 'AERATOR_COMMAND_ALREADY_PENDING');
  const id = r.json.data.command_id;
  let status;
  for (let i = 0; i < 20; i += 1) {
    await sleep(2000);
    status = (await staffC.get(`/api/aerator/commands/${id}`)).json.data.command_status;
    if (status !== 'PENDING') break;
  }
  assert.equal(status, 'APPLIED', 'mock edge should apply the command');
  const after = await staffC.get('/api/aerator');
  assert.equal(after.json.data.controller.output_state, target);
  if (target === 'ON') {
    const { data } = await admin.from('management_events').select('*').eq('related_command_id', id).single();
    assert.equal(data.event_type, 'AERATION');
  }
});

test('mode change: staff cannot, admin can; manual commands refused until MANUAL is acknowledged', async () => {
  const s = await staffC.post('/api/aerator/mode', { mode: 'AUTOMATIC' });
  assert.equal(s.status, 403);
  const a = await adminC.post('/api/aerator/mode', { mode: 'AUTOMATIC' });
  assert.equal(a.status, 202, JSON.stringify(a.json));
  const c = await staffC.post('/api/aerator/commands', { requested_state: 'ON' });
  assert.equal(c.status, 409);
  assert.equal(c.json.error.code, 'AERATOR_NOT_IN_MANUAL_MODE');
  const back = await adminC.post('/api/aerator/mode', { mode: 'MANUAL' });
  assert.equal(back.status, 202);
  let ack = false;
  for (let i = 0; i < 20 && !ack; i += 1) { await sleep(2000); ack = (await staffC.get('/api/aerator')).json.data.mode.acknowledged; }
  assert.ok(ack, 'controller acknowledges MANUAL');
});

test('calibration mode: admin toggles it, live shows it, risk alerts pause, staff cannot change it', async () => {
  const on = await adminC.call('PUT', '/api/settings/calibration', { enabled: true, note: 'test run' });
  assert.equal(on.status, 200, JSON.stringify(on.json));
  assert.equal(on.json.data.enabled, true);
  const until = new Date(on.json.data.until).getTime() - Date.now();
  assert.ok(until > 100 * 60_000 && until <= 121 * 60_000, 'switches itself off after the default 2 hours');
  const short = await adminC.call('PUT', '/api/settings/calibration', { enabled: true, note: 'test run', hours: 0.5 });
  assert.ok(new Date(short.json.data.until).getTime() - Date.now() <= 31 * 60_000);
  assert.equal((await adminC.call('PUT', '/api/settings/calibration', { enabled: true, hours: 99 })).status, 400);
  const live = await adminC.get('/api/live');
  assert.equal(live.json.data.calibration.enabled, true);
  const pulse = await adminC.get('/api/live/pulse');
  assert.equal(pulse.json.data.calibration, true);
  const staff = await staffC.call('PUT', '/api/settings/calibration', { enabled: false });
  assert.equal(staff.status, 403);
  const bad = await adminC.call('PUT', '/api/settings/calibration', { enabled: 'yes' });
  assert.equal(bad.status, 400);
  const off = await adminC.call('PUT', '/api/settings/calibration', { enabled: false });
  assert.equal(off.json.data.enabled, false);
});

test('error log: browsers report, only admins can read', async () => {
  const msg = `test error ${RUN}`;
  const r = await staffC.post('/api/errors', { message: msg, detail: 'stack', path: '/#live' });
  assert.equal(r.status, 202);
  const list = await adminC.get('/api/errors');
  assert.equal(list.status, 200);
  assert.ok(list.json.data.some((e) => e.message === msg && e.source === 'BROWSER'), 'reported error is listed');
  assert.equal((await staffC.get('/api/errors')).status, 403);
  assert.equal((await new Client().post('/api/errors', { message: 'x' })).json.error.code, 'SESSION_MISSING');
});

test('device test answers at once and sends in the background', async () => {
  const unknown = await staffC.post('/api/push/test-me', { endpoint: `https://push.example.invalid/none-${RUN}`, delay_seconds: 10 });
  assert.equal(unknown.status, 200);
  if (unknown.json.data.disabled) return; // no VAPID keys in this environment
  assert.equal(unknown.json.data.not_registered, true);
  const endpoint = `https://push.example.invalid/dev-${RUN}`;
  assert.equal((await staffC.post('/api/push/subscribe', { subscription: { endpoint, keys: { p256dh: 'x', auth: 'y' } } })).status < 300, true);
  const t0 = Date.now();
  const r = await staffC.post('/api/push/test-me', { endpoint, delay_seconds: 10 });
  assert.equal(r.status, 202);
  assert.equal(r.json.data.scheduled, true);
  assert.ok(Date.now() - t0 < 5000, 'does not hold the request open for the delay');
  await staffC.post('/api/push/unsubscribe', { endpoint });
});

test('delivery receipts must be signed; diagnostics list who can be reached', async () => {
  const receipt = await new Client().call('POST', '/api/push/receipt', { id: crypto.randomUUID(), sig: 'x'.repeat(32) });
  assert.equal(receipt.status, 400, 'unsigned receipts are refused');
  const diag = await adminC.get('/api/push/diagnostics');
  assert.equal(diag.status, 200);
  const row = diag.json.data.coverage.find((p) => p.user_id === staffId);
  assert.ok(row, 'active staff user is listed');
  assert.equal(row.reachable, row.devices > 0);
  assert.equal((await staffC.get('/api/push/diagnostics')).status, 403);
});

test('research data export: admins get CSV per dataset, staff are refused', async () => {
  const q = `?from=${encodeURIComponent(new Date(Date.now() - 3 * 86400_000).toISOString())}&to=${encodeURIComponent(new Date().toISOString())}`;
  for (const ds of ['observations', 'forecasts', 'risk', 'alerts', 'activities', 'aerator', 'audit']) {
    const r = await adminC.get(`/api/export/${ds}.csv${q}`);
    assert.equal(r.status, 200, ds);
    assert.match(r.headers.get('content-type'), /text\/csv/, ds);
    assert.ok(r.text.split('\n').length >= 1, ds);
  }
  assert.match((await adminC.get(`/api/export/observations.csv${q}`)).text.replace(/^\uFEFF/, ''), /^observation_id,timestamp_utc,/);
  assert.equal((await adminC.get('/api/export/secrets.csv')).status, 400);
  assert.equal((await staffC.get(`/api/export/observations.csv${q}`)).status, 403);
  const info = await new Client().get('/api/auth/privacy-info');
  assert.equal(info.status, 200, 'privacy info is public');
});

test('my account: edit own profile (not email/role) and change password', async () => {
  const before = (await staffC.get('/api/auth/session')).json.data.profile;
  const r = await staffC.patch('/api/auth/me', { full_name: 'Staff Renamed', organization: 'BFAR TOS Zambales', position: 'Pond Technician', email: 'hacker@x.test', role: 'ADMIN' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.data.full_name, 'Staff Renamed');
  assert.equal(r.json.data.email, before.email, 'email cannot be changed');
  assert.equal(r.json.data.role, 'BFAR_STAFF', 'role cannot be changed');
  assert.equal((await staffC.patch('/api/auth/me', { full_name: '', organization: 'x' })).status, 400);
  // password: wrong current, too short, then a real change (this session stays valid), then back
  assert.equal((await staffC.post('/api/auth/change-password', { current_password: 'wrong-password-1', new_password: 'NewStaffPass#2026' })).status, 400);
  assert.equal((await staffC.post('/api/auth/change-password', { current_password: staffPw, new_password: 'short' })).status, 400);
  const ch = await staffC.post('/api/auth/change-password', { current_password: staffPw, new_password: 'NewStaffPass#2026' });
  assert.equal(ch.status, 200, JSON.stringify(ch.json));
  assert.equal((await staffC.get('/api/auth/session')).status, 200, 'this device stays signed in');
  assert.equal((await new Client().login(staffEmail, staffPw)).status, 401, 'old password no longer works');
  assert.equal((await new Client().login(staffEmail, 'NewStaffPass#2026')).status, 200);
  assert.equal((await staffC.post('/api/auth/change-password', { current_password: 'NewStaffPass#2026', new_password: staffPw })).status, 200);
  await staffC.patch('/api/auth/me', { full_name: before.full_name, organization: before.organization, position: before.position || '' });
  // a password-reset link must not ask for the privacy consent
  const sp = await new Client().post('/api/auth/set-password', { access_token: 'not-a-real-token', password: 'LongEnough#2026' });
  assert.notEqual(sp.json?.error?.code, 'VALIDATION_ERROR', JSON.stringify(sp.json));
});

test('push hooks refuse calls without the shared secret', async () => {
  for (const path of ['/api/push/risk-hook', '/api/push/stale-check']) {
    const r = await new Client().call('POST', path, {}, { 'x-aquacast-hook-secret': 'wrong' });
    assert.equal(r.status, 403, path);
  }
});

test('admin guardrails: cannot modify self; reason required to suspend', async () => {
  const me = (await adminC.get('/api/auth/session')).json.data.user.id;
  const r = await adminC.post(`/api/users/${me}/suspend`, { reason: 'x' });
  assert.equal(r.json.error.code, 'CANNOT_MODIFY_SELF');
  const r2 = await adminC.post(`/api/users/${staffId}/suspend`, {});
  assert.equal(r2.status, 400);
});

test('suspension takes effect immediately and blocks sign-in', async () => {
  const r = await adminC.post(`/api/users/${staffId}/suspend`, { reason: 'Integration test' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const live = await staffC.get('/api/live');
  assert.equal(live.status, 403);
  assert.equal(live.json.error.code, 'ACCOUNT_SUSPENDED');
  const l = await new Client().login(staffEmail, staffPw);
  assert.equal(l.status, 403);
  assert.equal(l.json.error.code, 'ACCOUNT_SUSPENDED');
  const re = await adminC.post(`/api/users/${staffId}/reactivate`, {});
  assert.equal(re.json.data.status, 'ACTIVE');
  const l2 = await new Client().login(staffEmail, staffPw);
  assert.equal(l2.status, 200, JSON.stringify(l2.json));
  const rv = await adminC.post(`/api/users/${staffId}/revoke`, { reason: 'Integration test cleanup' });
  assert.equal(rv.json.data.status, 'REVOKED');
});

test('admin directory, settings and evaluation', async () => {
  const u = await adminC.get('/api/users?status=PENDING,ACTIVE,SUSPENDED,REVOKED');
  assert.equal(u.status, 200);
  assert.ok(u.json.data.some((x) => x.auth && 'email_confirmed_at' in x.auth));
  const st = await adminC.get('/api/settings');
  assert.equal(st.status, 200); assert.ok(st.json.data.study);
  const p = await adminC.patch('/api/settings/study', { culture_stage: 'Grow-out (test)' });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  const bad = await adminC.patch('/api/settings/study', { pond_depth_m: -1 });
  assert.equal(bad.status, 400);
  await adminC.patch('/api/settings/study', { culture_stage: 'Grow-out' });
  const ev = await adminC.get('/api/evaluation');
  assert.equal(ev.status, 200); assert.equal(ev.json.data.horizons.length, 4);
});

test('alerts can be acknowledged once', async () => {
  const al = await adminC.get('/api/alerts?status=all&range=7d');
  const target = al.json.data.find((a) => !a.acknowledged_at);
  if (!target) return;
  const r = await adminC.post(`/api/alerts/${target.risk_id}/acknowledge`, { note: 'Reviewed in test' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const again = await adminC.post(`/api/alerts/${target.risk_id}/acknowledge`, {});
  assert.equal(again.json.error.code, 'ALERT_ALREADY_ACKNOWLEDGED');
});

test('logout revokes the session', async () => {
  const c = new Client();
  await c.login(ADMIN.email, ADMIN.password);
  const stolen = c.jar.get('aq_rt');
  const r = await c.post('/api/auth/logout');
  assert.equal(r.status, 200);
  assert.equal((await c.get('/api/live')).json.error.code, 'SESSION_MISSING');
  const thief = new Client(); thief.jar.set('aq_rt', stolen);
  const t = await thief.get('/api/live');
  assert.equal(t.status, 401, 'revoked refresh token must not work');
});
