-- =====================================================================
-- AquaCast 003: phone / browser push notifications for risk alerts
-- Run once in Supabase -> SQL Editor (after 001 and 002). Safe to re-run.
-- Adds ONE access-layer table outside the 12 research relations (LS-1.0 counts unchanged).
-- Only the backend (service_role) reads or writes it; browsers never see other users' rows.
-- =====================================================================
create table if not exists public.push_subscriptions (
  subscription_id uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  endpoint       text not null unique,
  p256dh         text not null,
  auth_secret    text not null,
  user_agent     text,
  created_at     timestamptz not null default now(),
  last_success_at timestamptz,
  last_error     text
);
create index if not exists ix_push_user on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;
grant select, insert, update, delete on public.push_subscriptions to service_role;
-- no policies for anon/authenticated: only the server (service_role) can use this table

-- Each risk cycle is pushed at most once, even when the Supabase webhook and the simulator
-- react to the same new reading at the same moment (the first one to claim it wins).
create unique index if not exists uq_audit_push_risk
  on public.dashboard_audit_log (target_id) where action = 'PUSH_RISK_SENT';
