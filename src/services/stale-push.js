'use strict';
/**
 * "No new readings" phone alarm. Called every 5 minutes by Supabase pg_cron (migration 005)
 * through POST /api/push/stale-check, and after every new risk row (risk-hook) for the
 * "readings are back" message.
 *
 *   - newest reading older than PUSH_STALE_MINUTES (default 30)  -> one alert for this outage
 *   - readings resume after an alerted outage                    -> one "readings are back" alert
 * Skipped while the mock edge simulator runs (its data only advances while someone has the
 * dashboard open) and while calibration mode is on.
 */
const config = require('../config');
const { getAdminClient } = require('../lib/supabase');
const push = require('../lib/push');
const { getCalibration } = require('../lib/dashboard-settings');

const fmtTime = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Manila' });

async function checkStaleAndNotify({ now = Date.now() } = {}) {
  if (!push.enabled()) return { skipped: 'push not configured' };
  if (config.mockEdge?.enabled) return { skipped: 'mock edge simulator is on' };
  if ((await getCalibration()).enabled) return { skipped: 'calibration mode' };
  const db = getAdminClient();
  const { data: latest, error } = await db.from('raw_observations').select('timestamp_utc').order('timestamp_utc', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  if (!latest) return { skipped: 'no readings yet' };
  const lastAt = new Date(latest.timestamp_utc).getTime();
  const ageMin = Math.floor((now - lastAt) / 60000);

  if (ageMin < config.push.staleMinutes) return recoverIfNeeded(db, latest.timestamp_utc);

  // claim this outage (unique index on target_id) so cron + retries never double-send
  const { data: claim, error: claimErr } = await db.from('dashboard_audit_log').insert({
    actor_user_id: null, action: 'PUSH_STALE_SENT', target_table: 'raw_observations', target_id: latest.timestamp_utc,
    details: { last_reading_utc: latest.timestamp_utc, minutes_without_data: ageMin, sending: true },
  }).select('audit_id').single();
  if (claimErr) {
    if (claimErr.code === '23505') return { skipped: 'already alerted for this outage', minutes_without_data: ageMin };
    throw claimErr;
  }
  const result = await push.sendToAll({
    level: 'WARNING', tag: 'aquacast-stale', url: '/#sensors',
    title: 'No new readings from the pond',
    body: `Last reading at ${fmtTime(latest.timestamp_utc)} (${ageMin} min ago). Check the Raspberry Pi power and internet. DO alerts cannot work without data.`,
  });
  await db.from('dashboard_audit_log').update({ details: { last_reading_utc: latest.timestamp_utc, minutes_without_data: ageMin, ...result } }).eq('audit_id', claim.audit_id);
  return { sent: true, minutes_without_data: ageMin, ...result };
}

/** After an alerted outage, tell everyone once that readings resumed. */
async function recoverIfNeeded(db, latestIso) {
  const { data: open } = await db.from('dashboard_audit_log').select('audit_id, target_id, details')
    .eq('action', 'PUSH_STALE_SENT').is('details->>recovered_at', null).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!open || new Date(latestIso) <= new Date(open.target_id)) return { skipped: 'data is fresh' };
  // mark first (so a parallel call does not send twice), then notify
  const { data: marked } = await db.from('dashboard_audit_log').update({ details: { ...open.details, recovered_at: new Date().toISOString() } })
    .eq('audit_id', open.audit_id).is('details->>recovered_at', null).select('audit_id');
  if (!marked?.length) return { skipped: 'recovery already sent' };
  const result = await push.sendToAll({
    level: 'WARNING', tag: 'aquacast-stale', url: '/#live',
    title: 'Pond readings are back', body: `New reading received at ${fmtTime(latestIso)}. Monitoring has resumed.`,
  });
  return { recovered: true, ...result };
}

module.exports = { checkStaleAndNotify };
