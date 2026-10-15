-- =====================================================================
-- AquaCast cut-over: remove the SIMULATED pond data before the real Raspberry Pi starts.
-- Run ONCE in Supabase -> SQL Editor, AFTER MOCK_EDGE_ENABLED=false is deployed in Vercel
-- (otherwise the simulator immediately refills it) and BEFORE starting the Pi service.
--
-- Deletes: readings, health, forecasts, risk levels, simulated forecast models, aerator
--          requests/answers, pond activities, and the delivery records of simulated alerts.
-- Keeps:   user accounts, push devices, the audit log, study / sensor / biomass details,
--          the aerator mode setting, phone TEST alert records.
-- Everything runs in one transaction: if any step fails, nothing is deleted.
-- =====================================================================
begin;

delete from public.management_events;
delete from public.aerator_commands;
delete from public.risk_assessments;
delete from public.forecasts;
delete from public.system_health;
delete from public.raw_observations;
-- simulated models (the Pi registers its own models when it starts)
delete from public.forecast_models f
 where not exists (select 1 from public.forecasts x where x.model_id = f.model_id);

-- relay state is unknown until the Pi reports it
update public.aerator_control_settings
   set controller_output_state = 'UNKNOWN', output_reported_at_utc = null
 where singleton_slot = 1;

-- the real deployment starts now
update public.study_metadata set deployment_start_utc = now(), deployment_end_utc = null;

-- delivery statistics of simulated alerts (TEST alerts are kept)
do $$
begin
  if to_regclass('public.alert_dispatches') is not null then
    delete from public.alert_dispatches where kind <> 'TEST';
  end if;
end $$;
delete from public.dashboard_settings where setting_key = 'edge_status';

insert into public.dashboard_audit_log (actor_user_id, action, target_table, target_id, details)
values (null, 'SIMULATED_DATA_CLEARED', 'raw_observations', 'cutover',
        jsonb_build_object('note', 'Simulated data removed before the Raspberry Pi went live.'));

commit;

-- Check: every count below should be 0
select (select count(*) from public.raw_observations) as readings,
       (select count(*) from public.forecasts)        as forecasts,
       (select count(*) from public.risk_assessments) as risk_levels,
       (select count(*) from public.aerator_commands) as aerator_requests;
