'use strict';
const express = require('express');
const crypto = require('crypto');
const { unwrap, E, fromSupabase } = require('../lib/errors');
const { parseRange, parsePage, sanitizeText, assertUuid, UUID_RE } = require('../lib/helpers');

const router = express.Router();

// LS-1.0 management_events.event_type domain, with the dashboard labels.
// Frontend-only categories (liming, probiotics, biomass sampling) map to OTHER + notes.
const EVENT_TYPES = [
  { value: 'FEEDING', label: 'Feeding' },
  { value: 'WATER_EXCHANGE', label: 'Water Exchange' },
  { value: 'POND_CLEANING', label: 'Pond Cleaning' },
  { value: 'FISH_STOCKING', label: 'Fish Stocking' },
  { value: 'FISH_HARVEST', label: 'Fish Harvest' },
  { value: 'SENSOR_MAINTENANCE', label: 'Sensor Maintenance' },
  { value: 'POWER_MAINTENANCE', label: 'Power / Equipment Maintenance' },
  { value: 'AERATION', label: 'Aeration (manually logged, needs end time)' },
  { value: 'OTHER', label: 'Other (liming, probiotics, sampling... describe in notes)' },
];
const CATEGORIES = ['POND_ACTIVITY', 'AERATION', 'MAINTENANCE', 'AERATOR_COMMAND', 'SYSTEM_WARNING', 'USER_MANAGEMENT', 'ALERT', 'SETTINGS'];

/** GET /api/activities/types - allowed activity types for the "Record Pond Activity" form. */
router.get('/types', (_req, res) => res.json({ data: EVENT_TYPES }));

/**
 * GET /api/activities?category=&from=&to=&q=&page=&page_size=
 * Unified log: pond activities, aeration sessions, aerator commands, system
 * warnings and admin actions (view public.activity_feed).
 */
router.get('/', async (req, res, next) => {
  try {
    const { db } = req.auth;
    const { from, to } = parseRange(req.query, { defaultHours: 24 * 7, maxDays: 92 });
    const { page, pageSize, offset } = parsePage(req.query, { defaultSize: 25, maxSize: 200 });
    let q = db.from('activity_feed').select('*', { count: 'exact' }).gte('occurred_at', from).lt('occurred_at', to);
    if (req.query.category) {
      const cats = String(req.query.category).split(',').filter((c) => CATEGORIES.includes(c));
      if (!cats.length) throw E.validation(`category must be one of ${CATEGORIES.join(', ')}`);
      q = q.in('category', cats);
    }
    if (req.query.q) {
      const term = String(req.query.q).replace(/[%,()*"'\\:]/g, ' ').trim().slice(0, 60);
      if (term) q = q.or(`event_type.ilike.*${term}*,details.ilike.*${term}*,actor_name.ilike.*${term}*,source.ilike.*${term}*`);
    }
    const { data, error, count } = await q.order('occurred_at', { ascending: false }).range(offset, offset + pageSize - 1);
    if (error) throw fromSupabase(error);
    res.json({ data, meta: { from, to, page, page_size: pageSize, total: count ?? null, total_pages: count ? Math.ceil(count / pageSize) : 0 } });
  } catch (err) {
    next(err);
  }
});

/** GET /api/activities/summary?from=&to= - counts per category for the stat cards. */
router.get('/summary', async (req, res, next) => {
  try {
    const { db } = req.auth;
    const { from, to } = parseRange(req.query, { defaultHours: 24 * 7, maxDays: 92 });
    const counts = await Promise.all(CATEGORIES.map(async (c) => {
      const { count, error } = await db.from('activity_feed').select('activity_id', { count: 'exact', head: true })
        .eq('category', c).gte('occurred_at', from).lt('occurred_at', to);
      if (error) throw fromSupabase(error);
      return [c, count || 0];
    }));
    const byCategory = Object.fromEntries(counts);
    res.json({ data: { total: Object.values(byCategory).reduce((a, b) => a + b, 0), by_category: byCategory }, meta: { from, to } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/activities  { event_type, event_start_utc?, event_end_utc?, notes?, reason?, related_risk_id? }
 * Saved in Supabase management_events through the record_management_event RPC
 * (BFAR_STAFF and ADMIN). An Idempotency-Key header (UUID) makes retries safe.
 */
router.post('/', async (req, res, next) => {
  try {
    const { db } = req.auth;
    const b = req.body || {};
    const type = String(b.event_type || '').toUpperCase();
    if (!EVENT_TYPES.some((t) => t.value === type)) throw E.validation('Choose a valid activity type.');
    const start = b.event_start_utc ? new Date(b.event_start_utc) : new Date();
    const end = b.event_end_utc ? new Date(b.event_end_utc) : null;
    if (Number.isNaN(start.getTime()) || (end && Number.isNaN(end.getTime()))) throw E.validation('Invalid start or end time.');
    const key = req.get('Idempotency-Key');
    const eventId = key && UUID_RE.test(key) ? key.toLowerCase() : crypto.randomUUID();
    const row = unwrap(await db.rpc('record_management_event', {
      p_event_id: eventId,
      p_event_type: type,
      p_event_start_utc: start.toISOString(),
      p_event_end_utc: end ? end.toISOString() : null,
      p_reason: sanitizeText(b.reason, 500),
      p_notes: sanitizeText(b.notes, 2000),
      p_related_risk_id: b.related_risk_id ? assertUuid(b.related_risk_id, 'related_risk_id') : null,
    }));
    res.status(201).json({ data: row });
  } catch (err) {
    next(err);
  }
});

/** POST /api/activities/:eventId/close { event_end_utc? } - add an end time to an open manual activity. */
router.post('/:eventId/close', async (req, res, next) => {
  try {
    const { db } = req.auth;
    const id = assertUuid(req.params.eventId, 'eventId');
    const end = req.body?.event_end_utc ? new Date(req.body.event_end_utc) : new Date();
    if (Number.isNaN(end.getTime())) throw E.validation('Invalid end time.');
    const row = unwrap(await db.rpc('close_management_event', { p_event_id: id, p_event_end_utc: end.toISOString() }));
    res.json({ data: row });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
