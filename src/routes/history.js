'use strict';
const express = require('express');
const { unwrap, E } = require('../lib/errors');
const { parseRange, parsePage } = require('../lib/helpers');

const router = express.Router();

const OBS_COLUMNS = 'observation_id, timestamp_utc, record_status, do_mg_l, do_mg_l_status, do_saturation_pct, do_saturation_status, '
  + 'water_temp_c, water_temp_status, ph_value, ph_status, light_lux, light_status, air_temp_c, air_temp_status, '
  + 'relative_humidity_pct, humidity_status, atmospheric_pressure_hpa, pressure_status';

async function aerationIntervals(db, from, to) {
  const rows = unwrap(await db.from('management_events').select('event_id, event_start_utc, event_end_utc, related_command_id')
    .eq('event_type', 'AERATION').lt('event_start_utc', to).or(`event_end_utc.is.null,event_end_utc.gt.${from}`));
  return rows.map((r) => ({ start: new Date(r.event_start_utc).getTime(), end: r.event_end_utc ? new Date(r.event_end_utc).getTime() : Infinity,
    controller: !!r.related_command_id }));
}

/**
 * GET /api/history/observations?from=&to=  (or ?range=24h|7d|30d) &page=&page_size=&order=desc
 * Paginated observation records with the recorded risk state and whether an
 * aeration session was recorded at that time.
 */
router.get('/observations', async (req, res, next) => {
  try {
    const { db } = req.auth;
    const { from, to } = parseRange(req.query, { defaultHours: 24, maxDays: 92 });
    const { page, pageSize, offset } = parsePage(req.query, { defaultSize: 25, maxSize: 500 });
    const ascending = req.query.order === 'asc';
    const { data, error, count } = await db.from('raw_observations')
      .select(`${OBS_COLUMNS}, risk_assessments(current_risk_state, forecast_outlook, rule_version)`, { count: 'exact' })
      .gte('timestamp_utc', from).lt('timestamp_utc', to)
      .order('timestamp_utc', { ascending }).range(offset, offset + pageSize - 1);
    if (error) throw require('../lib/errors').fromSupabase(error);
    const intervals = await aerationIntervals(db, from, to);
    const rows = data.map((o) => {
      const t = new Date(o.timestamp_utc).getTime();
      const aer = intervals.find((i) => t >= i.start && t < i.end);
      const risk = Array.isArray(o.risk_assessments) ? o.risk_assessments[0] : o.risk_assessments;
      const { risk_assessments, ...rest } = o;
      return { ...rest, recorded_risk_state: risk?.current_risk_state || null, forecast_outlook: risk?.forecast_outlook || null,
        aeration_recorded: aer ? (aer.controller ? 'CONTROLLER_REPORTED_ON' : 'MANUALLY_LOGGED') : 'NONE' };
    });
    res.json({ data: rows, meta: { from, to, page, page_size: pageSize, total: count ?? null,
      total_pages: count ? Math.ceil(count / pageSize) : 0 } });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/history/series?from=&to=&bucket_minutes=
 * Time-bucketed averages for charts. Bucket size is chosen automatically to
 * keep about 300 points unless bucket_minutes is given.
 */
router.get('/series', async (req, res, next) => {
  try {
    const { db } = req.auth;
    const { from, to } = parseRange(req.query, { defaultHours: 24, maxDays: 92 });
    const spanMin = (new Date(to) - new Date(from)) / 60000;
    let bucket = Number(req.query.bucket_minutes);
    if (!Number.isFinite(bucket) || bucket <= 0) bucket = [10, 30, 60, 120, 180, 360, 720, 1440].find((b) => spanMin / b <= 300) || 1440;
    if (bucket < 10 || bucket > 1440) throw E.validation('bucket_minutes must be between 10 and 1440.');
    const rows = unwrap(await db.rpc('get_observation_series', { p_from: from, p_to: to, p_bucket_minutes: Math.round(bucket) }));
    res.json({ data: rows, meta: { from, to, bucket_minutes: Math.round(bucket), points: rows.length } });
  } catch (err) {
    next(err);
  }
});

/** GET /api/history/summary?from=&to= - stat cards (average, range, net change, elevated-risk records). */
router.get('/summary', async (req, res, next) => {
  try {
    const { db } = req.auth;
    const { from, to } = parseRange(req.query, { defaultHours: 24, maxDays: 92 });
    const states = ['NORMAL', 'WATCH', 'WARNING', 'CRITICAL', 'DATA_UNAVAILABLE'];
    const [[row], counts] = await Promise.all([
      db.rpc('get_history_summary', { p_from: from, p_to: to }).then(unwrap),
      Promise.all(states.map(async (st) => {
        const { count, error } = await db.from('raw_observations')
          .select('observation_id, risk_assessments!inner(current_risk_state)', { count: 'exact', head: true })
          .eq('risk_assessments.current_risk_state', st).gte('timestamp_utc', from).lt('timestamp_utc', to);
        if (error) throw require('../lib/errors').fromSupabase(error);
        return [st, count || 0];
      })),
    ]);
    const s = row || {};
    res.json({
      data: { ...s, risk_counts: Object.fromEntries(counts),
        net_do_change: s.first_do !== null && s.last_do !== null && s.first_do !== undefined ? Math.round((s.last_do - s.first_do) * 1000) / 1000 : null },
      meta: { from, to },
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/history/export.csv?from=&to= - CSV download of observations + risk state (max 31 days). */
router.get('/export.csv', async (req, res, next) => {
  try {
    const { db } = req.auth;
    const { from, to } = parseRange(req.query, { defaultHours: 24, maxDays: 31 });
    const cols = OBS_COLUMNS.split(',').map((c) => c.trim());
    const all = [];
    for (let offset = 0; offset < 50_000; offset += 1000) {
      const batch = unwrap(await db.from('raw_observations').select(`${OBS_COLUMNS}, risk_assessments(current_risk_state)`)
        .gte('timestamp_utc', from).lt('timestamp_utc', to).order('timestamp_utc').range(offset, offset + 999));
      all.push(...batch);
      if (batch.length < 1000) break;
    }
    const esc = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const lines = [[...cols, 'recorded_risk_state'].join(',')];
    for (const o of all) {
      const risk = Array.isArray(o.risk_assessments) ? o.risk_assessments[0] : o.risk_assessments;
      lines.push([...cols.map((c) => esc(o[c])), esc(risk?.current_risk_state)].join(','));
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="aquacast-observations-${from.slice(0, 10)}-to-${to.slice(0, 10)}.csv"`);
    res.send(lines.join('\n'));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
