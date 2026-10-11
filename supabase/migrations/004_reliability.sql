-- =====================================================================
-- AquaCast 004: reliability layer for the dashboard
--   * app_rate_limits     - login / sign-up attempt counters shared by every server instance
--   * app_error_log       - server and browser errors, readable by Admins in System Settings
--   * dashboard_settings  - small dashboard switches (calibration mode)
--   * one "data stopped" phone alert per outage (unique index on the audit log)
-- Run once in Supabase -> SQL Editor (after 001-003). Safe to re-run.
-- Access-layer tables only; the 12 research relations (LS-1.0) are unchanged.
-- =====================================================================

-- ---------- shared rate limiting (Vercel runs many short-lived server copies) ----------
create table if not exists public.app_rate_limits (
  bucket_key   text primary key,          -- sha256 of "purpose:ip:email", never the raw values
  hits         integer not null,
  window_reset timestamptz not null
);
alter table public.app_rate_limits enable row level security;
revoke all on public.app_rate_limits from anon, authenticated;
grant select, insert, update, delete on public.app_rate_limits to service_role;

create or replace function public.app_rate_limit_hit(p_key text, p_window_seconds integer, p_max integer)
returns table (allowed boolean, retry_after integer)
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.app_rate_limits;
begin
  insert into public.app_rate_limits as t (bucket_key, hits, window_reset)
  values (p_key, 1, now() + make_interval(secs => p_window_seconds))
  on conflict (bucket_key) do update
    set hits = case when t.window_reset <= now() then 1 else t.hits + 1 end,
        window_reset = case when t.window_reset <= now() then now() + make_interval(secs => p_window_seconds) else t.window_reset end
  returning * into r;
  if random() < 0.02 then
    delete from public.app_rate_limits where window_reset < now() - interval '1 day';
  end if;
  return query select r.hits <= p_max, greatest(0, ceil(extract(epoch from (r.window_reset - now())))::integer);
end $$;
revoke all on function public.app_rate_limit_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.app_rate_limit_hit(text, integer, integer) to service_role;

-- ---------- error log ----------
create table if not exists public.app_error_log (
  error_id   uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  source     text not null check (source in ('SERVER', 'BROWSER')),
  message    text not null,
  detail     text,
  path       text,
  user_id    uuid,
  user_agent text
);
create index if not exists ix_error_log_created on public.app_error_log (created_at desc);
alter table public.app_error_log enable row level security;
revoke all on public.app_error_log from anon, authenticated;
grant select, insert, delete on public.app_error_log to service_role;

-- ---------- dashboard switches ----------
create table if not exists public.dashboard_settings (
  setting_key text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
insert into public.dashboard_settings (setting_key, value)
values ('calibration_mode', '{"enabled": false}'::jsonb)
on conflict (setting_key) do nothing;
alter table public.dashboard_settings enable row level security;
revoke all on public.dashboard_settings from anon, authenticated;
grant select on public.dashboard_settings to authenticated;
grant select, insert, update on public.dashboard_settings to service_role;
drop policy if exists active_users_read on public.dashboard_settings;
create policy active_users_read on public.dashboard_settings for select to authenticated using (public.app_is_active());

-- ---------- one "data stopped" alert per outage ----------
create unique index if not exists uq_audit_push_stale
  on public.dashboard_audit_log (target_id) where action = 'PUSH_STALE_SENT';
