-- =====================================================================
-- AquaCast | 001_pd10_core_schema.sql
-- PostgreSQL / Supabase physical schema for the 12 frozen LS-1.0 relations
-- (PD-1.0). 12 base tables, 144 attributes, 8 logical FK relationships.
--
-- Run this ONLY on a project that does not already have the PD-1.0 tables.
-- If your own postgresql/001 + 002 PD-1.0 migrations were already applied,
-- skip this file and go straight to 002_dashboard_access.sql.
--
-- Rules followed from PD-1.0:
--   * no DB-generated UUID defaults (identity originates at the creating service)
--   * range CHECKs apply only when the matching quality status is VALID
--   * cross-table rules (forecast timing, risk timing, settings revision,
--     terminal command transitions, aeration command semantics) are triggers
--   * forecast_origin_utc is NOT stored; it is exposed by the forecast_details view
-- =====================================================================

set client_min_messages = warning;
begin;

-- ---------------------------------------------------------------------
-- 1. raw_observations (24)
-- ---------------------------------------------------------------------
create table if not exists public.raw_observations (
  observation_id               uuid primary key,
  timestamp_utc                timestamptz not null unique,
  acquisition_started_at_utc   timestamptz not null,
  acquisition_completed_at_utc timestamptz,
  do_mg_l                      double precision,
  do_saturation_pct            double precision,
  water_temp_c                 double precision,
  ph_adc_raw                   integer,
  ph_voltage_mv                double precision,
  ph_value                     double precision,
  light_lux                    double precision,
  air_temp_c                   double precision,
  relative_humidity_pct        double precision,
  atmospheric_pressure_hpa     double precision,
  do_mg_l_status               text not null,
  do_saturation_status         text not null,
  water_temp_status            text not null,
  ph_status                    text not null,
  light_status                 text not null,
  air_temp_status              text not null,
  humidity_status              text not null,
  pressure_status              text not null,
  record_status                text not null,
  sync_status                  text not null default 'PENDING',

  constraint chk_obs_acq_order check (acquisition_completed_at_utc is null or acquisition_completed_at_utc >= acquisition_started_at_utc),
  constraint chk_obs_do_status   check (do_mg_l_status       in ('VALID','MISSING','COMMUNICATION_ERROR','OUT_OF_RANGE','CRC_ERROR','SENSOR_ERROR')),
  constraint chk_obs_dosat_status check (do_saturation_status in ('VALID','MISSING','COMMUNICATION_ERROR','OUT_OF_RANGE','CRC_ERROR','SENSOR_ERROR')),
  constraint chk_obs_wt_status   check (water_temp_status    in ('VALID','MISSING','COMMUNICATION_ERROR','OUT_OF_RANGE','CRC_ERROR','SENSOR_ERROR')),
  constraint chk_obs_ph_status   check (ph_status            in ('VALID','MISSING','COMMUNICATION_ERROR','OUT_OF_RANGE','SENSOR_ERROR')),
  constraint chk_obs_light_status check (light_status        in ('VALID','MISSING','COMMUNICATION_ERROR','OUT_OF_RANGE','CRC_ERROR','SENSOR_ERROR')),
  constraint chk_obs_air_status  check (air_temp_status      in ('VALID','MISSING','COMMUNICATION_ERROR','OUT_OF_RANGE','CRC_ERROR','SENSOR_ERROR')),
  constraint chk_obs_hum_status  check (humidity_status      in ('VALID','MISSING','COMMUNICATION_ERROR','OUT_OF_RANGE','CRC_ERROR','SENSOR_ERROR')),
  constraint chk_obs_pres_status check (pressure_status      in ('VALID','MISSING','COMMUNICATION_ERROR','OUT_OF_RANGE','CRC_ERROR','SENSOR_ERROR')),
  constraint chk_obs_record_status check (record_status in ('COMPLETE','PARTIAL','FAILED')),
  constraint chk_obs_sync_status   check (sync_status in ('PENDING','SYNCED')),
  -- VALID means present and inside the accepted validation range
  constraint chk_obs_do_valid    check (do_mg_l_status <> 'VALID'       or (do_mg_l is not null and do_mg_l between 0 and 20)),
  constraint chk_obs_dosat_valid check (do_saturation_status <> 'VALID' or (do_saturation_pct is not null and do_saturation_pct between 0 and 200)),
  constraint chk_obs_wt_valid    check (water_temp_status <> 'VALID'    or (water_temp_c is not null and water_temp_c between 0 and 40)),
  constraint chk_obs_ph_valid    check (ph_status <> 'VALID'            or (ph_value is not null and ph_value between 0 and 14)),
  constraint chk_obs_light_valid check (light_status <> 'VALID'         or (light_lux is not null and light_lux >= 0)),
  constraint chk_obs_air_valid   check (air_temp_status <> 'VALID'      or (air_temp_c is not null and air_temp_c between -40 and 125)),
  constraint chk_obs_hum_valid   check (humidity_status <> 'VALID'      or (relative_humidity_pct is not null and relative_humidity_pct between 0 and 100)),
  constraint chk_obs_pres_valid  check (pressure_status <> 'VALID'      or (atmospheric_pressure_hpa is not null and atmospheric_pressure_hpa > 0)),
  constraint chk_obs_ph_voltage  check (ph_voltage_mv is null or ph_voltage_mv >= 0)
);

-- ---------------------------------------------------------------------
-- 2. system_health (15)  1 : 0..1 with raw_observations
-- ---------------------------------------------------------------------
create table if not exists public.system_health (
  observation_id              uuid primary key
                              references public.raw_observations(observation_id) on delete restrict on update no action,
  timestamp_utc               timestamptz not null,
  pi_cpu_temp_c               double precision,
  pi_uptime_s                 integer,
  ram_used_pct                double precision,
  storage_free_mb             double precision,
  wifi_connected              boolean not null,
  wifi_signal_rssi_dbm        double precision,
  internet_reachable          boolean not null,
  last_cloud_sync_at_utc      timestamptz,
  battery_voltage_v           double precision,
  rs485_bus_status            text not null,
  i2c_bus_status              text not null,
  local_database_operational  boolean not null,
  sync_status                 text not null,

  constraint chk_health_uptime  check (pi_uptime_s is null or pi_uptime_s >= 0),
  constraint chk_health_ram     check (ram_used_pct is null or ram_used_pct between 0 and 100),
  constraint chk_health_storage check (storage_free_mb is null or storage_free_mb >= 0),
  constraint chk_health_rssi    check (wifi_connected or wifi_signal_rssi_dbm is null),
  constraint chk_health_battery check (battery_voltage_v is null or battery_voltage_v > 0),
  constraint chk_health_rs485   check (rs485_bus_status in ('OK','DEGRADED','FAILED')),
  constraint chk_health_i2c     check (i2c_bus_status in ('OK','DEGRADED','FAILED')),
  constraint chk_health_sync    check (sync_status in ('PENDING','SYNCED'))
);

-- ---------------------------------------------------------------------
-- 3. forecast_models (11)
-- ---------------------------------------------------------------------
create table if not exists public.forecast_models (
  model_id              uuid primary key,
  model_name            text not null,
  algorithm             text not null,
  forecast_horizon_min  integer not null,
  version               text not null,
  training_start_utc    timestamptz not null,
  training_end_utc      timestamptz not null,
  model_file_name       text not null,
  model_file_hash       text not null,
  deployment_status     text not null,
  created_at_utc        timestamptz not null,

  constraint uq_forecast_model_horizon unique (model_id, forecast_horizon_min),
  constraint chk_model_horizon   check (forecast_horizon_min in (30,60,90,120)),
  constraint chk_model_status    check (deployment_status in ('CANDIDATE','DEPLOYED','RETIRED')),
  constraint chk_model_training  check (training_end_utc >= training_start_utc),
  constraint chk_model_nonempty  check (length(trim(model_name)) > 0 and length(trim(algorithm)) > 0)
);
create unique index if not exists uq_forecast_models_one_deployed_per_horizon
  on public.forecast_models (forecast_horizon_min) where deployment_status = 'DEPLOYED';

-- ---------------------------------------------------------------------
-- 4. forecasts (9)
-- ---------------------------------------------------------------------
create table if not exists public.forecasts (
  forecast_id           uuid primary key,
  observation_id        uuid not null references public.raw_observations(observation_id) on delete restrict on update no action,
  model_id              uuid not null,
  generated_at_utc      timestamptz not null,
  target_timestamp_utc  timestamptz not null,
  horizon_minutes       integer not null,
  predicted_do_mg_l     double precision,
  forecast_status       text not null,
  sync_status           text not null,

  constraint uq_forecast_origin_horizon unique (observation_id, horizon_minutes),
  constraint fk_forecast_model_horizon foreign key (model_id, horizon_minutes)
    references public.forecast_models (model_id, forecast_horizon_min) on delete restrict on update no action,
  constraint chk_forecast_horizon check (horizon_minutes in (30,60,90,120)),
  constraint chk_forecast_status  check (forecast_status in ('VALID','INPUT_UNAVAILABLE','INSUFFICIENT_HISTORY','MODEL_ERROR')),
  constraint chk_forecast_status_output check (
    (forecast_status = 'VALID' and predicted_do_mg_l is not null and predicted_do_mg_l >= 0)
    or (forecast_status <> 'VALID' and predicted_do_mg_l is null)),
  constraint chk_forecast_is_prospective check (generated_at_utc < target_timestamp_utc),
  constraint chk_forecast_sync check (sync_status in ('PENDING','SYNCED'))
);

-- ---------------------------------------------------------------------
-- 5. risk_assessments (8)
-- ---------------------------------------------------------------------
create table if not exists public.risk_assessments (
  risk_id                          uuid primary key,
  observation_id                   uuid not null unique references public.raw_observations(observation_id) on delete restrict on update no action,
  assessment_timestamp_utc         timestamptz not null,
  current_risk_state               text not null,
  forecast_outlook                 text not null,
  expected_threshold_crossing_utc  timestamptz,
  rule_version                     text not null,
  sync_status                      text not null,

  constraint chk_risk_state   check (current_risk_state in ('NORMAL','WATCH','WARNING','CRITICAL','DATA_UNAVAILABLE')),
  constraint chk_risk_outlook check (forecast_outlook in ('NO_CROSSING_EXPECTED','CROSSING_EXPECTED','DATA_UNAVAILABLE')),
  constraint chk_risk_outlook_crossing_time check (
    (forecast_outlook = 'CROSSING_EXPECTED' and expected_threshold_crossing_utc is not null)
    or (forecast_outlook <> 'CROSSING_EXPECTED' and expected_threshold_crossing_utc is null)),
  constraint chk_future_threshold_crossing check (expected_threshold_crossing_utc is null or expected_threshold_crossing_utc > assessment_timestamp_utc),
  constraint chk_risk_rule_version check (length(trim(rule_version)) > 0),
  constraint chk_risk_sync check (sync_status in ('PENDING','SYNCED'))
);

-- ---------------------------------------------------------------------
-- 6. study_metadata (14)  (no FK by design)
-- ---------------------------------------------------------------------
create table if not exists public.study_metadata (
  study_id               uuid primary key,
  deployment_start_utc   timestamptz not null,
  deployment_end_utc     timestamptz,
  sampling_interval_min  integer not null,
  probe_depth_m          double precision not null,
  pond_length_m          double precision not null,
  pond_width_m           double precision not null,
  pond_depth_m           double precision not null,
  culture_species        text not null,
  culture_stage          text not null,
  culture_system         text not null,
  site_description       text not null,
  timezone               text not null,
  notes                  text,

  constraint chk_study_end      check (deployment_end_utc is null or deployment_end_utc >= deployment_start_utc),
  constraint chk_study_interval check (sampling_interval_min > 0),
  constraint chk_study_dims     check (pond_length_m > 0 and pond_width_m > 0 and pond_depth_m > 0),
  constraint chk_study_probe    check (probe_depth_m > 0 and probe_depth_m <= pond_depth_m),
  constraint chk_study_text     check (length(trim(culture_species)) > 0 and length(trim(culture_stage)) > 0
                                       and length(trim(culture_system)) > 0 and length(trim(timezone)) > 0)
);

-- ---------------------------------------------------------------------
-- 7. biomass_records (11)  (no FK by design)
-- ---------------------------------------------------------------------
create table if not exists public.biomass_records (
  biomass_record_id      uuid primary key,
  measured_at_utc        timestamptz not null,
  estimated_fish_count   integer,
  mean_fish_weight_g     double precision,
  total_biomass_kg       double precision not null,
  biomass_density_kg_m3  double precision not null,
  estimation_method      text not null,
  sample_size            integer,
  notes                  text,
  recorded_at_utc        timestamptz not null,
  sync_status            text not null,

  constraint chk_bio_count   check (estimated_fish_count is null or estimated_fish_count >= 0),
  constraint chk_bio_weight  check (mean_fish_weight_g is null or mean_fish_weight_g > 0),
  constraint chk_bio_total   check (total_biomass_kg >= 0 and biomass_density_kg_m3 >= 0),
  constraint chk_bio_method  check (estimation_method in ('DIRECT_MEASUREMENT','SAMPLE_BASED_ESTIMATE','STOCK_RECORD_BASED_ESTIMATE','OTHER')),
  constraint chk_other_biomass_method_documented check (estimation_method <> 'OTHER' or notes is not null),
  constraint chk_bio_sample  check (sample_size is null or sample_size > 0),
  constraint chk_bio_sample_required check (estimation_method <> 'SAMPLE_BASED_ESTIMATE' or sample_size is not null),
  constraint chk_bio_recorded check (recorded_at_utc >= measured_at_utc),
  constraint chk_bio_sync check (sync_status in ('PENDING','SYNCED'))
);

-- ---------------------------------------------------------------------
-- 8. sensor_registry (9)
-- ---------------------------------------------------------------------
create table if not exists public.sensor_registry (
  sensor_id       uuid primary key,
  sensor_type     text not null,
  manufacturer    text not null,
  model           text not null,
  serial_number   text unique,
  status          text not null,
  notes           text,
  created_at_utc  timestamptz not null,
  sync_status     text not null,

  constraint chk_sensor_status check (status in ('ACTIVE','SPARE','UNDER_SERVICE','RETIRED')),
  constraint chk_sensor_text   check (length(trim(sensor_type)) > 0 and length(trim(manufacturer)) > 0 and length(trim(model)) > 0),
  constraint chk_sensor_sync   check (sync_status in ('PENDING','SYNCED'))
);

-- ---------------------------------------------------------------------
-- 9. sensor_calibrations (9)
-- ---------------------------------------------------------------------
create table if not exists public.sensor_calibrations (
  calibration_id                uuid primary key,
  sensor_id                     uuid not null references public.sensor_registry(sensor_id) on delete restrict on update no action,
  calibration_started_at_utc    timestamptz not null,
  calibration_completed_at_utc  timestamptz,
  calibration_type              text not null,
  result                        text not null,
  notes                         text,
  created_at_utc                timestamptz not null,
  sync_status                   text not null,

  constraint chk_cal_order  check (calibration_completed_at_utc is null or calibration_completed_at_utc >= calibration_started_at_utc),
  constraint chk_cal_type   check (calibration_type in ('ONE_POINT','TWO_POINT','VERIFICATION')),
  constraint chk_cal_result check (result in ('PASSED','FAILED','INCOMPLETE')),
  constraint chk_cal_completed_required check (result = 'INCOMPLETE' or calibration_completed_at_utc is not null),
  constraint chk_cal_sync check (sync_status in ('PENDING','SYNCED'))
);

-- ---------------------------------------------------------------------
-- 10. aerator_control_settings (12)  singleton
-- ---------------------------------------------------------------------
create table if not exists public.aerator_control_settings (
  settings_id              uuid primary key,
  singleton_slot           integer not null default 1 unique,
  requested_mode           text not null,
  applied_mode             text not null,
  controller_output_state  text not null,
  automatic_rule_version   text,
  settings_revision        integer not null,
  applied_revision         integer,
  mode_requested_at_utc    timestamptz not null,
  mode_applied_at_utc      timestamptz,
  output_reported_at_utc   timestamptz,
  updated_by_user_id       text,

  constraint chk_settings_singleton check (singleton_slot = 1),
  constraint chk_settings_req_mode  check (requested_mode in ('MANUAL','AUTOMATIC')),
  constraint chk_settings_app_mode  check (applied_mode in ('MANUAL','AUTOMATIC','UNKNOWN')),
  constraint chk_settings_output    check (controller_output_state in ('ON','OFF','UNKNOWN')),
  constraint chk_settings_auto_rule check (applied_mode <> 'AUTOMATIC' or automatic_rule_version is not null),
  constraint chk_settings_revision  check (settings_revision > 0),
  constraint chk_settings_applied_revision check (applied_revision is null or (applied_revision > 0 and applied_revision <= settings_revision)),
  constraint chk_settings_applied_time check ((applied_revision is null) = (mode_applied_at_utc is null))
);

-- ---------------------------------------------------------------------
-- 11. aerator_commands (11)
-- ---------------------------------------------------------------------
create table if not exists public.aerator_commands (
  command_id             uuid primary key,
  requested_state        text not null,
  command_source         text not null,
  requested_by_user_id   text,
  requested_at_utc       timestamptz not null,
  expires_at_utc         timestamptz,
  command_status         text not null,
  applied_at_utc         timestamptz,
  status_updated_at_utc  timestamptz not null,
  failure_reason         text,
  sync_status            text,

  constraint chk_cmd_state  check (requested_state in ('ON','OFF')),
  constraint chk_cmd_source check (command_source in ('MANUAL_DASHBOARD','AUTOMATIC_LOCAL')),
  constraint chk_cmd_status check (command_status in ('PENDING','APPLIED','REJECTED','FAILED','EXPIRED','CANCELLED')),
  constraint chk_cmd_requester check (
    (command_source = 'MANUAL_DASHBOARD' and requested_by_user_id is not null)
    or (command_source = 'AUTOMATIC_LOCAL' and requested_by_user_id is null)),
  constraint chk_cmd_expiry check (command_source <> 'MANUAL_DASHBOARD' or (expires_at_utc is not null and expires_at_utc > requested_at_utc)),
  constraint chk_cmd_applied check ((command_status = 'APPLIED') = (applied_at_utc is not null)),
  constraint chk_cmd_applied_before_expiry check (applied_at_utc is null or expires_at_utc is null or applied_at_utc <= expires_at_utc),
  constraint chk_cmd_status_time check (status_updated_at_utc >= requested_at_utc),
  constraint chk_cmd_failure_reason check (command_status not in ('REJECTED','FAILED') or failure_reason is not null),
  constraint chk_cmd_sync check (
    (command_source = 'AUTOMATIC_LOCAL' and sync_status in ('PENDING','SYNCED'))
    or (command_source = 'MANUAL_DASHBOARD' and sync_status is null))
);

-- ---------------------------------------------------------------------
-- 12. management_events (11)
-- ---------------------------------------------------------------------
create table if not exists public.management_events (
  event_id            uuid primary key,
  event_type          text not null,
  event_start_utc     timestamptz not null,
  event_end_utc       timestamptz,
  reason              text,
  related_risk_id     uuid references public.risk_assessments(risk_id) on delete restrict on update no action,
  related_command_id  uuid unique references public.aerator_commands(command_id) on delete restrict on update no action,
  stop_command_id     uuid unique references public.aerator_commands(command_id) on delete restrict on update no action,
  notes               text,
  recorded_at_utc     timestamptz not null,
  sync_status         text not null,

  constraint chk_event_type check (event_type in ('FEEDING','AERATION','WATER_EXCHANGE','POND_CLEANING','FISH_STOCKING',
                                                 'FISH_HARVEST','SENSOR_MAINTENANCE','POWER_MAINTENANCE','OTHER')),
  constraint chk_event_end check (event_end_utc is null or event_end_utc >= event_start_utc),
  constraint chk_commands_only_for_aeration check (event_type = 'AERATION' or (related_command_id is null and stop_command_id is null)),
  constraint chk_start_stop_differ check (related_command_id is null or stop_command_id is null or related_command_id <> stop_command_id),
  constraint chk_event_sync check (sync_status in ('PENDING','SYNCED'))
);
create unique index if not exists uq_management_events_one_open_aeration
  on public.management_events ((1)) where event_type = 'AERATION' and event_end_utc is null;

-- ---------------------------------------------------------------------
-- Performance / time-series indexes
-- ---------------------------------------------------------------------
create index if not exists ix_health_timestamp       on public.system_health (timestamp_utc desc);
create index if not exists ix_forecasts_target       on public.forecasts (target_timestamp_utc);
create index if not exists ix_forecasts_model        on public.forecasts (model_id, horizon_minutes);
create index if not exists ix_risk_assessment_time   on public.risk_assessments (assessment_timestamp_utc desc);
create index if not exists ix_calibrations_sensor    on public.sensor_calibrations (sensor_id, calibration_started_at_utc desc);
create index if not exists ix_commands_requested     on public.aerator_commands (requested_at_utc desc);
create index if not exists ix_commands_pending       on public.aerator_commands (requested_at_utc) where command_status = 'PENDING';
create index if not exists ix_events_start           on public.management_events (event_start_utc desc);
create index if not exists ix_biomass_measured       on public.biomass_records (measured_at_utc desc);

-- =====================================================================
-- Cross-table triggers (PD-1.0 section 7)
-- =====================================================================

-- Forecast: target = origin + horizon, generated >= origin
create or replace function public.trg_forecast_timing() returns trigger
language plpgsql as $$
declare v_origin timestamptz;
begin
  select timestamp_utc into v_origin from public.raw_observations where observation_id = new.observation_id;
  if v_origin is null then
    raise exception 'forecast % references unknown observation %', new.forecast_id, new.observation_id using errcode = '23503';
  end if;
  if new.target_timestamp_utc <> v_origin + make_interval(mins => new.horizon_minutes) then
    raise exception 'forecast target_timestamp_utc must equal observation timestamp + horizon (expected %)',
      v_origin + make_interval(mins => new.horizon_minutes) using errcode = '23514';
  end if;
  if new.generated_at_utc < v_origin then
    raise exception 'forecast generated_at_utc must be at/after the origin observation timestamp' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists forecasts_timing on public.forecasts;
create trigger forecasts_timing before insert or update on public.forecasts
  for each row execute function public.trg_forecast_timing();

-- Risk assessment generated at/after its observation
create or replace function public.trg_risk_timing() returns trigger
language plpgsql as $$
declare v_origin timestamptz;
begin
  select timestamp_utc into v_origin from public.raw_observations where observation_id = new.observation_id;
  if v_origin is not null and new.assessment_timestamp_utc < v_origin then
    raise exception 'assessment_timestamp_utc must be at/after the referenced observation timestamp' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists risk_timing on public.risk_assessments;
create trigger risk_timing before insert or update on public.risk_assessments
  for each row execute function public.trg_risk_timing();

-- Settings: revisions never regress (stale acknowledgements rejected)
create or replace function public.trg_settings_revision() returns trigger
language plpgsql as $$
begin
  if new.settings_revision < old.settings_revision then
    raise exception 'settings_revision may not decrease (% -> %)', old.settings_revision, new.settings_revision using errcode = '23514';
  end if;
  if old.applied_revision is not null and (new.applied_revision is null or new.applied_revision < old.applied_revision) then
    raise exception 'applied_revision may not move backwards (stale acknowledgement)' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists settings_revision on public.aerator_control_settings;
create trigger settings_revision before update on public.aerator_control_settings
  for each row execute function public.trg_settings_revision();

-- Commands: request fields immutable; PENDING -> terminal once; terminal rows frozen
create or replace function public.trg_command_transition() returns trigger
language plpgsql as $$
begin
  if new.command_id <> old.command_id or new.requested_state <> old.requested_state
     or new.command_source <> old.command_source
     or new.requested_by_user_id is distinct from old.requested_by_user_id
     or new.requested_at_utc <> old.requested_at_utc
     or new.expires_at_utc is distinct from old.expires_at_utc then
    raise exception 'aerator command request fields are immutable' using errcode = '23514';
  end if;
  if old.command_status <> 'PENDING' and
     (new.command_status <> old.command_status or new.applied_at_utc is distinct from old.applied_at_utc
      or new.failure_reason is distinct from old.failure_reason) then
    raise exception 'aerator command % is terminal (%) and cannot change', old.command_id, old.command_status using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists command_transition on public.aerator_commands;
create trigger command_transition before update on public.aerator_commands
  for each row execute function public.trg_command_transition();

-- Aeration event traceability: start = APPLIED ON, stop = APPLIED OFF, no cross-role reuse
create or replace function public.trg_event_command_semantics() returns trigger
language plpgsql as $$
declare c record;
begin
  if new.related_command_id is not null then
    select requested_state, command_status into c from public.aerator_commands where command_id = new.related_command_id;
    if not found or c.requested_state <> 'ON' or c.command_status <> 'APPLIED' then
      raise exception 'related_command_id must reference an APPLIED ON command' using errcode = '23514';
    end if;
    if exists (select 1 from public.management_events e
               where e.stop_command_id = new.related_command_id and e.event_id <> new.event_id) then
      raise exception 'command % already used as a stop command' , new.related_command_id using errcode = '23505';
    end if;
  end if;
  if new.stop_command_id is not null then
    select requested_state, command_status into c from public.aerator_commands where command_id = new.stop_command_id;
    if not found or c.requested_state <> 'OFF' or c.command_status <> 'APPLIED' then
      raise exception 'stop_command_id must reference an APPLIED OFF command' using errcode = '23514';
    end if;
    if exists (select 1 from public.management_events e
               where e.related_command_id = new.stop_command_id and e.event_id <> new.event_id) then
      raise exception 'command % already used as a start command', new.stop_command_id using errcode = '23505';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists event_command_semantics on public.management_events;
create trigger event_command_semantics before insert or update on public.management_events
  for each row execute function public.trg_event_command_semantics();

-- ---------------------------------------------------------------------
-- forecast_details view: re-exposes the origin timestamp without storing it
-- ---------------------------------------------------------------------
create or replace view public.forecast_details with (security_invoker = true) as
select f.forecast_id, f.observation_id, o.timestamp_utc as forecast_origin_utc,
       f.model_id, m.model_name, m.version as model_version, m.deployment_status as model_deployment_status,
       f.generated_at_utc, f.target_timestamp_utc, f.horizon_minutes,
       f.predicted_do_mg_l, f.forecast_status, f.sync_status
from public.forecasts f
join public.raw_observations o on o.observation_id = f.observation_id
join public.forecast_models  m on m.model_id = f.model_id;

commit;
