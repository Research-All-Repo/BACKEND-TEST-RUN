'use strict';
/**
 * Sends one alert to every ACTIVE user's registered phones/browsers and tracks delivery.
 *
 *   1. A push goes to each registered device. Every push carries a signed receipt id.
 *   2. The phone's service worker posts that receipt back the moment the notification is
 *      shown (POST /api/push/receipt), which marks the delivery CONFIRMED.
 *   3. Diagnostics and the Model Evaluation page use this to show which phones really received
 *      each alert, instead of only "the push service accepted it".
 *
 * If migration 006 is not installed yet it falls back to plain push (no tracking).
 */
const crypto = require('crypto');
const config = require('../config');
const { getAdminClient } = require('../lib/supabase');
const push = require('../lib/push');

const receiptKey = () => crypto.createHash('sha256')
  .update(`aquacast-receipt:${config.push.privateKey || config.push.hookSecret || 'dev'}`).digest();
const signReceipt = (id) => crypto.createHmac('sha256', receiptKey()).update(id).digest('base64url').slice(0, 32);
function receiptOk(id, sig) {
  if (!/^[0-9a-f-]{36}$/.test(String(id)) || typeof sig !== 'string' || sig.length !== 32) return false;
  return crypto.timingSafeEqual(Buffer.from(signReceipt(id)), Buffer.from(sig));
}

// a missing table shows up as PGRST205 / 42P01, or as an empty 404 from some PostgREST versions
const missingTable = (err) => !err?.message || /alert_(dispatches|deliveries)|relation .* does not exist|schema cache/i.test(err?.message || '');

async function loadRecipients({ userIds = null, endpoint = null } = {}) {
  const db = getAdminClient();
  let q = db.from('user_access_profiles').select('user_id').eq('status', 'ACTIVE');
  if (userIds) q = q.in('user_id', userIds);
  const { data: people, error } = await q;
  if (error) throw error;
  const ids = people.map((p) => p.user_id);
  if (!ids.length || !push.enabled()) return { people, subs: [] };
  const query = (cols) => { let sq = db.from('push_subscriptions').select(cols).in('user_id', ids); if (endpoint) sq = sq.eq('endpoint', endpoint); return sq; };
  let { data: subs, error: subErr } = await query('subscription_id, user_id, endpoint, p256dh, auth_secret, lang');
  if (subErr && /lang/.test(subErr.message || '')) ({ data: subs, error: subErr } = await query('subscription_id, user_id, endpoint, p256dh, auth_secret'));
  if (subErr) throw subErr;
  return { people, subs: subs || [] };
}

/**
 * Send an alert. options:
 *   kind: RISK | STALE | RECOVERY | ESCALATION | TEST
 *   level: CRITICAL | WARNING | INFO   (drives the phone's vibration pattern)
 *   title, body, url, tag, test        (the notification, English)
 *   fil: { title, body }               (the same notification in Filipino, for devices set to Filipino)
 *   userIds, endpoint                  (limit recipients, e.g. the "test this phone" button)
 */
async function sendAlert(opts) {
  const { kind, level, title, body, url = '/#live', tag = 'aquacast-risk', test = false, userIds = null, endpoint = null, fil = null } = opts;
  const db = getAdminClient();
  const dispatchId = crypto.randomUUID();
  const { people, subs } = await loadRecipients({ userIds, endpoint });

  // record the alert; without migration 006 fall back to plain push
  const { error: dErr } = await db.from('alert_dispatches').insert({ dispatch_id: dispatchId, kind, level, title: String(title).slice(0, 200) });
  if (dErr) {
    if (!missingTable(dErr)) throw dErr;
    const r = push.enabled() ? await push.sendToAll({ level, title, body, url, tag, test }) : { sent: 0, failed: 0, removed: 0, disabled: true };
    return { ...r, tracking: false };
  }

  const sentAt = new Date().toISOString();
  // rows first: a fast phone can post its receipt before the send call even returns
  const rows = subs.map((s) => ({ delivery_id: crypto.randomUUID(), dispatch_id: dispatchId, user_id: s.user_id,
    subscription_id: s.subscription_id, status: 'SENT', detail: null }));
  if (rows.length) await db.from('alert_deliveries').insert(rows);
  const reached = new Set();
  let failed = 0; let removed = 0; const errors = [];
  await Promise.all(subs.map(async (s, i) => {
    const row = rows[i];
    const text = s.lang === 'fil' && fil ? fil : { title, body };
    const r = await push.sendOne(s, { level, title: text.title, body: text.body, url, tag, test, sentAt, receipt: { id: row.delivery_id, sig: signReceipt(row.delivery_id) } });
    if (r.ok) { reached.add(s.user_id); return; }
    if (r.removed) removed += 1; else { failed += 1; errors.push(r.error); }
    row.status = 'FAILED';
    await db.from('alert_deliveries').update({ status: 'FAILED', detail: String(r.error).slice(0, 200) }).eq('delivery_id', row.delivery_id);
  }));
  return { dispatch_id: dispatchId, sent: rows.filter((r) => r.status === 'SENT').length, failed, removed,
    people: people.length, unreachable: people.filter((p) => !reached.has(p.user_id)).length,
    ...(push.enabled() ? {} : { disabled: true }), ...(errors.length ? { errors: errors.slice(0, 3) } : {}) };
}

/** The phone confirmed it displayed the push. */
async function confirmReceipt(id, sig) {
  if (!receiptOk(id, sig)) return false;
  await getAdminClient().from('alert_deliveries').update({ status: 'CONFIRMED', confirmed_at: new Date().toISOString() })
    .eq('delivery_id', id).neq('status', 'CONFIRMED');
  return true;
}

module.exports = { sendAlert, confirmReceipt, signReceipt };
