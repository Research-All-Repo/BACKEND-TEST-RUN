-- =====================================================================
-- 008: lock the simulator off for good (a real Raspberry Pi is in use).
-- Old Vercel deployments stay reachable at their own addresses with the settings they were built
-- with. One built while MOCK_EDGE_ENABLED was true keeps simulating as soon as anyone opens it,
-- writing fake readings into this database and making the Pi look "connected".
-- The simulator gives readings version-5 ids; the Raspberry Pi always uses version-4 ids. This
-- trigger refuses version-5 readings, so no copy of the dashboard can add simulated data again.
-- To use the simulator again (demo / test project only):
--   drop trigger block_simulated_readings on public.raw_observations;
-- Run once in Supabase -> SQL Editor. Safe to re-run.
-- =====================================================================
create or replace function public.block_simulated_readings() returns trigger language plpgsql as $$
begin
  -- the simulator makes version-5 ids; the Raspberry Pi always makes version-4 ids
  if substr(new.observation_id::text, 15, 1) = '5' then
    raise exception 'Simulated reading refused: the AquaCast simulator is locked off because a real Raspberry Pi is in use.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists block_simulated_readings on public.raw_observations;
create trigger block_simulated_readings before insert on public.raw_observations
  for each row execute function public.block_simulated_readings();
