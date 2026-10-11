'use strict';
/**
 * Escalation: a CRITICAL alert that nobody acknowledged within ESCALATE_AFTER_MINUTES (default 15)
 * is sent again to everyone as a separate, louder "nobody has responded" push.
 * Runs in the 5-minute background check. Each alert escalates once (unique index, migration 006).
 * Paused while calibration mode is on, like every other risk alert.
 */
const config = require('../config');
const { getAdminClient } = require('../lib/supabase');
const { getCalibration } = require('../lib/dashboard-settings');
const { sendAlert } = require('./notify');

const fmtTime = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Manila' });

async function escalateUnacknowledged({ now = Date.now() } = {}) {
  if ((await getCalibration()).enabled) return { skipped: 'calibration mode' };
  const db = getAdminClient();
  const olderThan = new Date(now - config.escalateAfterMinutes * 60_000).toISOString();
  const since = new Date(now - 6 * 3600_000).toISOString();
  const { data: alerts, error } = await db.from('risk_alerts')
    .select('risk_id, observation_timestamp_utc, do_mg_l, do_mg_l_status, current_risk_state, acknowledged_at')
    .eq('current_risk_state', 'CRITICAL').is('acknowledged_at', null)
    .lt('observation_timestamp_utc', olderThan).gte('observation_timestamp_utc', since)
    .order('observation_timestamp_utc', { ascending: false }).limit(3);
  if (error) throw error;
  if (!alerts?.length) return { escalated: 0 };

  // Only escalate while the pond is still critical (or worse); a recovered pond needs no wake-up call.
  const { data: latest } = await db.from('risk_assessments').select('current_risk_state').order('assessment_timestamp_utc', { ascending: false }).limit(1).maybeSingle();
  if (latest?.current_risk_state !== 'CRITICAL') return { escalated: 0, skipped: 'pond no longer critical' };

  const a = alerts[0]; // newest unacknowledged critical alert
  const { error: claimErr } = await db.from('dashboard_audit_log').insert({
    actor_user_id: null, action: 'ALERT_ESCALATED', target_table: 'risk_assessments', target_id: a.risk_id,
    details: { after_minutes: config.escalateAfterMinutes, observation_utc: a.observation_timestamp_utc },
  });
  if (claimErr) {
    if (claimErr.code === '23505') return { escalated: 0, skipped: 'already escalated' };
    throw claimErr;
  }
  const mins = Math.round((now - new Date(a.observation_timestamp_utc).getTime()) / 60000);
  const doText = a.do_mg_l_status === 'VALID' ? `${Number(a.do_mg_l).toFixed(2)} mg/L` : 'unavailable';
  const result = await sendAlert({
    kind: 'ESCALATION', level: 'CRITICAL', tag: 'aquacast-escalation', url: '/#alerts',
    title: `Nobody has responded: CRITICAL DO for ${mins} min`,
    body: `The critical alert from ${fmtTime(a.observation_timestamp_utc)} (DO ${doText}) is not acknowledged yet. Someone please check the pond now and acknowledge it in AquaCast.`,
  });
  await db.from('dashboard_audit_log').update({ details: { after_minutes: config.escalateAfterMinutes, observation_utc: a.observation_timestamp_utc, ...result } })
    .eq('action', 'ALERT_ESCALATED').eq('target_id', a.risk_id);
  return { escalated: 1, ...result };
}

module.exports = { escalateUnacknowledged };
