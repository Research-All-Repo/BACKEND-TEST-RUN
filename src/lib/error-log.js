'use strict';
/**
 * Built-in error log (public.app_error_log, migration 004). Admins read it in System Settings.
 * Writing never throws and is throttled per message so one broken page cannot flood the table.
 */
const { getAdminClient } = require('./supabase');

const recent = new Map();
const clip = (v, n) => (v === undefined || v === null ? null : String(v).slice(0, n));

async function logError({ source, message, detail, path, userId, userAgent }) {
  try {
    const sig = `${source}:${String(message).slice(0, 120)}`;
    const now = Date.now();
    if (recent.get(sig) > now - 60_000) return false; // same error logged in the last minute
    recent.set(sig, now);
    if (recent.size > 500) recent.clear();
    const db = getAdminClient();
    await db.from('app_error_log').insert({
      source, message: clip(message, 500) || 'Unknown error', detail: clip(detail, 4000), path: clip(path, 300),
      user_id: userId || null, user_agent: clip(userAgent, 200),
    });
    if (Math.random() < 0.02) await db.from('app_error_log').delete().lt('created_at', new Date(now - 30 * 86400e3).toISOString());
    return true;
  } catch {
    return false;
  }
}

async function recentErrors(limit = 50) {
  const { data, error } = await getAdminClient().from('app_error_log')
    .select('error_id, created_at, source, message, detail, path, user_id, user_agent')
    .order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data;
}

module.exports = { logError, recentErrors };
