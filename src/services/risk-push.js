'use strict';
/**
 * Decides when a new risk assessment should become a phone push alert, and sends it.
 * Called (1) by the Supabase Database Webhook on every risk_assessments INSERT (real
 * Raspberry Pi data) and (2) by the mock edge after it inserts cycles. Safe to call
 * repeatedly: each risk_id is pushed at most once (recorded in dashboard_audit_log).
 *
 * Rules (same as the in-app alerts):
 *   - escalation into WARNING or CRITICAL (previous cycle was lower)  -> push
 *   - still CRITICAL and the last CRITICAL push is older than 30 min   -> reminder push
 *   - readings older than 60 minutes are ignored (late uploads after an outage)
 */
const config = require('../config');
const { getAdminClient } = require('../lib/supabase');
const push = require('../lib/push');
const { getCalibration } = require('../lib/dashboard-settings');

const RANK = { NORMAL: 0, WATCH: 0, DATA_UNAVAILABLE: 0, WARNING: 1, CRITICAL: 2 };

async function evaluateAndNotify() {
  if (!push.enabled()) return { skipped: 'push not configured' };
  if ((await getCalibration()).enabled) return { skipped: 'calibration mode: risk alerts paused' };
  const db = getAdminClient();
  const { data: rows, error } = await db.from('risk_assessments')
    .select('risk_id, current_risk_state, assessment_timestamp_utc, observation_id, raw_observations(timestamp_utc, do_mg_l, do_mg_l_status)')
    .order('assessment_timestamp_utc', { ascending: false }).limit(2);
  if (error) throw error;
  if (!rows?.length) return { skipped: 'no risk data' };
  const [cur, prev] = rows;
  const level = RANK[cur.current_risk_state] || 0;
  if (!level) return { skipped: 'normal' };
  const obs = Array.isArray(cur.raw_observations) ? cur.raw_observations[0] : cur.raw_observations;
  const at = new Date(obs?.timestamp_utc || cur.assessment_timestamp_utc);
  if (Date.now() - at.getTime() > 60 * 60_000) return { skipped: 'old reading' };

  const escalated = level > (RANK[prev?.current_risk_state] || 0);
  let reminder = false;
  if (!escalated && level === 2) {
    const { data: last } = await db.from('dashboard_audit_log').select('created_at').eq('action', 'PUSH_RISK_SENT')
      .eq('details->>state', 'CRITICAL').order('created_at', { ascending: false }).limit(1).maybeSingle();
    reminder = !last || Date.now() - new Date(last.created_at).getTime() > config.push.criticalReminderMinutes * 60_000;
  }
  if (!escalated && !reminder) return { skipped: 'no escalation' };

  const doText = obs?.do_mg_l_status === 'VALID' ? `${Number(obs.do_mg_l).toFixed(2)} mg/L` : 'unavailable';
  // Claim this cycle first. A unique index (migration 003) lets only one caller win, so the
  // webhook and the simulator can never both push the same reading.
  const { data: claim, error: claimErr } = await db.from('dashboard_audit_log').insert({
    actor_user_id: null, action: 'PUSH_RISK_SENT', target_table: 'risk_assessments', target_id: cur.risk_id,
    details: { state: cur.current_risk_state, do: doText, reminder, sending: true },
  }).select('audit_id').single();
  if (claimErr) {
    if (claimErr.code === '23505') return { skipped: 'already sent' };
    throw claimErr;
  }

  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Manila' });
  const critical = level === 2;
  const result = await push.sendToAll({
    level: cur.current_risk_state,
    title: critical ? `CRITICAL: low dissolved oxygen${reminder ? ' (still critical)' : ''}` : 'Warning: dissolved oxygen dropping',
    body: `DO ${doText} at ${time}. ${critical ? 'Immediate operator review needed. Open AquaCast to act.' : 'Below the normal boundary. Check the pond.'}`,
    tag: 'aquacast-risk', url: '/#live',
  });
  await db.from('dashboard_audit_log').update({ details: { state: cur.current_risk_state, do: doText, reminder, ...result } }).eq('audit_id', claim.audit_id);
  return { sent: true, reminder, ...result };
}

module.exports = { evaluateAndNotify };
