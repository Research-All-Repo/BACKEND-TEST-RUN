// User Directory (ADMIN): pending access requests, authorized users, role/status changes.
// Every change goes through the backend -> admin_set_user_access RPC (audited in Supabase).
import { get, post, patch } from '../api.js';
import { html, raw, ic, esc, fmtDateTime, ago, initials, roleLabel, titleCase, toast, errorBox, loadingBox, openModal, formData, busy } from '../ui.js';
import { paginationHtml, wirePagination } from './shared.js';

const FILTERS = { ALL: 'All', ACTIVE: 'Active', SUSPENDED: 'Suspended', REVOKED: 'Revoked' };
const PERMS = [
  ['View Live Status, Forecast, History, Alerts, Sensors', true, true],
  ['Record pond activities', true, true],
  ['Acknowledge alerts', true, true],
  ['Request manual aerator ON / OFF', true, true],
  ['View Model Evaluation', true, false],
  ['Approve, suspend, revoke users and change roles', true, false],
  ['Edit study settings / request aerator mode', true, false],
];

export default async function users(root, ctx) {
  const st = { filter: 'ALL', q: '', page: 1, pageSize: 10 };
  let all = []; let meta = {};
  root.innerHTML = html`<div class="user2-page">
    <section class="dashboard-panel user2-overview-panel">
      <div class="user2-header">
        <div class="user2-heading"><div class="user2-heading-icon">${ic('users', 22)}</div>
          <div><div class="user2-title-row"><h2>User Directory</h2><span class="user2-admin-badge">ADMIN ONLY</span></div>
            <p>Approve access requests and manage who can use the AquaCast dashboard. Role and status are stored in Supabase (user_access_profiles).</p></div></div>
        <button type="button" class="user2-add-button" id="u-invite">${ic('user-plus', 16)}Add Authorized User</button>
      </div>
      <div class="user2-summary-grid" id="u-summary">${raw(loadingBox())}</div>
    </section>
    <section class="dashboard-panel user2-request-panel" id="u-requests"></section>
    <section class="dashboard-panel user2-authorized-panel">
      <div class="user2-section-header">${ic('shield-check', 18)}<div><span class="user2-eyebrow">AUTHORIZED USERS</span><h3>Account Directory</h3>
        <p>Search by name, email, organization or role. Use the menu on each row to view, edit, change role, suspend or revoke.</p></div></div>
      <div class="user2-filter-row">
        <label class="user2-search">${ic('search', 15)}<input id="u-q" type="search" placeholder="Search users" maxlength="60"></label>
        <div class="user2-filters" id="u-filters">${Object.entries(FILTERS).map(([k, v]) => raw(`<button type="button" data-filter="${k}" class="${k === 'ALL' ? 'active' : ''}">${v}</button>`))}</div>
      </div>
      <div id="u-table">${raw(loadingBox())}</div>
    </section>
    <section class="dashboard-panel user2-permissions-panel">
      <div class="user2-section-header">${ic('key-round', 18)}<div><span class="user2-eyebrow">ACCESS MODEL</span><h3>Role Permissions</h3>
        <p>Enforced by the backend and by Supabase row-level security, not only hidden in the interface.</p></div></div>
      <div class="user2-permission-table-container"><table class="user2-permission-table"><thead><tr><th>Capability</th><th>Administrator</th><th>BFAR Staff</th></tr></thead>
        <tbody>${PERMS.map(([c, a, s]) => raw(html`<tr><td>${c}</td><td class="${a ? 'allowed' : 'not-allowed'}">${ic(a ? 'check' : 'x', 15)}</td><td class="${s ? 'allowed' : 'not-allowed'}">${ic(s ? 'check' : 'x', 15)}</td></tr>`))}</tbody></table></div>
      <div class="user2-security-note">${ic('lock', 15)}<p>Pending, suspended and revoked accounts cannot read any monitoring data. Suspend and revoke also block sign-in in Supabase Auth.</p></div>
    </section>
  </div>`;

  async function load() {
    try {
      const r = await get('/api/users');
      all = r.data; meta = r.meta;
      render();
    } catch (err) {
      root.querySelector('#u-summary').innerHTML = errorBox(err);
      root.querySelector('#u-table').innerHTML = '';
    }
  }

  function render() {
    const c = meta.counts || {};
    root.querySelector('#u-summary').innerHTML = html`
      <article class="user2-summary-card"><span>Total Accounts</span><strong>${all.length}</strong><p>All dashboard accounts in Supabase.</p></article>
      <article class="user2-summary-card"><span>Active</span><strong class="active">${c.ACTIVE || 0}</strong><p>Administrators: ${all.filter((u) => u.status === 'ACTIVE' && u.role === 'ADMIN').length} · BFAR staff: ${all.filter((u) => u.status === 'ACTIVE' && u.role === 'BFAR_STAFF').length}</p></article>
      <article class="user2-summary-card"><span>Pending Requests</span><strong class="pending">${c.PENDING || 0}</strong><p>Waiting for administrator review.</p></article>
      <article class="user2-summary-card"><span>Suspended / Revoked</span><strong class="suspended">${(c.SUSPENDED || 0) + (c.REVOKED || 0)}</strong><p>Accounts that cannot sign in.</p></article>`;
    renderRequests();
    renderTable();
  }

  function renderRequests() {
    const pending = all.filter((u) => u.status === 'PENDING');
    const box = root.querySelector('#u-requests');
    box.innerHTML = html`<div class="user2-section-header">${ic('user-round-plus', 18)}<div><span class="user2-eyebrow">ACCESS REQUESTS</span><h3>Pending Requests</h3>
        <p>People who registered from the sign-in page. Approve to grant access, or reject with a reason.</p></div><span class="user2-count-badge">${pending.length}</span></div>
      ${pending.length ? raw(html`<div class="user2-request-list">${pending.map((u) => raw(html`<article class="user2-request-card">
        <div class="user2-request-person"><div class="user2-avatar">${initials(u.full_name || u.email)}</div><div><strong>${u.full_name || '(no name)'}</strong><span class="user2-email">${u.email}</span></div></div>
        <div class="user2-request-meta"><div><span>Organization</span><strong>${u.organization || '—'}</strong></div><div><span>Position</span><strong>${u.position || '—'}</strong></div>
          <div><span>Requested</span><strong>${fmtDateTime(u.created_at)}</strong></div><div><span>Email</span><strong>${u.auth ? (u.auth.email_confirmed_at ? 'Verified' : 'Not verified') : '—'}</strong></div></div>
        <div class="user2-request-actions"><button type="button" class="reject" data-act="reject" data-id="${u.user_id}">${ic('x', 15)}Reject</button><button type="button" class="approve" data-act="approve" data-id="${u.user_id}">${ic('check', 15)}Approve</button></div>
      </article>`))}</div>`) : raw(html`<div class="user2-empty-state">${ic('inbox', 24)}<strong>No pending requests</strong><p>New access requests will appear here.</p></div>`)}`;
    box.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => action(b.dataset.act, all.find((u) => u.user_id === b.dataset.id))));
  }

  function filtered() {
    const q = st.q.toLowerCase();
    return all.filter((u) => u.status !== 'PENDING' && (st.filter === 'ALL' || u.status === st.filter)
      && (!q || [u.full_name, u.email, u.organization, u.position, roleLabel(u.role)].some((v) => String(v || '').toLowerCase().includes(q))));
  }

  function renderTable() {
    const rows = filtered();
    const pages = Math.max(1, Math.ceil(rows.length / st.pageSize));
    if (st.page > pages) st.page = pages;
    const slice = rows.slice((st.page - 1) * st.pageSize, st.page * st.pageSize);
    const box = root.querySelector('#u-table');
    box.innerHTML = html`<div class="user2-table-container"><table class="user2-table">
      <thead><tr><th>User</th><th>Role</th><th>Organization / Position</th><th>Status</th><th>Last Sign-in</th><th></th></tr></thead>
      <tbody>${slice.length ? slice.map((u) => raw(html`<tr>
        <td><div class="user2-user-cell"><div class="user2-avatar">${initials(u.full_name || u.email)}</div><div><strong>${u.full_name || '(no name)'}${u.is_self ? ' (you)' : ''}</strong><small>${u.email}</small></div></div></td>
        <td><span class="user2-role ${u.role === 'ADMIN' ? 'admin' : 'operator'}">${roleLabel(u.role)}</span></td>
        <td>${u.organization || '—'}${u.position ? raw(html`<br><small class="aq-muted">${u.position}</small>`) : ''}</td>
        <td><span class="user2-status ${u.status.toLowerCase()}"><span></span>${titleCase(u.status)}</span></td>
        <td>${u.auth?.last_sign_in_at || u.last_login_at ? ago(u.auth?.last_sign_in_at || u.last_login_at) : 'Never'}</td>
        <td class="user2-actions-cell"><div class="user2-menu-wrapper"><button type="button" class="user2-more-button" data-menu="${u.user_id}" aria-label="Actions for ${u.full_name || u.email}">${ic('ellipsis-vertical', 16)}</button>
          <div class="user2-action-menu aq-hidden" data-menu-for="${u.user_id}">
            <button type="button" data-act="view" data-id="${u.user_id}">${ic('eye', 14)}View</button>
            <button type="button" data-act="edit" data-id="${u.user_id}">${ic('pencil', 14)}Edit details</button>
            ${u.status === 'ACTIVE' ? raw(html`<button type="button" data-act="role" data-id="${u.user_id}" ${u.is_self ? 'disabled' : ''}>${ic('shield', 14)}Change role</button>
              <button type="button" class="suspend" data-act="suspend" data-id="${u.user_id}" ${u.is_self ? 'disabled' : ''}>${ic('pause', 14)}Suspend</button>`) : ''}
            ${u.status === 'SUSPENDED' || u.status === 'REVOKED' ? raw(html`<button type="button" class="reactivate" data-act="reactivate" data-id="${u.user_id}">${ic('rotate-ccw', 14)}Reactivate</button>`) : ''}
            ${u.status !== 'REVOKED' ? raw(html`<button type="button" class="suspend" data-act="revoke" data-id="${u.user_id}" ${u.is_self ? 'disabled' : ''}>${ic('ban', 14)}Revoke</button>`) : ''}
          </div></div></td></tr>`))
        : raw(html`<tr><td colspan="6"><div class="user2-no-results">${ic('search-x', 20)}No users match this search or filter.</div></td></tr>`)}</tbody></table></div>
      ${raw(paginationHtml('user2', { page: st.page, pageSize: st.pageSize, total: rows.length, noun: 'users', sizes: [10, 25, 50] }))}`;
    wirePagination(box, (c) => { Object.assign(st, c); renderTable(); });
    box.querySelectorAll('[data-menu]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = box.querySelector(`[data-menu-for="${b.dataset.menu}"]`);
      const wasHidden = menu.classList.contains('aq-hidden');
      closeMenus();
      if (wasHidden) menu.classList.remove('aq-hidden');
    }));
    box.querySelectorAll('.user2-action-menu [data-act]').forEach((b) => b.addEventListener('click', () => {
      closeMenus(); action(b.dataset.act, all.find((u) => u.user_id === b.dataset.id));
    }));
  }
  const closeMenus = () => root.querySelectorAll('.user2-action-menu').forEach((m) => m.classList.add('aq-hidden'));
  const onDoc = () => closeMenus();
  document.addEventListener('click', onDoc);

  function modal(kicker, title, sub, body, onSubmit) {
    openModal({
      overlayClass: 'user2-modal-overlay', modalClass: 'user2-modal',
      content: html`<div class="user2-modal-header"><div><span>${kicker}</span><h3>${title}</h3><p>${sub}</p></div>
        <button type="button" data-close aria-label="Close">${ic('x', 18)}</button></div>${raw(body)}`,
      onMount: (m, close) => m.querySelector('form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        busy(e.submitter, async () => {
          try { await onSubmit(formData(e.target)); close(); ctx.refreshLive(); await load(); } catch (err) { toast(err.message, 'error'); }
        });
      }),
    });
  }
  const actions = (label, danger) => `<div class="user2-form-actions"><button type="button" class="secondary" data-close>Cancel</button><button type="submit" class="primary ${danger ? 'aq-danger' : ''}">${esc(label)}</button></div>`;
  const roleSelect = (cur) => `<div class="user2-form-group"><label>Role</label><select name="role"><option value="BFAR_STAFF" ${cur !== 'ADMIN' ? 'selected' : ''}>BFAR Staff</option><option value="ADMIN" ${cur === 'ADMIN' ? 'selected' : ''}>Administrator</option></select></div>`;
  const reasonField = (ph) => `<div class="user2-form-group"><label>Reason (required, saved to the audit log)</label><textarea class="aq-input" name="reason" rows="3" maxlength="500" required placeholder="${esc(ph)}"></textarea></div>`;
  const done = (r, msg) => { toast(msg, 'success'); if (r?.meta?.warning) toast(r.meta.warning, 'error'); };

  function action(act, u) {
    if (!u) return;
    const who = u.full_name || u.email;
    switch (act) {
      case 'view':
        openModal({ overlayClass: 'user2-modal-overlay', modalClass: 'user2-modal', content: html`
          <div class="user2-modal-header"><div class="user2-profile-heading"><div class="user2-avatar large">${initials(who)}</div><div><h4>${who}</h4><p>${u.email}</p></div></div>
            <button type="button" data-close aria-label="Close">${ic('x', 18)}</button></div>
          <div class="user2-profile-badges"><span class="user2-role ${u.role === 'ADMIN' ? 'admin' : 'operator'}">${roleLabel(u.role)}</span><span class="user2-status ${u.status.toLowerCase()}"><span></span>${titleCase(u.status)}</span></div>
          <div class="user2-detail-list">
            <div><span>Organization</span><strong>${u.organization || '—'}</strong></div><div><span>Position</span><strong>${u.position || '—'}</strong></div>
            <div><span>Requested role</span><strong>${roleLabel(u.requested_role)}</strong></div>
            <div><span>Email verified</span><strong>${u.auth ? (u.auth.email_confirmed_at ? fmtDateTime(u.auth.email_confirmed_at) : 'Not verified') : '—'}</strong></div>
            <div><span>Last sign-in</span><strong>${u.auth?.last_sign_in_at ? fmtDateTime(u.auth.last_sign_in_at) : 'Never'}</strong></div>
            <div><span>Account created</span><strong>${fmtDateTime(u.created_at)}</strong></div>
            <div><span>Last reviewed</span><strong>${u.reviewed_at ? fmtDateTime(u.reviewed_at) : '—'}</strong></div>
            ${u.status_reason ? raw(html`<div><span>Status reason</span><strong>${u.status_reason}</strong></div>`) : ''}
            <div><span>User ID</span><strong class="user2-mono">${u.user_id}</strong></div></div>
          <div class="user2-modal-footer"><button type="button" class="primary" data-close>Close</button></div>` });
        break;
      case 'edit':
        modal('EDIT DETAILS', who, 'Update the name and organization shown in the directory and activity log.', `<form class="user2-form">
          <div class="user2-form-group"><label>Full name</label><input class="aq-input" name="full_name" maxlength="120" required value="${esc(u.full_name)}"></div>
          <div class="user2-form-group"><label>Organization</label><input class="aq-input" name="organization" maxlength="160" value="${esc(u.organization || '')}"></div>
          <div class="user2-form-group"><label>Position</label><input class="aq-input" name="position" maxlength="120" value="${esc(u.position || '')}"></div>${actions('Save changes')}</form>`,
        async (f) => done(await patch(`/api/users/${u.user_id}`, f), 'User details saved.'));
        break;
      case 'approve':
        modal('APPROVE REQUEST', who, `Grant dashboard access to ${u.email}.`, `<form class="user2-form">${roleSelect(u.requested_role)}
          <div class="user2-form-note"><span>Requested role: ${esc(roleLabel(u.requested_role))}. Administrators can manage users and settings.</span></div>${actions('Approve access')}</form>`,
        async (f) => done(await post(`/api/users/${u.user_id}/approve`, { role: f.role }), `${who} approved.`));
        break;
      case 'reject':
        modal('REJECT REQUEST', who, 'The account stays blocked and the request is closed.', `<form class="user2-form">${reasonField('e.g. Not affiliated with the BFAR station.')}${actions('Reject request', true)}</form>`,
          async (f) => done(await post(`/api/users/${u.user_id}/reject`, f), 'Request rejected.'));
        break;
      case 'role':
        modal('CHANGE ROLE', who, 'Takes effect on the user’s next request.', `<form class="user2-form">${roleSelect(u.role)}
          <div class="user2-form-group"><label>Reason (optional)</label><input class="aq-input" name="reason" maxlength="500"></div>${actions('Change role')}</form>`,
        async (f) => done(await post(`/api/users/${u.user_id}/role`, f), 'Role updated.'));
        break;
      case 'suspend':
        modal('SUSPEND ACCESS', who, 'Temporarily blocks sign-in and data access. Can be reactivated later.', `<form class="user2-form">${reasonField('e.g. On leave until further notice.')}${actions('Suspend user', true)}</form>`,
          async (f) => done(await post(`/api/users/${u.user_id}/suspend`, f), `${who} suspended.`));
        break;
      case 'revoke':
        modal('REVOKE ACCESS', who, 'Permanently removes dashboard access. An administrator can still reactivate it if needed.', `<form class="user2-form">${reasonField('e.g. No longer assigned to the station.')}${actions('Revoke access', true)}</form>`,
          async (f) => done(await post(`/api/users/${u.user_id}/revoke`, f), `${who}'s access revoked.`));
        break;
      case 'reactivate':
        modal('REACTIVATE ACCESS', who, 'Restores sign-in and data access.', `<form class="user2-form">${roleSelect(u.role)}
          <div class="user2-form-group"><label>Reason (optional)</label><input class="aq-input" name="reason" maxlength="500"></div>${actions('Reactivate')}</form>`,
        async (f) => done(await post(`/api/users/${u.user_id}/reactivate`, f), `${who} reactivated.`));
        break;
      default:
    }
  }

  root.querySelector('#u-invite').addEventListener('click', () => modal('ADD AUTHORIZED USER', 'Invite by email',
    'Supabase emails an invitation link; the person sets their own password. Requires email (SMTP) to be working in Supabase.', `<form class="user2-form">
      <div class="user2-form-group"><label>Full name</label><input class="aq-input" name="full_name" maxlength="120" required></div>
      <div class="user2-form-group"><label>Email</label><input class="aq-input" name="email" type="email" required></div>
      <div class="user2-form-group"><label>Organization</label><input class="aq-input" name="organization" maxlength="160" value="BFAR"></div>
      <div class="user2-form-group"><label>Position</label><input class="aq-input" name="position" maxlength="120"></div>
      ${roleSelect('BFAR_STAFF')}${actions('Send invitation')}</form>`,
  async (f) => { const r = await post('/api/users/invite', f); toast(`Invitation sent to ${r.meta.invitation_sent_to}.`, 'success'); }));

  let deb;
  root.querySelector('#u-q').addEventListener('input', (e) => { clearTimeout(deb); deb = setTimeout(() => { st.q = e.target.value.trim(); st.page = 1; renderTable(); }, 200); });
  root.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
    root.querySelectorAll('[data-filter]').forEach((x) => x.classList.toggle('active', x === b));
    st.filter = b.dataset.filter; st.page = 1; renderTable();
  }));

  await load();
  return () => { document.removeEventListener('click', onDoc); clearTimeout(deb); };
}
