'use strict';
/**
 * Dashboard switches stored in public.dashboard_settings (migration 004).
 * calibration_mode: while the probe is being calibrated, readings are shown as
 *   "uncalibrated" and no risk / data-stopped phone alerts are sent. It always has an end
 *   time and switches itself off then, so alarms can never stay silent by accident.
 */
const config = require('../config');
const { getAdminClient } = require('./supabase');

const TTL = 20_000;
const caches = new Map();

async function readSetting(key) {
  const { data, error } = await getAdminClient().from('dashboard_settings')
    .select('value, updated_at, updated_by').eq('setting_key', key).maybeSingle();
  if (error) throw error;
  return data;
}

async function writeSetting(key, value, userId) {
  const { error } = await getAdminClient().from('dashboard_settings').upsert({
    setting_key: key, value, updated_at: new Date().toISOString(), updated_by: userId || null,
  }, { onConflict: 'setting_key' });
  if (error) throw error;
  caches.delete(key);
}

async function getCalibration({ fresh = false } = {}) {
  const c = caches.get('calibration_mode');
  if (!fresh && c && Date.now() - c.at < TTL && (!c.value.until || new Date(c.value.until) > new Date())) return c.value;
  let value = { enabled: false, since: null, until: null, by: null, note: null, installed: true };
  try {
    const data = await readSetting('calibration_mode');
    if (data?.value?.enabled) {
      // older rows (before auto-off existed) get the default duration from when they were switched on
      const until = data.value.until || new Date(new Date(data.updated_at).getTime() + config.calibrationDefaultHours * 3600_000).toISOString();
      if (new Date(until) <= new Date()) {
        await expireCalibration(data, until);
      } else {
        value = { enabled: true, since: data.updated_at, until, by: data.value.by || null, note: data.value.note || null, installed: true };
      }
    }
  } catch {
    value = { enabled: false, since: null, until: null, by: null, note: null, installed: false }; // migration 004 not run yet
  }
  caches.set('calibration_mode', { at: Date.now(), value });
  return value;
}

// Calibration time is over: switch alerts back on and leave a note in the audit log (once).
async function expireCalibration(data, until) {
  const db = getAdminClient();
  const { data: changed } = await db.from('dashboard_settings')
    .update({ value: { enabled: false, by: data.value.by || null, note: data.value.note || null, expired_at: until }, updated_at: new Date().toISOString() })
    .eq('setting_key', 'calibration_mode').eq('updated_at', data.updated_at).select('setting_key');
  if (changed?.length) {
    await db.from('dashboard_audit_log').insert({
      actor_user_id: null, action: 'CALIBRATION_MODE_CHANGED', target_table: 'dashboard_settings', target_id: 'calibration_mode',
      details: { enabled: false, automatic: true, note: 'Calibration time ended; alerts switched back on automatically.' },
    }).then(() => null, () => null);
  }
}

async function setCalibration(enabled, { userId, byName, note, hours }) {
  const h = Math.min(24, Math.max(0.25, Number(hours) || config.calibrationDefaultHours));
  const until = enabled ? new Date(Date.now() + h * 3600_000).toISOString() : null;
  await writeSetting('calibration_mode', { enabled: !!enabled, by: byName || null, note: note || null, ...(until ? { until } : {}) }, userId);
  return getCalibration({ fresh: true });
}


module.exports = { getCalibration, setCalibration };
