-- =====================================================================
-- AquaCast 006: alert delivery tracking (did each phone really receive the alert?)
--   * alert_dispatches - one row per alert sent (risk, no-data, escalation, test)
--   * alert_deliveries - one row per phone the alert was pushed to; CONFIRMED when the phone
--                        reported that it displayed the notification
--   * one escalation per unacknowledged Critical alert
-- Run once in Supabase -> SQL Editor (after 001-005). Safe to re-run.
-- If an earlier version of 006 (with SMS) was run, this also removes the SMS parts.
-- Access-layer tables only; the 12 research relations (LS-1.0) are unchanged.
-- Only the backend (service_role) reads or writes these tables.
-- =====================================================================

create table if not exists public.alert_dispatches (
  dispatch_id  uuid primary key,
  kind         text not null check (kind in ('RISK', 'STALE', 'RECOVERY', 'ESCALATION', 'TEST')),
  level        text not null check (level in ('WARNING', 'CRITICAL', 'INFO')),
  title        text not null,
  created_at   timestamptz not null default now()
);
create index if not exists ix_dispatch_created on public.alert_dispatches (created_at desc);
alter table public.alert_dispatches enable row level security;
revoke all on public.alert_dispatches from anon, authenticated;
grant select, insert, update, delete on public.alert_dispatches to service_role;

create table if not exists public.alert_deliveries (
  delivery_id     uuid primary key,
  dispatch_id     uuid not null references public.alert_dispatches(dispatch_id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  subscription_id uuid,
  status          text not null check (status in ('SENT', 'FAILED', 'CONFIRMED')),
  detail          text,
  created_at      timestamptz not null default now(),
  confirmed_at    timestamptz
);
create index if not exists ix_delivery_dispatch on public.alert_deliveries (dispatch_id);
create index if not exists ix_delivery_created on public.alert_deliveries (created_at desc);
alter table public.alert_deliveries enable row level security;
revoke all on public.alert_deliveries from anon, authenticated;
grant select, insert, update, delete on public.alert_deliveries to service_role;

-- clean-up of the earlier SMS version of this migration (does nothing on a fresh install)
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'alert_deliveries' and column_name = 'channel') then
    execute 'delete from public.alert_deliveries where channel = ''SMS''';
    execute 'drop index if exists public.uq_delivery_sms_once';
    execute 'alter table public.alert_deliveries drop column channel';
    delete from public.alert_dispatches where kind = 'TEST' and title = 'SMS check';
  end if;
end $$;
alter table public.alert_dispatches drop column if exists sms_text;
alter table public.alert_dispatches drop column if exists sms_fallback;
alter table public.alert_dispatches drop column if exists fallback_checked_at;
drop table if exists public.alert_contacts;
delete from public.dashboard_settings where setting_key = 'sms_backup';

-- one escalation per unacknowledged Critical alert
create unique index if not exists uq_audit_alert_escalated
  on public.dashboard_audit_log (target_id) where action = 'ALERT_ESCALATED';
