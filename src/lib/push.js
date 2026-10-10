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
  const body = JSON.stringify({ ...payload, sentAt: new Date().toISOString() });
  let sent = 0; let failed = 0; let removed = 0;
  await Promise.all(subs.filter((s) => ok.has(s.user_id)).map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_secret } }, body,
        { TTL: payload.level === 'CRITICAL' ? 1800 : 900, urgency: 'high', topic: payload.test ? 'aquacast-test' : 'aquacast-risk' });
      sent += 1;
      await db.from('push_subscriptions').update({ last_success_at: new Date().toISOString(), last_error: null }).eq('subscription_id', s.subscription_id);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) { // browser unsubscribed / app removed
        await db.from('push_subscriptions').delete().eq('subscription_id', s.subscription_id); removed += 1;
      } else {
        failed += 1;
        await db.from('push_subscriptions').update({ last_error: String(err.statusCode || err.message).slice(0, 200) }).eq('subscription_id', s.subscription_id);
      }
    }
  }));
  return { sent, failed, removed };
}

module.exports = { enabled, saveSubscription, removeSubscription, sendToAll };
