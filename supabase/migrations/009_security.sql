-- =====================================================================
-- 009: privacy between users
-- The audit log also records account administration (approvals, suspensions with their reasons,
-- role changes, profile and password changes). Until now every active user could read all of it,
-- and the Activity Log showed it to everyone. From now on:
--   * Administrators read the whole audit log (unchanged).
--   * Other active users read only pond-operation records: alert acknowledgements and test alerts,
--     pond activities, aerator requests and mode changes, calibration mode and study settings.
-- The Activity Log, Alerts and Live Status keep working for everyone; account administration
-- events simply no longer appear for non-admins.
-- Run once in Supabase -> SQL Editor. Safe to re-run.
-- =====================================================================

drop policy if exists active_users_read on public.dashboard_audit_log;
drop policy if exists admins_read_all on public.dashboard_audit_log;
drop policy if exists users_read_operations on public.dashboard_audit_log;

create policy admins_read_all on public.dashboard_audit_log for select to authenticated
  using (public.app_is_admin());

create policy users_read_operations on public.dashboard_audit_log for select to authenticated
  using (public.app_is_active() and action in (
    'ALERT_ACKNOWLEDGED', 'ALERT_TEST_BROADCAST', 'ALERT_ESCALATED',
    'MANAGEMENT_EVENT_RECORDED', 'MANAGEMENT_EVENT_CLOSED',
    'AERATOR_COMMAND_REQUESTED', 'AERATOR_MODE_REQUESTED',
    'CALIBRATION_MODE_CHANGED', 'STUDY_METADATA_UPDATED'));

-- Nobody signs in to the database directly: the dashboard server talks to Supabase for them.
-- Make sure the public (anon) role cannot read any AquaCast table or view, even if a grant was added by hand.
do $$
declare t record;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'v', 'm') loop
    execute format('revoke all on public.%I from anon', t.relname);
  end loop;
end $$;
