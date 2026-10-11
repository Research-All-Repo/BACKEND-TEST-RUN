// Pieces shared by several pages: activity recording modal, pagination, icons per event type.
import { get, post } from '../api.js';
import { html, raw, ic, openModal, formData, toast, localInputToIso, busy } from '../ui.js';

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
  USER_ACCESS_REVOKE: 'Access Revoked', USER_ACCESS_CHANGE_ROLE: 'Role Changed', USER_DETAILS_UPDATED: 'User Details Updated', MANAGEMENT_EVENT_CLOSED: 'Activity Closed', MOCK_EDGE_STATE_CHANGED: 'Simulator Online/Offline', ALERT_TEST_BROADCAST: 'Test Alert Sent',
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
