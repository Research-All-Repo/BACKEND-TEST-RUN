'use strict';
const express = require('express');
const config = require('../config');
const { getAdminClient } = require('../lib/supabase');
const { unwrap, E, isNetworkError } = require('../lib/errors');
const { assertUuid, sanitizeText } = require('../lib/helpers');

const router = express.Router();
const ROLES = ['ADMIN', 'BFAR_STAFF'];
const STATUSES = ['PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED'];

/** Supabase Auth facts the profile table does not hold (email verified, last sign-in, ban). Service role, server only. */
async function authFacts() {
  const facts = new Map();
  try {
    for (let page = 1; page <= 20; page += 1) {
      const { data, error } = await getAdminClient().auth.admin.listUsers({ page, perPage: 1000 });
      if (error) throw error;
      for (const u of data.users) {
        facts.set(u.id, { email_confirmed_at: u.email_confirmed_at || null, last_sign_in_at: u.last_sign_in_at || null,
          banned_until: u.banned_until || null, invited_at: u.invited_at || null });
      }
      if (data.users.length < 1000) break;
    }
  } catch (err) {
    if (isNetworkError(err)) throw E.supabaseUnavailable();
    return null; // directory still works without the auth extras
  }
  return facts;
}

/**
 * GET /api/users?status=PENDING|ACTIVE|SUSPENDED|REVOKED&q=
 * Directory for Administrators: profiles (role/status) + auth facts.
 */
router.get('/', async (req, res, next) => {
  try {
    const { db } = req.auth;
    let q = db.from('user_access_profiles').select('*').order('created_at', { ascending: false });
    if (req.query.status) {
      const st = String(req.query.status).toUpperCase().split(',').filter((s) => STATUSES.includes(s));
      if (!st.length) throw E.validation(`status must be one of ${STATUSES.join(', ')}`);
      q = q.in('status', st);
    }
    if (req.query.q) {
      const term = String(req.query.q).replace(/[%,()*"'\\:]/g, ' ').trim().slice(0, 60);
      if (term) q = q.or(`full_name.ilike.*${term}*,email.ilike.*${term}*,organization.ilike.*${term}*,role.ilike.*${term}*`);
    }
    const [profiles, facts] = await Promise.all([q.then(unwrap), authFacts()]);
    const users = profiles.map((p) => ({ ...p, auth: facts ? facts.get(p.user_id) || null : null, is_self: p.user_id === req.auth.user.id }));
    const counts = STATUSES.reduce((acc, s) => ({ ...acc, [s]: users.filter((u) => u.status === s).length }), {});
    res.json({ data: users, meta: { counts, auth_details_available: !!facts } });
  } catch (err) {
    next(err);
  }
});

async function setBan(userId, banned) {
  const { error } = await getAdminClient().auth.admin.updateUserById(userId, { ban_duration: banned ? '876000h' : 'none' });
  return error ? `Status saved, but Supabase Auth ban/unban failed: ${error.message}` : null;
}

function actionRoute(action, { needsReason = false, banAfter = null, roleFromBody = false } = {}) {
  return async (req, res, next) => {
    try {
      const { db } = req.auth;
      const id = assertUuid(req.params.userId, 'userId');
      const reason = sanitizeText(req.body?.reason, 500);
      if (needsReason && !reason) throw E.validation('A reason is required.');
      let role = null;
      if (roleFromBody && req.body?.role !== undefined) {
        role = String(req.body.role).toUpperCase();
        if (!ROLES.includes(role)) throw E.validation('role must be ADMIN or BFAR_STAFF.');
      }
      const row = unwrap(await db.rpc('admin_set_user_access', { p_user_id: id, p_action: action, p_role: role, p_reason: reason }));
      const warning = banAfter === null ? null : await setBan(id, banAfter);
      res.json({ data: row, meta: warning ? { warning } : {} });
    } catch (err) {
      next(err);
    }
  };
}

// Approve a pending request (optionally choose role: { role: 'BFAR_STAFF' | 'ADMIN' })
router.post('/:userId/approve', actionRoute('APPROVE', { banAfter: false, roleFromBody: true }));
router.post('/:userId/reject', actionRoute('REJECT', { needsReason: true, banAfter: true }));
router.post('/:userId/suspend', actionRoute('SUSPEND', { needsReason: true, banAfter: true }));
router.post('/:userId/reactivate', actionRoute('REACTIVATE', { banAfter: false, roleFromBody: true }));
router.post('/:userId/revoke', actionRoute('REVOKE', { needsReason: true, banAfter: true }));
router.post('/:userId/role', (req, res, next) => {
  if (!req.body?.role) return next(E.validation('role is required.'));
  return actionRoute('CHANGE_ROLE', { roleFromBody: true })(req, res, next);
});

/** PATCH /api/users/:userId { full_name?, organization?, position? } */
router.patch('/:userId', async (req, res, next) => {
  try {
    const { db } = req.auth;
    const id = assertUuid(req.params.userId, 'userId');
    const row = unwrap(await db.rpc('admin_update_user_details', {
      p_user_id: id, p_full_name: sanitizeText(req.body?.full_name, 120),
      p_organization: sanitizeText(req.body?.organization, 160), p_position: sanitizeText(req.body?.position, 120),
    }));
    res.json({ data: row });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/users/invite { email, full_name, organization, position?, role }
 * Sends a Supabase invitation email (the person sets their own password),
 * then approves the new profile with the chosen role. Requires SMTP to be
 * configured in Supabase for real emails.
 */
router.post('/invite', async (req, res, next) => {
  try {
    const { db } = req.auth;
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw E.validation('Enter a valid email address.');
    const fullName = sanitizeText(req.body?.full_name, 120);
    const organization = sanitizeText(req.body?.organization, 160);
    const position = sanitizeText(req.body?.position, 120);
    const role = String(req.body?.role || 'BFAR_STAFF').toUpperCase();
    if (!fullName) throw E.validation('Full name is required.');
    if (!ROLES.includes(role)) throw E.validation('role must be ADMIN or BFAR_STAFF.');

    const { data, error } = await getAdminClient().auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName, organization, position },
      redirectTo: `${config.publicSiteUrl}/set-password.html`,
    });
    if (error) {
      if (isNetworkError(error)) throw E.supabaseUnavailable();
      if (/already been registered|already exists/i.test(error.message)) throw E.conflict('EMAIL_ALREADY_REGISTERED', 'That email already has an account. Find it in the directory instead.');
      throw E.validation(`Supabase could not send the invitation: ${error.message}`);
    }
    const row = unwrap(await db.rpc('admin_set_user_access', { p_user_id: data.user.id, p_action: 'APPROVE', p_role: role, p_reason: 'Invited by administrator' }));
    res.status(201).json({ data: row, meta: { invitation_sent_to: email } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
