-- =====================================================================
-- 010: backup readings
-- The Raspberry Pi also takes a backup reading halfway through each 10-minute cycle (it stays on the
-- Pi). When a sensor fails in the 10-minute reading, its value from that backup reading is used
-- instead, for at most 3 readings in a row. This column records which values were filled that way
-- and when the backup reading was taken, e.g. {"do_mg_l": "2026-10-19T12:05:03Z"}. NULL = none.
-- Run once in Supabase -> SQL Editor. Safe to re-run.
-- =====================================================================
alter table public.raw_observations add column if not exists filled_from_backup jsonb;

alter table public.raw_observations drop constraint if exists chk_obs_backup_object;
alter table public.raw_observations add constraint chk_obs_backup_object
  check (filled_from_backup is null or jsonb_typeof(filled_from_backup) = 'object');

comment on column public.raw_observations.filled_from_backup is
  'Values taken from the Pi backup reading (halfway through the previous cycle) because the sensor failed in this reading: {field: backup time UTC}.';
