// Pieces shared by several pages: activity recording modal, pagination, icons per event type.
import { get, post } from '../api.js';
import { html, raw, ic, openModal, formData, toast, localInputToIso, busy, fmtNum, fmtDateTime, fmtTime } from '../ui.js';
import { doZones, doThresholds, DO_COLOR, FORECAST_COLOR } from '../chart.js';

/** Icon for a management event / activity feed row. */
export function eventIcon(a) {
  const t = String(a.event_type || '');
  if (a.category === 'SYSTEM_WARNING') return 'bell-ring';
  if (a.category === 'ALERT') return 'check-check';
  if (a.category === 'USER_MANAGEMENT') return 'users';
  if (a.category === 'SETTINGS') return 'settings';
  if (a.category === 'AERATOR_COMMAND' || t === 'AERATION') return 'power';
  if (t === 'FEEDING') return 'fish';
  if (t === 'WATER_EXCHANGE') return 'waves-horizontal';
  if (t.includes('MAINTENANCE')) return 'wrench';
  if (t === 'FISH_STOCKING' || t === 'FISH_HARVEST') return 'fish';
  if (t === 'POND_CLEANING') return 'droplets';
  return 'clipboard-list';
}

const EVENT_LABELS = {
  FEEDING: 'Feeding', WATER_EXCHANGE: 'Water Exchange', POND_CLEANING: 'Pond Cleaning', FISH_STOCKING: 'Fish Stocking',
  FISH_HARVEST: 'Fish Harvest', SENSOR_MAINTENANCE: 'Sensor Maintenance', POWER_MAINTENANCE: 'Power Maintenance', AERATION: 'Aeration', OTHER: 'Other Pond Activity',
  AERATOR_ON_REQUEST: 'Aerator ON Request', AERATOR_OFF_REQUEST: 'Aerator OFF Request', RISK_WARNING: 'System Warning', RISK_CRITICAL: 'Critical Warning',
  ALERT_ACKNOWLEDGED: 'Alert Acknowledgement', STUDY_METADATA_UPDATED: 'Settings Update', AERATOR_MODE_REQUESTED: 'Aerator Mode Request',
  USER_ACCESS_APPROVE: 'User Approved', USER_ACCESS_REJECT: 'Request Rejected', USER_ACCESS_SUSPEND: 'User Suspended', USER_ACCESS_REACTIVATE: 'User Reactivated',
  USER_ACCESS_REVOKE: 'Access Revoked', USER_ACCESS_CHANGE_ROLE: 'Role Changed', USER_DETAILS_UPDATED: 'User Details Updated', MANAGEMENT_EVENT_CLOSED: 'Activity Closed', MOCK_EDGE_STATE_CHANGED: 'Simulator Online/Offline', ALERT_TEST_BROADCAST: 'Test Alert Sent', PUSH_RISK_SENT: 'Phone Alert Sent',
};
export const eventLabel = (t) => EVENT_LABELS[t] || String(t || '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/** Source badge class used by the prototype activity table. */
export function sourceKind(a) {
  if (['SYSTEM_WARNING'].includes(a.category) || /risk engine|automatic|Edge \/ field|Controller/i.test(a.source)) return 'system';
  if (a.category === 'AERATOR_COMMAND') return 'command';
  return 'operator';
}

/**
 * Record Pond Activity dialog. variant 'compact' = Live Status style (activity-modal),
 * 'full' = Activity Log style (activity2-modal). Saves to Supabase via POST /api/activities.
 */
export async function openActivityModal({ variant = 'full', onSaved } = {}) {
  let types = [];
  try { types = (await get('/api/activities/types')).data; } catch (err) { toast(err.message, 'error'); return; }
  const full = variant === 'full';
  const p = full ? 'activity2' : 'activity';
  const body = html`
    <div class="${p}-modal-header"><div><h3>Record Pond Activity${full ? '' : ' / Event'}</h3>
      <p>Add a pond operation, management activity, or field event to the AquaCast activity log. It is saved to the database with your name.</p></div>
      <button type="button" class="${full ? 'activity2-modal-close' : 'modal-close-button'}" data-close aria-label="Close">${ic('x', 18)}</button></div>
    <form class="${full ? 'activity2-form' : 'activity-form'}">
      <div class="${full ? 'activity2-form-group' : 'form-group'}"><label>Activity Type</label>
        <select name="event_type" required>${types.map((t) => raw(html`<option value="${t.value}">${t.label}</option>`))}</select></div>
      <div class="${full ? 'activity2-form-group' : 'form-group'}"><label>Start time (station time, leave blank for now)</label>
        <input class="aq-input" name="start" type="datetime-local"></div>
      <div class="${full ? 'activity2-form-group' : 'form-group'}"><label>End time (optional; required for aeration)</label>
        <input class="aq-input" name="end" type="datetime-local"></div>
      <div class="${full ? 'activity2-form-group' : 'form-group'}"><label>Activity Notes</label>
        <textarea name="notes" rows="4" placeholder="e.g. Feeding completed and current pond observations recorded."></textarea></div>
      ${full ? raw(html`<p class="activity2-form-note">Manual entries document operator or field actions. Aerator commands are issued from Live Status and logged automatically.</p>`) : ''}
      <div class="${p}-modal-actions">
        <button type="button" class="${full ? 'aq-btn' : 'modal-cancel-button'}" data-close>Cancel</button>
        <button type="submit" class="${full ? 'aq-btn primary' : 'modal-save-button'}">Save to Activity Log</button>
      </div>
    </form>`;
  openModal({
    overlayClass: `${p}-modal-overlay`, modalClass: `${p}-modal`, content: body,
    onMount: (m, close) => m.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = formData(e.target);
      busy(e.submitter, async () => {
        try {
          await post('/api/activities', {
            event_type: f.event_type, notes: f.notes,
            event_start_utc: localInputToIso(f.start) || undefined, event_end_utc: localInputToIso(f.end) || undefined,
          }, { headers: { 'Idempotency-Key': crypto.randomUUID() } });
          toast('Activity saved to the AquaCast database.', 'success');
          close();
          onSaved?.();
        } catch (err) { toast(err.message, 'error'); }
      });
    }),
  });
}

/** Prototype-style pagination block (prefix = 'history2' | 'activity2' | 'user2'). */
export function paginationHtml(prefix, { page, pageSize, total, noun = 'records', sizes = [10, 15, 25, 50] }) {
  const pages = Math.max(1, Math.ceil((total || 0) / pageSize));
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(total || 0, page * pageSize);
  const start = Math.max(1, Math.min(page - 2, pages - 4));
  const nums = [];
  for (let n = start; n <= Math.min(pages, start + 4); n += 1) nums.push(n);
  return html`<div class="${prefix}-pagination">
    <div class="${prefix}-pagination-summary"><span>Showing <strong>${from}</strong>–<strong>${to}</strong> of <strong>${total || 0}</strong> ${noun}</span>
      <label>Rows per page <select data-page-size>${sizes.map((s) => raw(`<option value="${s}" ${s === pageSize ? 'selected' : ''}>${s}</option>`))}</select></label></div>
    <div class="${prefix}-pagination-controls">
      <button type="button" class="${prefix}-page-nav" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>${ic('chevron-left', 15)}Previous</button>
      <div class="${prefix}-page-numbers">${nums.map((n) => raw(`<button type="button" class="${prefix}-page-number ${n === page ? 'active' : ''}" data-page="${n}">${n}</button>`))}</div>
      <button type="button" class="${prefix}-page-nav" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>Next${ic('chevron-right', 15)}</button>
    </div></div>`;
}

export function wirePagination(container, onChange) {
  container.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => onChange({ page: Number(b.dataset.page) })));
  container.querySelector('[data-page-size]')?.addEventListener('change', (e) => onChange({ page: 1, pageSize: Number(e.target.value) }));
}

/**
 * Chart config for "forecast vs measured" (Forecast & Risk and Model Evaluation).
 * Top: measured DO as a line, each forecast as a faint dot around it (a dense dashed line
 * was hard to read). Bottom: ONE column per hour = the average size of the forecast miss in
 * that hour, orange when it is above the ±0.3 mg/L tolerance. Zoom bar + overview strip on top.
 * pairs: [{ t: ISO target time, measured, forecast }]
 */
export function accuracyChartConfig(pairs, horizon, rule, { tol = 0.3, label = 'Forecast' } = {}) {
  // One chart, two lines on top of each other: measured DO (solid) and the forecast that was made
  // for the same moment (dashed). The light band around the measured line is the "accurate zone"
  // (within ±tol mg/L); orange dots mark only the forecasts that landed outside it.
  const at = (p) => new Date(p.t);
  const sorted = [...pairs].sort((a, b) => at(a) - at(b));
  const off = (p) => p.forecast - p.measured;
  const verdict = (p) => {
    const e = off(p);
    return `Off by ${e > 0 ? '+' : ''}${fmtNum(e)} mg/L: ${Math.abs(e) <= tol ? 'accurate (inside the band)' : e > 0 ? 'missed, forecast too high' : 'missed, forecast too low'}`;
  };
  const misses = sorted.filter((p) => Math.abs(off(p)) > tol);
  return {
    ariaLabel: `Measured DO and the ${label.toLowerCase()} made ${horizon} minutes earlier for the same time`,
    navigator: true,
    panels: [{ title: `Measured DO vs ${horizon}-min ${label.toLowerCase()}`, unit: 'mg/L', thresholds: doThresholds(rule),
      series: [
        { name: 'Measured DO', color: DO_COLOR, width: 2.6, dots: false,
          points: sorted.map((p) => ({ x: at(p), y: p.measured })),
          band: sorted.map((p) => ({ x: at(p), lo: p.measured - tol, hi: p.measured + tol })), bandLabel: `Accurate zone (within ±${tol} mg/L of measured)`, bandTooltip: false },
        { name: `${label} made ${horizon} min earlier`, color: FORECAST_COLOR, dashed: true, width: 1.8, dots: false,
          points: sorted.map((p) => ({ x: at(p), y: p.forecast, note: verdict(p) })) },
        { name: `Misses (off by more than ${tol})`, color: '#ea580c', style: 'dots', r: 3.6, opacity: 0.95, noTooltip: true,
          points: misses.map((p) => ({ x: at(p), y: p.forecast })) },
      ] }],
    tooltipX: (d) => `${fmtDateTime(d.toISOString())} (forecast made at ${fmtTime(new Date(d.getTime() - horizon * 60000).toISOString())})`,
  };
}
