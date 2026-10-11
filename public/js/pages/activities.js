// Activity Log: unified feed (pond activities, aeration, aerator commands, system warnings,
// admin actions) from Supabase, with category filter, search, range, pagination and recording.
import { get, qs } from '../api.js';
import { html, raw, ic, fmtDateTime, errorBox, loadingBox } from '../ui.js';
import { eventIcon, eventLabel, sourceKind, openActivityModal, paginationHtml, wirePagination } from './shared.js';

const CATS = {
  '': 'All activity types', POND_ACTIVITY: 'Pond activities', AERATION: 'Aeration sessions', MAINTENANCE: 'Maintenance',
  AERATOR_COMMAND: 'Aerator commands', SYSTEM_WARNING: 'System warnings', ALERT: 'Alert reviews', USER_MANAGEMENT: 'User management', SETTINGS: 'Settings changes',
};
const RANGES = { '24h': 'Past 24 hours', '7d': 'Past 7 days', '30d': 'Past 30 days', '90d': 'Past 90 days' };

function describe(a) {
  if (a.event_type === 'MOCK_EDGE_STATE_CHANGED') {
    try { return `Simulated edge device set ${JSON.parse(a.details).offline ? 'OFFLINE' : 'ONLINE'} (test data only).`; } catch { /* fall through */ }
  }
  return a.details || '—';
}

export default async function activities(root, ctx) {
  const st = { category: '', q: '', range: '7d', page: 1, pageSize: 15 };
  root.innerHTML = html`<div class="activity2-page">
    <section class="dashboard-panel activity2-overview-panel">
      <div class="activity2-header">
        <div class="activity2-heading"><div class="activity2-heading-icon">${ic('list-checks', 22)}</div>
          <div><div class="activity2-title-row"><h2>Activity Log</h2><span class="activity2-audit-badge">AUDIT TRAIL</span></div>
            <p>Pond management activities, aeration sessions, aerator commands, system warnings and administrator actions, all saved in the AquaCast database.</p></div></div>
        <button type="button" class="activity2-record-button" id="ac-record">${ic('plus', 16)}Record Pond Activity</button>
      </div>
      <div class="activity2-summary-grid" id="ac-summary">${raw(loadingBox())}</div>
    </section>
    <section class="dashboard-panel activity2-log-panel">
      <div class="activity2-section-header"><div><span class="activity2-eyebrow">ACTIVITY RECORDS</span><h3>Pond &amp; System Activity</h3>
        <p>Newest first. Times are in station time (Asia/Manila).</p></div><span class="activity2-record-count" id="ac-count">—</span></div>
      <div class="activity2-filter-bar">
        <label class="activity2-filter-control">${ic('filter', 15)}<select id="ac-cat">${Object.entries(CATS).map(([k, v]) => raw(`<option value="${k}">${v}</option>`))}</select></label>
        <label class="activity2-filter-control">${ic('calendar-range', 15)}<select id="ac-range">${Object.entries(RANGES).map(([k, v]) => raw(`<option value="${k}" ${k === '7d' ? 'selected' : ''}>${v}</option>`))}</select></label>
        <label class="activity2-search-control">${ic('search', 15)}<input id="ac-q" type="search" placeholder="Search type, description, user or source" maxlength="60"></label>
      </div>
      <div id="ac-table">${raw(loadingBox())}</div>
      <div class="activity2-footer"><span>Manual entries are attributed to the signed-in user.</span><span>Aerator command entries show the request lifecycle; “APPLIED” is a controller acknowledgement, not physical proof the aerator ran.</span></div>
    </section>
  </div>`;

  async function loadSummary() {
    const box = root.querySelector('#ac-summary');
    try {
      const s = (await get(`/api/activities/summary${qs({ range: st.range })}`)).data;
      const c = s.by_category;
      box.innerHTML = html`
        <article class="activity2-summary-card"><div class="activity2-summary-top">${ic('clipboard-list', 15)}<span>Total Records</span></div><strong>${s.total}</strong><p>All logged entries in the ${RANGES[st.range].toLowerCase()}.</p></article>
        <article class="activity2-summary-card"><div class="activity2-summary-top">${ic('fish', 15)}<span>Pond Activities</span></div><strong>${(c.POND_ACTIVITY || 0) + (c.MAINTENANCE || 0)}</strong><p>Feeding, water exchange, cleaning, stocking and maintenance.</p></article>
        <article class="activity2-summary-card"><div class="activity2-summary-top">${ic('power', 15)}<span>Aeration &amp; Commands</span></div><strong>${(c.AERATION || 0) + (c.AERATOR_COMMAND || 0)}</strong><p>Aeration sessions and dashboard aerator requests.</p></article>
        <article class="activity2-summary-card"><div class="activity2-summary-top">${ic('bell-ring', 15)}<span>System Warnings</span></div><strong>${c.SYSTEM_WARNING || 0}</strong><p>Warning and critical escalations recorded by the risk engine.</p></article>`;
    } catch (err) { box.innerHTML = errorBox(err); }
  }

  async function loadTable() {
    const box = root.querySelector('#ac-table');
    try {
      const r = await get(`/api/activities${qs({ range: st.range, category: st.category || undefined, q: st.q || undefined, page: st.page, page_size: st.pageSize })}`);
      root.querySelector('#ac-count').textContent = `${r.meta.total ?? r.data.length} records`;
      box.innerHTML = html`<div class="activity2-table-container"><table class="activity2-table">
        <thead><tr><th>Date &amp; Time</th><th>Activity</th><th>Source</th><th>Recorded By</th><th>Station</th><th>Description</th></tr></thead>
        <tbody>${r.data.length ? r.data.map((a) => raw(html`<tr>
          <td class="activity2-time">${fmtDateTime(a.occurred_at)}</td>
          <td><div class="activity2-type-cell"><span class="activity2-type-icon">${ic(eventIcon(a), 15)}</span><div><strong>${eventLabel(a.event_type)}</strong>${a.ended_at ? raw(html`<small> until ${fmtDateTime(a.ended_at)}</small>`) : ''}</div></div></td>
          <td><span class="activity2-source-badge ${sourceKind(a)}">${a.source || '--'}</span></td>
          <td><span class="activity2-user">${ic(sourceKind(a) === 'system' ? 'cpu' : 'user', 14)}<span>${a.actor_name || (sourceKind(a) === 'system' ? 'AquaCast system' : '--')}</span></span></td>
          <td><span class="activity2-station" title="${ctx.station()}">${ctx.station()}</span></td>
          <td class="activity2-description">${describe(a)}</td></tr>`))
          : raw('<tr><td colspan="6" class="activity2-empty-table">No activity matches these filters.</td></tr>')}</tbody></table></div>
        ${raw(paginationHtml('activity2', { page: st.page, pageSize: st.pageSize, total: r.meta.total, noun: 'activity records' }))}`;
      wirePagination(box, (c) => { Object.assign(st, c); loadTable(); });
    } catch (err) { box.innerHTML = errorBox(err); }
  }

  root.querySelector('#ac-cat').addEventListener('change', (e) => { st.category = e.target.value; st.page = 1; loadTable(); });
  root.querySelector('#ac-range').addEventListener('change', (e) => { st.range = e.target.value; st.page = 1; loadSummary(); loadTable(); });
  let deb;
  root.querySelector('#ac-q').addEventListener('input', (e) => { clearTimeout(deb); deb = setTimeout(() => { st.q = e.target.value.trim(); st.page = 1; loadTable(); }, 350); });
  root.querySelector('#ac-record').addEventListener('click', () => openActivityModal({ variant: 'full', onSaved: () => { loadSummary(); loadTable(); } }));

  await Promise.all([loadSummary(), loadTable()]);
  return () => clearTimeout(deb);
}
