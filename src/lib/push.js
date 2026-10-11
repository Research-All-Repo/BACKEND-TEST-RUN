'use strict';
/**
 * Web Push: sends risk alerts straight to phones/browsers that turned on notifications,
 * even when the AquaCast app is closed or the phone is locked. Uses VAPID keys
 * (server env only). Subscriptions live in public.push_subscriptions (migration 003).
 */
const webpush = require('web-push');
const config = require('../config');
const { getAdminClient } = require('./supabase');

const enabled = () => !!(config.push.publicKey && config.push.privateKey);
let configured = false;
function setup() {
  if (configured || !enabled()) return;
  webpush.setVapidDetails(config.push.subject, config.push.publicKey, config.push.privateKey);
  configured = true;
}

/** Why push cannot work with the current VAPID settings (null when they are fine). Shown in diagnostics. */
function configError() {
  if (!enabled()) return 'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are missing.';
  try { setup(); return null; } catch (e) { return e.message; }
}

/** Save (or refresh) one browser's subscription for this user. */
async function saveSubscription(userId, sub, userAgent) {
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new Error('Invalid push subscription.');
  if (!/^https:\/\//.test(sub.endpoint)) throw new Error('Push endpoint must be https.');
  const { error } = await getAdminClient().from('push_subscriptions').upsert({
    user_id: userId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth_secret: sub.keys.auth,
    user_agent: String(userAgent || '').slice(0, 200), last_error: null,
  }, { onConflict: 'endpoint' });
  if (error) throw error;
}

async function removeSubscription(endpoint) {
  await getAdminClient().from('push_subscriptions').delete().eq('endpoint', endpoint);
}

/**
 * Send one notification to every subscribed device of ACTIVE users.
 * payload: { title, body, level: 'WARNING'|'CRITICAL', tag, url, test }
 * Returns { sent, failed, removed }.
 */
async function sendToAll(payload) {
  if (!enabled()) return { sent: 0, failed: 0, removed: 0, disabled: true };
  setup();
  const db = getAdminClient();
  const { data: subs, error } = await db.from('push_subscriptions').select('subscription_id, user_id, endpoint, p256dh, auth_secret');
  if (error) throw error;
  if (!subs.length) return { sent: 0, failed: 0, removed: 0 };
  const { data: active } = await db.from('user_access_profiles').select('user_id').eq('status', 'ACTIVE')
    .in('user_id', [...new Set(subs.map((s) => s.user_id))]);
  const ok = new Set((active || []).map((u) => u.user_id));
  return sendTo(subs.filter((s) => ok.has(s.user_id)), payload);
}

/** Send to one device (the "test this phone" button). The subscription must belong to userId. */
async function sendToEndpoint(endpoint, userId, payload) {
  if (!enabled()) return { sent: 0, failed: 0, removed: 0, disabled: true };
  setup();
  const { data: subs, error } = await getAdminClient().from('push_subscriptions')
    .select('subscription_id, user_id, endpoint, p256dh, auth_secret').eq('endpoint', endpoint).eq('user_id', userId);
  if (error) throw error;
  if (!subs.length) return { sent: 0, failed: 0, removed: 0, not_registered: true };
  return sendTo(subs, payload);
}

/** True when this user's device (endpoint) is registered for push. */
async function hasSubscription(endpoint, userId) {
  const { data, error } = await getAdminClient().from('push_subscriptions').select('subscription_id').eq('endpoint', endpoint).eq('user_id', userId).limit(1);
  if (error) throw error;
  return data.length > 0;
}

/** Every registered device with its owner's name and the result of the last send (diagnostics). */
async function listSubscriptions() {
  const db = getAdminClient();
  const { data: subs, error } = await db.from('push_subscriptions')
    .select('subscription_id, user_id, endpoint, user_agent, created_at, last_success_at, last_error').order('created_at', { ascending: false });
  if (error) throw error;
  const ids = [...new Set(subs.map((s) => s.user_id))];
  const { data: people } = ids.length ? await db.from('user_access_profiles').select('user_id, full_name, email, status').in('user_id', ids) : { data: [] };
  const byId = new Map((people || []).map((p) => [p.user_id, p]));
  return subs.map((s) => ({ ...s, endpoint: undefined, push_service: (() => { try { return new URL(s.endpoint).host; } catch { return 'unknown'; } })(),
    user_name: byId.get(s.user_id)?.full_name || byId.get(s.user_id)?.email || 'Unknown user', user_status: byId.get(s.user_id)?.status || 'UNKNOWN' }));
}

async function sendTo(subs, payload) {
  const db = getAdminClient();
  const body = JSON.stringify({ ...payload, sentAt: new Date().toISOString() });
  let sent = 0; let failed = 0; let removed = 0; const errors = [];
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_secret } }, body,
        { TTL: payload.level === 'CRITICAL' ? 7200 : 3600, urgency: 'high', topic: payload.test ? 'aquacast-test' : 'aquacast-risk' });
      sent += 1;
      await db.from('push_subscriptions').update({ last_success_at: new Date().toISOString(), last_error: null }).eq('subscription_id', s.subscription_id);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) { // browser unsubscribed / app removed
        await db.from('push_subscriptions').delete().eq('subscription_id', s.subscription_id); removed += 1;
      } else {
        failed += 1;
        const why = `${err.statusCode || ''} ${String(err.body || err.message || '').slice(0, 160)}`.trim();
        errors.push(why);
        await db.from('push_subscriptions').update({ last_error: why.slice(0, 200) }).eq('subscription_id', s.subscription_id);
      }
    }
  }));
  return { sent, failed, removed, ...(errors.length ? { errors: errors.slice(0, 3) } : {}) };
}

module.exports = { enabled, saveSubscription, removeSubscription, sendToAll, sendToEndpoint, hasSubscription, listSubscriptions, configError };
