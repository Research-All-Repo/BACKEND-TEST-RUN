-- =====================================================================
-- AquaCast | 000_preflight_check.sql   (READ-ONLY - changes nothing)
-- Run this first in Supabase -> SQL Editor. It tells you whether this project
-- is empty, already matches PD-1.0, or still has an older AquaCast schema
-- (e.g. the September 9-table version) that would conflict.
-- =====================================================================
with expected(table_name, cols) as (values
    ('raw_observations', array['observation_id', 'timestamp_utc', 'acquisition_started_at_utc', 'acquisition_completed_at_utc', 'do_mg_l', 'do_saturation_pct', 'water_temp_c', 'ph_adc_raw', 'ph_voltage_mv', 'ph_value', 'light_lux', 'air_temp_c', 'relative_humidity_pct', 'atmospheric_pressure_hpa', 'do_mg_l_status', 'do_saturation_status', 'water_temp_status', 'ph_status', 'light_status', 'air_temp_status', 'humidity_status', 'pressure_status', 'record_status', 'sync_status']::text[]),
    ('system_health', array['observation_id', 'timestamp_utc', 'pi_cpu_temp_c', 'pi_uptime_s', 'ram_used_pct', 'storage_free_mb', 'wifi_connected', 'wifi_signal_rssi_dbm', 'internet_reachable', 'last_cloud_sync_at_utc', 'battery_voltage_v', 'rs485_bus_status', 'i2c_bus_status', 'local_database_operational', 'sync_status']::text[]),
    ('forecast_models', array['model_id', 'model_name', 'algorithm', 'forecast_horizon_min', 'version', 'training_start_utc', 'training_end_utc', 'model_file_name', 'model_file_hash', 'deployment_status', 'created_at_utc']::text[]),
    ('forecasts', array['forecast_id', 'observation_id', 'model_id', 'generated_at_utc', 'target_timestamp_utc', 'horizon_minutes', 'predicted_do_mg_l', 'forecast_status', 'sync_status']::text[]),
    ('risk_assessments', array['risk_id', 'observation_id', 'assessment_timestamp_utc', 'current_risk_state', 'forecast_outlook', 'expected_threshold_crossing_utc', 'rule_version', 'sync_status']::text[]),
    ('study_metadata', array['study_id', 'deployment_start_utc', 'deployment_end_utc', 'sampling_interval_min', 'probe_depth_m', 'pond_length_m', 'pond_width_m', 'pond_depth_m', 'culture_species', 'culture_stage', 'culture_system', 'site_description', 'timezone', 'notes']::text[]),
    ('biomass_records', array['biomass_record_id', 'measured_at_utc', 'estimated_fish_count', 'mean_fish_weight_g', 'total_biomass_kg', 'biomass_density_kg_m3', 'estimation_method', 'sample_size', 'notes', 'recorded_at_utc', 'sync_status']::text[]),
    ('sensor_registry', array['sensor_id', 'sensor_type', 'manufacturer', 'model', 'serial_number', 'status', 'notes', 'created_at_utc', 'sync_status']::text[]),
    ('sensor_calibrations', array['calibration_id', 'sensor_id', 'calibration_started_at_utc', 'calibration_completed_at_utc', 'calibration_type', 'result', 'notes', 'created_at_utc', 'sync_status']::text[]),
    ('aerator_control_settings', array['settings_id', 'singleton_slot', 'requested_mode', 'applied_mode', 'controller_output_state', 'automatic_rule_version', 'settings_revision', 'applied_revision', 'mode_requested_at_utc', 'mode_applied_at_utc', 'output_reported_at_utc', 'updated_by_user_id']::text[]),
    ('aerator_commands', array['command_id', 'requested_state', 'command_source', 'requested_by_user_id', 'requested_at_utc', 'expires_at_utc', 'command_status', 'applied_at_utc', 'status_updated_at_utc', 'failure_reason', 'sync_status']::text[]),
    ('management_events', array['event_id', 'event_type', 'event_start_utc', 'event_end_utc', 'reason', 'related_risk_id', 'related_command_id', 'stop_command_id', 'notes', 'recorded_at_utc', 'sync_status']::text[])
),
actual as (
  select table_name, array_agg(column_name::text order by ordinal_position) as cols
  from information_schema.columns where table_schema = 'public' group by table_name
)
select e.table_name,
       case when a.table_name is null then 'NOT PRESENT (001 will create it)'
            when (select count(*) from unnest(e.cols) c where c <> all(a.cols)) = 0
             and (select count(*) from unnest(a.cols) c where c <> all(e.cols)) = 0 then 'OK - matches PD-1.0'
            else 'CONFLICT - different columns' end as status,
       (select string_agg(c, ', ') from unnest(e.cols) c where a.table_name is not null and c <> all(a.cols)) as missing_columns,
       (select string_agg(c, ', ') from unnest(a.cols) c where c <> all(e.cols)) as unexpected_columns
from expected e left join actual a using (table_name)
union all
select a.table_name, 'OTHER TABLE (not part of PD-1.0)', null, null
from actual a
where a.table_name not in (select table_name from expected)
  and a.table_name not in ('user_access_profiles','dashboard_audit_log','forecast_details','activity_feed','forecast_evaluation','risk_alerts')
order by 2, 1;

-- How to read the result:
--   all NOT PRESENT          -> fresh project: run 001 then 002.
--   all OK                   -> PD-1.0 already installed: run 002 only.
--   any CONFLICT / OTHER     -> an older AquaCast schema exists. Use a NEW Supabase project
--                               (recommended), or back up and drop the old tables first.
