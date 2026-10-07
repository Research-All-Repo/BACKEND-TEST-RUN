-- =====================================================================
-- AquaCast | 002_dashboard_access.sql
-- Dashboard access-control layer on top of the 12 PD-1.0 relations.
--
-- Adds (application/security layer, NOT part of the 12 frozen research
-- relations, so LS-1.0 table/attribute counts are unchanged):
--   * user_access_profiles  - role + approval status per Supabase Auth user
--   * dashboard_audit_log   - who did what from the dashboard
--   * Row Level Security on every table (read = ACTIVE users only)
--   * Secured RPCs: aerator command/mode requests, activity logging,
--     alert acknowledgement, user administration, study metadata edits
--   * Views for the activity feed and model evaluation
--
-- Writes from the dashboard happen ONLY through the RPCs below. The
-- Raspberry Pi / edge sync uses the service-role key and bypasses RLS.
-- Safe to re-run.
-- =====================================================================

set client_min_messages = warning;
begin;

-- ---------------------------------------------------------------------
-- 1. Access tables
-- ---------------------------------------------------------------------
create table if not exists public.user_access_profiles (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  email          text not null,
  full_name      text not null default '',
  organization   text,
  position       text,
  role           text not null default 'BFAR_STAFF',
  status         text not null default 'PENDING',
  requested_role text not null default 'BFAR_STAFF',
  status_reason  text,
  reviewed_by    uuid,
  reviewed_at    timestamptz,
  last_login_at  timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint chk_access_role   check (role in ('ADMIN','BFAR_STAFF')),
  constraint chk_access_req    check (requested_role in ('ADMIN','BFAR_STAFF')),
  constraint chk_access_status check (status in ('PENDING','ACTIVE','SUSPENDED','REVOKED'))
);
create index if not exists ix_access_status on public.user_access_profiles (status);
create unique index if not exists uq_access_email on public.user_access_profiles (lower(email));

create table if not exists public.dashboard_audit_log (
  audit_id       uuid primary key default gen_random_uuid(),
  actor_user_id  uuid,
  action         text not null,
  target_table   text,
  target_id      text,
  details        jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index if not exists ix_audit_created on public.dashboard_audit_log (created_at desc);
create index if not exists ix_audit_target  on public.dashboard_audit_log (target_table, target_id);
create unique index if not exists uq_audit_alert_ack
  on public.dashboard_audit_log (target_id) where action = 'ALERT_ACKNOWLEDGED';

-- ---------------------------------------------------------------------
-- 2. Every new Supabase Auth user gets a PENDING BFAR_STAFF profile.
--    Role/status are never taken from client-supplied metadata.
-- ---------------------------------------------------------------------
create or replace function public.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.user_access_profiles (user_id, email, full_name, organization, position)
  values (new.id, coalesce(new.email, ''),
          left(coalesce(new.raw_user_meta_data->>'full_name', ''), 120),
          left(new.raw_user_meta_data->>'organization', 160),
          left(new.raw_user_meta_data->>'position', 120))
  on conflict (user_id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_auth_user();

create or replace function public.handle_auth_user_email_change() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.user_access_profiles set email = coalesce(new.email, email), updated_at = now()
  where user_id = new.id and email is distinct from new.email;
  return new;
end $$;
drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed after update of email on auth.users
  for each row execute function public.handle_auth_user_email_change();

-- ---------------------------------------------------------------------
-- 3. Helpers used by RLS and RPCs
-- ---------------------------------------------------------------------
create or replace function public.app_is_active() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.user_access_profiles
                 where user_id = auth.uid() and status = 'ACTIVE');
$$;

create or replace function public.app_is_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.user_access_profiles
                 where user_id = auth.uid() and status = 'ACTIVE' and role = 'ADMIN');
$$;

-- Raises a clean, machine-readable error the API maps to HTTP status codes.
create or replace function public.app_require_active(p_admin boolean default false)
returns public.user_access_profiles
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p public.user_access_profiles;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000', hint = 'No authenticated user in request';
  end if;
  select * into p from public.user_access_profiles where user_id = auth.uid();
  if not found or p.status <> 'ACTIVE' then
    raise exception 'ACCOUNT_NOT_ACTIVE' using errcode = '42501', hint = coalesce(p.status, 'NO_PROFILE');
  end if;
  if p_admin and p.role <> 'ADMIN' then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  return p;
end $$;

-- ---------------------------------------------------------------------
-- 4. Row Level Security
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['raw_observations','system_health','forecast_models','forecasts','risk_assessments',
                           'study_metadata','biomass_records','sensor_registry','sensor_calibrations',
                           'aerator_control_settings','aerator_commands','management_events',
                           'user_access_profiles','dashboard_audit_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
    -- the edge sync / backend admin client uses service_role (bypasses RLS); make its grants explicit
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
  -- read access for ACTIVE dashboard users on the 12 research relations
  foreach t in array array['raw_observations','system_health','forecast_models','forecasts','risk_assessments',
                           'study_metadata','biomass_records','sensor_registry','sensor_calibrations',
                           'aerator_control_settings','aerator_commands','management_events'] loop
    execute format('drop policy if exists active_users_read on public.%I', t);
    execute format('create policy active_users_read on public.%I for select to authenticated using (public.app_is_active())', t);
  end loop;
end $$;

drop policy if exists own_or_admin_read on public.user_access_profiles;
create policy own_or_admin_read on public.user_access_profiles for select to authenticated
  using (user_id = auth.uid() or public.app_is_admin());

drop policy if exists active_users_read on public.dashboard_audit_log;
create policy active_users_read on public.dashboard_audit_log for select to authenticated
  using (public.app_is_active());

-- Display name for activity records (no email, no status); only for ACTIVE callers.
drop view if exists public.directory_names cascade;
create or replace function public.app_display_name(p_user_id uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select full_name from public.user_access_profiles where user_id = p_user_id and public.app_is_active();
$$;
revoke execute on function public.app_display_name(uuid) from public, anon;
grant execute on function public.app_display_name(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Aerator RPCs - the dashboard only REQUESTS; the Pi validates/applies
-- ---------------------------------------------------------------------
create or replace function public.request_aerator_command(
  p_command_id uuid, p_requested_state text, p_expires_in_seconds integer default 120)
returns public.aerator_commands
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.user_access_profiles; s public.aerator_control_settings; c public.aerator_commands;
begin
  me := public.app_require_active(false);
  if p_requested_state not in ('ON','OFF') then
    raise exception 'INVALID_STATE' using errcode = '22023';
  end if;
  if p_expires_in_seconds is null or p_expires_in_seconds < 30 or p_expires_in_seconds > 600 then
    raise exception 'INVALID_EXPIRY' using errcode = '22023', hint = 'Expiry must be 30-600 seconds';
  end if;

  -- idempotent retry: same command id from the same requester returns the stored row
  select * into c from public.aerator_commands where command_id = p_command_id;
  if found then
    if c.requested_by_user_id = me.user_id::text and c.requested_state = p_requested_state then
      return c;
    end if;
    raise exception 'COMMAND_ID_CONFLICT' using errcode = '23505';
  end if;

  select * into s from public.aerator_control_settings where singleton_slot = 1 for update;
  if not found then
    raise exception 'AERATOR_NOT_INITIALIZED' using errcode = 'P0002';
  end if;
  if s.requested_mode <> 'MANUAL' or s.applied_mode <> 'MANUAL' then
    raise exception 'AERATOR_NOT_IN_MANUAL_MODE' using errcode = '55000',
      hint = format('requested_mode=%s applied_mode=%s', s.requested_mode, s.applied_mode);
  end if;
  if exists (select 1 from public.aerator_commands
             where command_source = 'MANUAL_DASHBOARD' and command_status = 'PENDING' and expires_at_utc > now()) then
    raise exception 'AERATOR_COMMAND_ALREADY_PENDING' using errcode = '55000';
  end if;

  insert into public.aerator_commands (command_id, requested_state, command_source, requested_by_user_id,
    requested_at_utc, expires_at_utc, command_status, applied_at_utc, status_updated_at_utc, failure_reason, sync_status)
  values (p_command_id, p_requested_state, 'MANUAL_DASHBOARD', me.user_id::text,
    now(), now() + make_interval(secs => p_expires_in_seconds), 'PENDING', null, now(), null, null)
  returning * into c;

  insert into public.dashboard_audit_log (actor_user_id, action, target_table, target_id, details)
  values (me.user_id, 'AERATOR_COMMAND_REQUESTED', 'aerator_commands', c.command_id::text,
          jsonb_build_object('requested_state', p_requested_state, 'expires_at_utc', c.expires_at_utc));
  return c;
end $$;

create or replace function public.request_aerator_mode(p_mode text, p_automatic_rule_version text default null)
returns public.aerator_control_settings
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.user_access_profiles; s public.aerator_control_settings;
begin
  me := public.app_require_active(true);
  if p_mode not in ('MANUAL','AUTOMATIC') then
    raise exception 'INVALID_MODE' using errcode = '22023';
  end if;
  if p_mode = 'AUTOMATIC' and coalesce(trim(p_automatic_rule_version), '') = '' then
    raise exception 'AUTOMATIC_RULE_VERSION_REQUIRED' using errcode = '22023';
  end if;
  update public.aerator_control_settings
     set requested_mode = p_mode,
         automatic_rule_version = case when p_mode = 'AUTOMATIC' then trim(p_automatic_rule_version) else automatic_rule_version end,
         settings_revision = settings_revision + 1,
         mode_requested_at_utc = now(),
         updated_by_user_id = me.user_id::text
   where singleton_slot = 1
   returning * into s;
  if not found then
    raise exception 'AERATOR_NOT_INITIALIZED' using errcode = 'P0002';
  end if;
  insert into public.dashboard_audit_log (actor_user_id, action, target_table, target_id, details)
  values (me.user_id, 'AERATOR_MODE_REQUESTED', 'aerator_control_settings', s.settings_id::text,
          jsonb_build_object('requested_mode', p_mode, 'settings_revision', s.settings_revision,
                             'automatic_rule_version', s.automatic_rule_version));
  return s;
end $$;

-- ---------------------------------------------------------------------
-- 6. Pond activity logging (BFAR_STAFF + ADMIN)
-- ---------------------------------------------------------------------
create or replace function public.record_management_event(
  p_event_id uuid, p_event_type text, p_event_start_utc timestamptz,
  p_event_end_utc timestamptz default null, p_reason text default null,
  p_notes text default null, p_related_risk_id uuid default null)
returns public.management_events
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.user_access_profiles; e public.management_events;
begin
  me := public.app_require_active(false);
  select * into e from public.management_events where event_id = p_event_id;
  if found then
    return e;  -- idempotent retry
  end if;
  if p_event_type not in ('FEEDING','AERATION','WATER_EXCHANGE','POND_CLEANING','FISH_STOCKING',
                          'FISH_HARVEST','SENSOR_MAINTENANCE','POWER_MAINTENANCE','OTHER') then
    raise exception 'INVALID_EVENT_TYPE' using errcode = '22023';
  end if;
  if p_event_start_utc is null or p_event_start_utc > now() + interval '5 minutes' then
    raise exception 'INVALID_EVENT_TIME' using errcode = '22023', hint = 'Start time is required and cannot be in the future';
  end if;
  if p_event_end_utc is not null and (p_event_end_utc < p_event_start_utc or p_event_end_utc > now() + interval '5 minutes') then
    raise exception 'INVALID_EVENT_TIME' using errcode = '22023', hint = 'End must be after start and not in the future';
  end if;
  if p_event_type = 'AERATION' and p_event_end_utc is null then
    -- open aeration sessions belong to the controller (command-driven); manual entries must be closed intervals
    raise exception 'MANUAL_AERATION_NEEDS_END_TIME' using errcode = '22023';
  end if;
  if p_event_type = 'OTHER' and coalesce(trim(p_notes), '') = '' then
    raise exception 'NOTES_REQUIRED_FOR_OTHER' using errcode = '22023';
  end if;

  insert into public.management_events (event_id, event_type, event_start_utc, event_end_utc, reason,
    related_risk_id, related_command_id, stop_command_id, notes, recorded_at_utc, sync_status)
  values (p_event_id, p_event_type, p_event_start_utc, p_event_end_utc, nullif(trim(p_reason), ''),
    p_related_risk_id, null, null, nullif(trim(p_notes), ''), now(), 'SYNCED')
  returning * into e;

  insert into public.dashboard_audit_log (actor_user_id, action, target_table, target_id, details)
  values (me.user_id, 'MANAGEMENT_EVENT_RECORDED', 'management_events', e.event_id::text,
          jsonb_build_object('event_type', e.event_type));
  return e;
end $$;

create or replace function public.close_management_event(p_event_id uuid, p_event_end_utc timestamptz)
returns public.management_events
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.user_access_profiles; e public.management_events; author uuid;
begin
  me := public.app_require_active(false);
  select * into e from public.management_events where event_id = p_event_id for update;
  if not found then raise exception 'EVENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if e.related_command_id is not null or e.stop_command_id is not null then
    raise exception 'CONTROLLER_EVENT_READ_ONLY' using errcode = '42501';
  end if;
  if e.event_end_utc is not null then raise exception 'EVENT_ALREADY_CLOSED' using errcode = '55000'; end if;
  select actor_user_id into author from public.dashboard_audit_log
   where action = 'MANAGEMENT_EVENT_RECORDED' and target_id = p_event_id::text limit 1;
  if author is distinct from me.user_id and me.role <> 'ADMIN' then
    raise exception 'NOT_EVENT_AUTHOR' using errcode = '42501';
  end if;
  if p_event_end_utc < e.event_start_utc or p_event_end_utc > now() + interval '5 minutes' then
    raise exception 'INVALID_EVENT_TIME' using errcode = '22023';
  end if;
  update public.management_events set event_end_utc = p_event_end_utc where event_id = p_event_id returning * into e;
  insert into public.dashboard_audit_log (actor_user_id, action, target_table, target_id, details)
  values (me.user_id, 'MANAGEMENT_EVENT_CLOSED', 'management_events', e.event_id::text,
          jsonb_build_object('event_end_utc', p_event_end_utc));
  return e;
end $$;

-- ---------------------------------------------------------------------
-- 7. Alert acknowledgement (alerts = WATCH/WARNING/CRITICAL risk rows)
-- ---------------------------------------------------------------------
create or replace function public.acknowledge_alert(p_risk_id uuid, p_note text default null)
returns public.dashboard_audit_log
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.user_access_profiles; a public.dashboard_audit_log;
begin
  me := public.app_require_active(false);
  if not exists (select 1 from public.risk_assessments where risk_id = p_risk_id) then
    raise exception 'ALERT_NOT_FOUND' using errcode = 'P0002';
  end if;
  insert into public.dashboard_audit_log (actor_user_id, action, target_table, target_id, details)
  values (me.user_id, 'ALERT_ACKNOWLEDGED', 'risk_assessments', p_risk_id::text,
          jsonb_build_object('note', left(nullif(trim(p_note), ''), 500)))
  on conflict (target_id) where action = 'ALERT_ACKNOWLEDGED' do nothing
  returning * into a;
  if a.audit_id is null then
    raise exception 'ALERT_ALREADY_ACKNOWLEDGED' using errcode = '55000';
  end if;
  return a;
end $$;

-- ---------------------------------------------------------------------
-- 8. User administration (ADMIN only)
-- ---------------------------------------------------------------------
create or replace function public.admin_set_user_access(
  p_user_id uuid, p_action text, p_role text default null, p_reason text default null)
returns public.user_access_profiles
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.user_access_profiles; t public.user_access_profiles; before_row jsonb;
        new_status text; new_role text;
begin
  me := public.app_require_active(true);
  if p_user_id = me.user_id then
    raise exception 'CANNOT_MODIFY_SELF' using errcode = '42501';
  end if;
  select * into t from public.user_access_profiles where user_id = p_user_id for update;
  if not found then raise exception 'USER_NOT_FOUND' using errcode = 'P0002'; end if;
  before_row := jsonb_build_object('status', t.status, 'role', t.role);
  if p_role is not null and p_role not in ('ADMIN','BFAR_STAFF') then
    raise exception 'INVALID_ROLE' using errcode = '22023';
  end if;
  new_role := coalesce(p_role, t.role);

  case p_action
    when 'APPROVE'    then if t.status <> 'PENDING'   then raise exception 'INVALID_TRANSITION' using errcode = '55000'; end if; new_status := 'ACTIVE';
    when 'REJECT'     then if t.status <> 'PENDING'   then raise exception 'INVALID_TRANSITION' using errcode = '55000'; end if; new_status := 'REVOKED';
    when 'SUSPEND'    then if t.status <> 'ACTIVE'    then raise exception 'INVALID_TRANSITION' using errcode = '55000'; end if; new_status := 'SUSPENDED'; new_role := t.role;
    when 'REACTIVATE' then if t.status <> 'SUSPENDED' then raise exception 'INVALID_TRANSITION' using errcode = '55000'; end if; new_status := 'ACTIVE';
    when 'REVOKE'     then if t.status = 'REVOKED'    then raise exception 'INVALID_TRANSITION' using errcode = '55000'; end if; new_status := 'REVOKED'; new_role := t.role;
    when 'CHANGE_ROLE' then
      if t.status not in ('ACTIVE','SUSPENDED','PENDING') or p_role is null then raise exception 'INVALID_TRANSITION' using errcode = '55000'; end if;
      new_status := t.status;
    else raise exception 'INVALID_ACTION' using errcode = '22023';
  end case;

  -- never leave the system without an active administrator
  if t.role = 'ADMIN' and t.status = 'ACTIVE' and (new_status <> 'ACTIVE' or new_role <> 'ADMIN')
     and (select count(*) from public.user_access_profiles where role = 'ADMIN' and status = 'ACTIVE') <= 1 then
    raise exception 'LAST_ACTIVE_ADMIN' using errcode = '55000';
  end if;
  if p_action in ('SUSPEND','REVOKE','REJECT') and coalesce(trim(p_reason), '') = '' then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;

  update public.user_access_profiles
     set status = new_status, role = new_role, status_reason = nullif(trim(p_reason), ''),
         reviewed_by = me.user_id, reviewed_at = now(), updated_at = now()
   where user_id = p_user_id returning * into t;

  insert into public.dashboard_audit_log (actor_user_id, action, target_table, target_id, details)
  values (me.user_id, 'USER_ACCESS_' || p_action, 'user_access_profiles', p_user_id::text,
          jsonb_build_object('before', before_row, 'after', jsonb_build_object('status', t.status, 'role', t.role),
                             'reason', nullif(trim(p_reason), '')));
  return t;
end $$;

create or replace function public.admin_update_user_details(
  p_user_id uuid, p_full_name text default null, p_organization text default null, p_position text default null)
returns public.user_access_profiles
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.user_access_profiles; t public.user_access_profiles;
begin
  me := public.app_require_active(true);
  update public.user_access_profiles
     set full_name = coalesce(left(nullif(trim(p_full_name), ''), 120), full_name),
         organization = coalesce(left(nullif(trim(p_organization), ''), 160), organization),
         position = coalesce(left(nullif(trim(p_position), ''), 120), position),
         updated_at = now()
   where user_id = p_user_id returning * into t;
  if not found then raise exception 'USER_NOT_FOUND' using errcode = 'P0002'; end if;
  insert into public.dashboard_audit_log (actor_user_id, action, target_table, target_id, details)
  values (me.user_id, 'USER_DETAILS_UPDATED', 'user_access_profiles', p_user_id::text,
          jsonb_build_object('full_name', t.full_name, 'organization', t.organization, 'position', t.position));
  return t;
end $$;

create or replace function public.touch_last_login() returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.user_access_profiles set last_login_at = now() where user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------
-- 9. Study metadata edits (ADMIN only, audited, only fields that exist in LS-1.0)
-- ---------------------------------------------------------------------
create or replace function public.update_study_metadata(p_study_id uuid, p_patch jsonb)
returns public.study_metadata
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.user_access_profiles; s public.study_metadata; before_row jsonb; k text;
begin
  me := public.app_require_active(true);
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('site_description','culture_species','culture_stage','culture_system','timezone','notes',
                 'pond_length_m','pond_width_m','pond_depth_m','probe_depth_m','deployment_end_utc') then
      raise exception 'FIELD_NOT_EDITABLE' using errcode = '22023', hint = k;
    end if;
  end loop;
  if p_patch ? 'timezone' and not exists (select 1 from pg_timezone_names where name = p_patch->>'timezone') then
    raise exception 'INVALID_TIMEZONE' using errcode = '22023';
  end if;
  select to_jsonb(x) into before_row from public.study_metadata x where study_id = p_study_id;
  if before_row is null then raise exception 'STUDY_NOT_FOUND' using errcode = 'P0002'; end if;

  update public.study_metadata set
    site_description   = case when p_patch ? 'site_description' then p_patch->>'site_description' else site_description end,
    culture_species    = case when p_patch ? 'culture_species'  then p_patch->>'culture_species'  else culture_species end,
    culture_stage      = case when p_patch ? 'culture_stage'    then p_patch->>'culture_stage'    else culture_stage end,
    culture_system     = case when p_patch ? 'culture_system'   then p_patch->>'culture_system'   else culture_system end,
    timezone           = case when p_patch ? 'timezone'         then p_patch->>'timezone'         else timezone end,
    notes              = case when p_patch ? 'notes'            then nullif(p_patch->>'notes', '') else notes end,
    pond_length_m      = case when p_patch ? 'pond_length_m'    then (p_patch->>'pond_length_m')::double precision else pond_length_m end,
    pond_width_m       = case when p_patch ? 'pond_width_m'     then (p_patch->>'pond_width_m')::double precision  else pond_width_m end,
    pond_depth_m       = case when p_patch ? 'pond_depth_m'     then (p_patch->>'pond_depth_m')::double precision  else pond_depth_m end,
    probe_depth_m      = case when p_patch ? 'probe_depth_m'    then (p_patch->>'probe_depth_m')::double precision else probe_depth_m end,
    deployment_end_utc = case when p_patch ? 'deployment_end_utc' then nullif(p_patch->>'deployment_end_utc', '')::timestamptz else deployment_end_utc end
  where study_id = p_study_id returning * into s;

  insert into public.dashboard_audit_log (actor_user_id, action, target_table, target_id, details)
  values (me.user_id, 'STUDY_METADATA_UPDATED', 'study_metadata', p_study_id::text,
          jsonb_build_object('changed', p_patch, 'before', before_row));
  return s;
end $$;

-- ---------------------------------------------------------------------
-- 10. Views
-- ---------------------------------------------------------------------
-- Unified activity feed: pond activities, aerator commands, system warnings, admin actions
create or replace view public.activity_feed with (security_invoker = true) as
select 'EVT-' || e.event_id::text                 as activity_id,
       case when e.event_type = 'AERATION' then 'AERATION' when e.event_type in ('SENSOR_MAINTENANCE','POWER_MAINTENANCE') then 'MAINTENANCE' else 'POND_ACTIVITY' end as category,
       e.event_start_utc                          as occurred_at,
       e.event_type                               as event_type,
       e.event_end_utc                            as ended_at,
       coalesce(e.notes, e.reason, '')            as details,
       case when e.related_command_id is not null then 'Controller acknowledgement'
            when a.actor_user_id is not null then 'Operator entry' else 'Edge / field record' end as source,
       public.app_display_name(a.actor_user_id)   as actor_name,
       'management_events'                        as ref_table,
       e.event_id::text                           as ref_id
from public.management_events e
left join public.dashboard_audit_log a on a.action = 'MANAGEMENT_EVENT_RECORDED' and a.target_id = e.event_id::text
union all
select 'CMD-' || c.command_id::text, 'AERATOR_COMMAND', c.requested_at_utc,
       'AERATOR_' || c.requested_state || '_REQUEST', c.status_updated_at_utc,
       'Status: ' || c.command_status || coalesce(' - ' || c.failure_reason, ''),
       case when c.command_source = 'MANUAL_DASHBOARD' then 'Dashboard command' else 'Automatic local control' end,
       coalesce(case when c.requested_by_user_id ~* '^[0-9a-f-]{36}$' then public.app_display_name(c.requested_by_user_id::uuid) end,
                case when c.command_source = 'AUTOMATIC_LOCAL' then 'AquaCast automatic control' end),
       'aerator_commands', c.command_id::text
from public.aerator_commands c
union all
select 'RISK-' || r.risk_id::text, 'SYSTEM_WARNING', r.assessment_timestamp_utc,
       'RISK_' || r.current_risk_state, null,
       'Risk ' || r.current_risk_state || ', outlook ' || r.forecast_outlook ||
         coalesce(', crossing expected ' || to_char(r.expected_threshold_crossing_utc at time zone 'UTC', 'YYYY-MM-DD HH24:MI "UTC"'), ''),
       'AquaCast risk engine (' || r.rule_version || ')', 'AquaCast System', 'risk_assessments', r.risk_id::text
from public.risk_assessments r
where r.current_risk_state in ('WARNING','CRITICAL')
union all
select 'AUD-' || l.audit_id::text,
       case when l.action like 'USER_%' then 'USER_MANAGEMENT' when l.action like 'ALERT_%' then 'ALERT' else 'SETTINGS' end,
       l.created_at, l.action, null,
       case
         when l.action like 'USER_ACCESS_%' then
           coalesce(public.app_display_name(l.target_id::uuid), 'User') || ': ' || coalesce(l.details->'before'->>'status', '?') || ' -> ' || coalesce(l.details->'after'->>'status', '?')
           || ', role ' || coalesce(l.details->'after'->>'role', '?') || coalesce(' (reason: ' || (l.details->>'reason') || ')', '')
         when l.action = 'USER_DETAILS_UPDATED' then 'Directory details updated for ' || coalesce(public.app_display_name(l.target_id::uuid), 'a user')
         when l.action = 'STUDY_METADATA_UPDATED' then
           'Changed: ' || coalesce((select string_agg(k || ' = ' || (l.details->'changed'->>k), ', ') from jsonb_object_keys(l.details->'changed') k), '-')
         when l.action = 'AERATOR_MODE_REQUESTED' then
           'Requested ' || (l.details->>'requested_mode') || ' mode (revision ' || (l.details->>'settings_revision') || ')'
         when l.action = 'ALERT_ACKNOWLEDGED' then 'Alert reviewed' || coalesce(': ' || (l.details->>'note'), '')
         when l.action = 'MANAGEMENT_EVENT_CLOSED' then 'Activity end time recorded'
         else l.details::text
       end,
       'Dashboard action', public.app_display_name(l.actor_user_id), l.target_table, l.target_id
from public.dashboard_audit_log l
where l.action not in ('MANAGEMENT_EVENT_RECORDED','AERATOR_COMMAND_REQUESTED');

revoke all on public.activity_feed from anon;
grant select on public.activity_feed to authenticated;

-- Operational forecast accuracy: VALID forecasts matched to the VALID observation at their target time
create or replace view public.forecast_evaluation with (security_invoker = true) as
with matched as (
  select f.horizon_minutes, f.model_id, f.predicted_do_mg_l as p, o.do_mg_l as y
  from public.forecasts f
  join public.raw_observations o on o.timestamp_utc = f.target_timestamp_utc and o.do_mg_l_status = 'VALID'
  where f.forecast_status = 'VALID'
)
select horizon_minutes,
       count(*)                                         as samples,
       avg(abs(p - y))                                  as mae,
       sqrt(avg((p - y) ^ 2))                           as rmse,
       avg(p - y)                                       as mean_bias,
       case when var_pop(y) > 0 then 1 - avg((p - y) ^ 2) / var_pop(y) end as r2
from matched group by horizon_minutes;
revoke all on public.forecast_evaluation from anon;
revoke all on public.forecast_details from anon;
grant select on public.forecast_details to authenticated;
grant select on public.forecast_evaluation to authenticated;

-- Alerts = the cycles where the official risk state CHANGED into WATCH/WARNING/CRITICAL
-- (one alert per episode instead of one per 10-minute cycle)
create or replace view public.risk_alerts with (security_invoker = true) as
with ordered as (
  select r.*, o.timestamp_utc as observation_timestamp_utc, o.do_mg_l, o.do_mg_l_status,
         lag(r.current_risk_state) over (order by o.timestamp_utc) as previous_risk_state
  from public.risk_assessments r
  join public.raw_observations o on o.observation_id = r.observation_id
)
select d.risk_id, d.observation_id, d.observation_timestamp_utc, d.assessment_timestamp_utc,
       d.current_risk_state, d.previous_risk_state, d.forecast_outlook, d.expected_threshold_crossing_utc,
       d.rule_version, d.do_mg_l, d.do_mg_l_status,
       case d.current_risk_state when 'CRITICAL' then 3 when 'WARNING' then 2 when 'WATCH' then 1 else 0 end as severity_rank,
       (select min(f.predicted_do_mg_l) from public.forecasts f
         where f.observation_id = d.observation_id and f.forecast_status = 'VALID') as min_forecast_do_mg_l,
       ack.created_at     as acknowledged_at,
       ack.actor_user_id  as acknowledged_by_user_id,
       public.app_display_name(ack.actor_user_id) as acknowledged_by_name,
       ack.details->>'note' as acknowledgement_note
from ordered d
left join public.dashboard_audit_log ack on ack.action = 'ALERT_ACKNOWLEDGED' and ack.target_id = d.risk_id::text
where d.current_risk_state in ('WATCH','WARNING','CRITICAL')
  and d.previous_risk_state is distinct from d.current_risk_state;
revoke all on public.risk_alerts from anon;
grant select on public.risk_alerts to authenticated;

-- Time-bucketed observation series for History & Trends charts (RLS applies: security invoker)
create or replace function public.get_observation_series(p_from timestamptz, p_to timestamptz, p_bucket_minutes integer)
returns table (bucket_start timestamptz, samples integer, do_mg_l double precision, do_min double precision,
               do_max double precision, water_temp_c double precision, ph_value double precision,
               light_lux double precision, air_temp_c double precision, relative_humidity_pct double precision,
               atmospheric_pressure_hpa double precision, worst_risk_state text)
language sql stable security invoker set search_path = public, pg_temp as $$
  select to_timestamp(floor(extract(epoch from o.timestamp_utc) / (greatest(p_bucket_minutes, 10) * 60)) * greatest(p_bucket_minutes, 10) * 60) as bucket_start,
         count(*)::int,
         avg(o.do_mg_l) filter (where o.do_mg_l_status = 'VALID'),
         min(o.do_mg_l) filter (where o.do_mg_l_status = 'VALID'),
         max(o.do_mg_l) filter (where o.do_mg_l_status = 'VALID'),
         avg(o.water_temp_c) filter (where o.water_temp_status = 'VALID'),
         avg(o.ph_value) filter (where o.ph_status = 'VALID'),
         avg(o.light_lux) filter (where o.light_status = 'VALID'),
         avg(o.air_temp_c) filter (where o.air_temp_status = 'VALID'),
         avg(o.relative_humidity_pct) filter (where o.humidity_status = 'VALID'),
         avg(o.atmospheric_pressure_hpa) filter (where o.pressure_status = 'VALID'),
         (array['NORMAL','WATCH','WARNING','CRITICAL'])[max(case r.current_risk_state when 'NORMAL' then 1 when 'WATCH' then 2
                                                                 when 'WARNING' then 3 when 'CRITICAL' then 4 end)]
  from public.raw_observations o
  left join public.risk_assessments r on r.observation_id = o.observation_id
  where o.timestamp_utc >= p_from and o.timestamp_utc < p_to
  group by 1 order by 1
  limit 5000;
$$;

create or replace function public.get_history_summary(p_from timestamptz, p_to timestamptz)
returns table (records integer, valid_do_records integer, avg_do double precision, min_do double precision,
               max_do double precision, first_do double precision, last_do double precision,
               elevated_risk_records integer, critical_records integer, first_timestamp timestamptz, last_timestamp timestamptz)
language sql stable security invoker set search_path = public, pg_temp as $$
  with o as (
    select o.*, r.current_risk_state from public.raw_observations o
    left join public.risk_assessments r on r.observation_id = o.observation_id
    where o.timestamp_utc >= p_from and o.timestamp_utc < p_to
  )
  select count(*)::int,
         count(*) filter (where do_mg_l_status = 'VALID')::int,
         avg(do_mg_l) filter (where do_mg_l_status = 'VALID'),
         min(do_mg_l) filter (where do_mg_l_status = 'VALID'),
         max(do_mg_l) filter (where do_mg_l_status = 'VALID'),
         (select do_mg_l from o where do_mg_l_status = 'VALID' order by timestamp_utc asc limit 1),
         (select do_mg_l from o where do_mg_l_status = 'VALID' order by timestamp_utc desc limit 1),
         count(*) filter (where current_risk_state in ('WATCH','WARNING','CRITICAL'))::int,
         count(*) filter (where current_risk_state = 'CRITICAL')::int,
         min(timestamp_utc), max(timestamp_utc)
  from o;
$$;

revoke execute on function public.get_observation_series(timestamptz, timestamptz, integer) from public, anon;
revoke execute on function public.get_history_summary(timestamptz, timestamptz) from public, anon;
grant execute on function public.get_observation_series(timestamptz, timestamptz, integer) to authenticated;
grant execute on function public.get_history_summary(timestamptz, timestamptz) to authenticated;

-- ---------------------------------------------------------------------
-- 11. Function privileges: only signed-in users may call; RPCs re-check status
-- ---------------------------------------------------------------------
revoke execute on function public.request_aerator_command(uuid, text, integer) from public, anon;
revoke execute on function public.request_aerator_mode(text, text) from public, anon;
revoke execute on function public.record_management_event(uuid, text, timestamptz, timestamptz, text, text, uuid) from public, anon;
revoke execute on function public.close_management_event(uuid, timestamptz) from public, anon;
revoke execute on function public.acknowledge_alert(uuid, text) from public, anon;
revoke execute on function public.admin_set_user_access(uuid, text, text, text) from public, anon;
revoke execute on function public.admin_update_user_details(uuid, text, text, text) from public, anon;
revoke execute on function public.touch_last_login() from public, anon;
revoke execute on function public.update_study_metadata(uuid, jsonb) from public, anon;
revoke execute on function public.app_require_active(boolean) from public, anon;
revoke execute on function public.handle_new_auth_user() from public, anon, authenticated;
revoke execute on function public.handle_auth_user_email_change() from public, anon, authenticated;

grant execute on function public.request_aerator_command(uuid, text, integer) to authenticated;
grant execute on function public.request_aerator_mode(text, text) to authenticated;
grant execute on function public.record_management_event(uuid, text, timestamptz, timestamptz, text, text, uuid) to authenticated;
grant execute on function public.close_management_event(uuid, timestamptz) to authenticated;
grant execute on function public.acknowledge_alert(uuid, text) to authenticated;
grant execute on function public.admin_set_user_access(uuid, text, text, text) to authenticated;
grant execute on function public.admin_update_user_details(uuid, text, text, text) to authenticated;
grant execute on function public.touch_last_login() to authenticated;
grant execute on function public.update_study_metadata(uuid, jsonb) to authenticated;

-- The edge trigger functions from 001 are not callable by clients
revoke execute on function public.trg_forecast_timing() from public, anon, authenticated;
revoke execute on function public.trg_risk_timing() from public, anon, authenticated;
revoke execute on function public.trg_settings_revision() from public, anon, authenticated;
revoke execute on function public.trg_command_transition() from public, anon, authenticated;
revoke execute on function public.trg_event_command_semantics() from public, anon, authenticated;

commit;
