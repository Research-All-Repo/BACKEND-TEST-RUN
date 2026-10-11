'use strict';
/**
 * Dashboard switches stored in public.dashboard_settings (migration 004).
 * calibration_mode: while the probe is being calibrated, readings are shown as
 * "uncalibrated" and no risk / data-stopped phone alerts are sent.
 */
const { getAdminClient } = require('./supabase');

let cache = null;
const TTL = 20_000;

async function getCalibration({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < TTL) return cache.value;
  let value = { enabled: false, since: null, by: null, note: null, installed: true };
  try {
    const { data, error } = await getAdminClient().from('dashboard_settings')
      .select('value, updated_at, updated_by').eq('setting_key', 'calibration_mode').maybeSingle();
    if (error) throw error;
    if (data) value = { enabled: !!data.value?.enabled, since: data.value?.enabled ? data.updated_at : null, by: data.value?.by || null, note: data.value?.note || null, installed: true };
  } catch {
    value = { enabled: false, since: null, by: null, note: null, installed: false }; // migration 004 not run yet
  }
  cache = { at: Date.now(), value };
  return value;
}

async function setCalibration(enabled, { userId, byName, note }) {
  const { error } = await getAdminClient().from('dashboard_settings').upsert({
    setting_key: 'calibration_mode', value: { enabled: !!enabled, by: byName || null, note: note || null },
    updated_at: new Date().toISOString(), updated_by: userId || null,
  }, { onConflict: 'setting_key' });
  if (error) throw error;
  cache = null;
  return getCalibration({ fresh: true });
}

module.exports = { getCalibration, setCalibration };
