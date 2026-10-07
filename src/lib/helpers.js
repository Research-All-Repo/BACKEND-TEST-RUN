'use strict';
const config = require('../config');
const { E } = require('./errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuid(value, name = 'id') {
  if (!UUID_RE.test(String(value || ''))) throw E.validation(`${name} must be a UUID.`);
  return String(value).toLowerCase();
}

function minutesBetween(a, b) {
  return (new Date(b).getTime() - new Date(a).getTime()) / 60000;
}

/**
 * Parse ?from=&to= (ISO 8601) or ?range=24h|7d|30d. Defaults to the last 24 h.
 * Caps the window so a single request cannot ask for years of data.
 */
function parseRange(query, { defaultHours = 24, maxDays = 92 } = {}) {
  const now = new Date();
  let to = query.to ? new Date(query.to) : now;
  let from;
  if (query.from) {
    from = new Date(query.from);
  } else {
    const m = /^(\d+)(h|d)$/.exec(String(query.range || ''));
    const hours = m ? Number(m[1]) * (m[2] === 'd' ? 24 : 1) : defaultHours;
    from = new Date(to.getTime() - hours * 3600 * 1000);
  }
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw E.validation('from/to must be ISO 8601 date-times, e.g. 2026-10-05T00:00:00+08:00');
  }
  if (from >= to) throw E.validation('from must be earlier than to.');
  if ((to - from) / 86400000 > maxDays) throw E.validation(`The time range may not exceed ${maxDays} days.`);
  return { from: from.toISOString(), to: to.toISOString() };
}

function parsePage(query, { defaultSize = 50, maxSize = 500 } = {}) {
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const pageSize = Math.min(maxSize, Math.max(1, Math.floor(Number(query.page_size) || defaultSize)));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/**
 * Connectivity / data-freshness classification for the dashboard banner.
 * Cloud data only arrives after the Pi syncs, so the age of the newest
 * observation in Supabase is the main signal:
 *   NO_DATA       no observation has ever been synced
 *   LIVE          newest observation is recent (within ~2.5 cycles)
 *   SYNC_DELAYED  data is arriving late, or the Pi reports it cannot reach the internet
 *   OFFLINE       nothing new for a long time -> edge device offline or not syncing
 */
function classifyFreshness(latestObservationUtc, latestHealth, now = new Date()) {
  if (!latestObservationUtc) {
    return { state: 'NO_DATA', message: 'No observations have been received from the AquaCast edge device yet.',
      latest_observation_utc: null, age_minutes: null };
  }
  const age = minutesBetween(latestObservationUtc, now);
  const base = {
    latest_observation_utc: latestObservationUtc,
    age_minutes: Math.round(age * 10) / 10,
    last_cloud_sync_at_utc: latestHealth?.last_cloud_sync_at_utc || null,
    thresholds: { sync_delayed_after_minutes: config.syncDelayedAfterMinutes, offline_after_minutes: config.edgeOfflineAfterMinutes },
  };
  if (age >= config.edgeOfflineAfterMinutes) {
    return { ...base, state: 'OFFLINE', message: `No new data for ${Math.round(age)} minutes. The edge device may be offline or unable to sync. Values shown are the last received.` };
  }
  if (age >= config.syncDelayedAfterMinutes) {
    return { ...base, state: 'SYNC_DELAYED', message: `The latest observation is ${Math.round(age)} minutes old. Cloud synchronization is delayed.` };
  }
  if (latestHealth && latestHealth.internet_reachable === false) {
    return { ...base, state: 'SYNC_DELAYED', message: 'The edge device last reported no internet connection; newer cycles may still be waiting to sync.' };
  }
  return { ...base, state: 'LIVE', message: 'Receiving data on schedule.' };
}

function ruleReference(ruleVersion) {
  const version = ruleVersion || config.defaultRuleVersion;
  const rule = config.riskRules[version];
  return rule
    ? { rule_version: version, ...rule, source: 'Backend rule registry (read-only, not stored in LS-1.0 tables)' }
    : { rule_version: version, critical_do_mg_l: null, watch_boundary_do_mg_l: null, description: [], source: 'Unknown rule version' };
}

function sanitizeText(value, max = 1000) {
  if (value === undefined || value === null) return null;
  const s = String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  return s ? s.slice(0, max) : null;
}

module.exports = { assertUuid, parseRange, parsePage, classifyFreshness, ruleReference, sanitizeText, minutesBetween, UUID_RE };
