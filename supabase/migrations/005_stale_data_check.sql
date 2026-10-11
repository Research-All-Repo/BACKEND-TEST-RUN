-- =====================================================================
-- AquaCast 005 (optional but recommended): "no new readings" phone alarm
-- Every 5 minutes Supabase asks the dashboard server to check whether readings stopped
-- arriving. If the newest reading is older than PUSH_STALE_MINUTES (default 30), every
-- subscribed phone gets ONE alert for that outage, and one "readings are back" alert later.
-- Skipped automatically while the mock edge simulator or calibration mode is on.
--
-- BEFORE RUNNING: replace PASTE_YOUR_HOOK_SECRET_HERE with the same PUSH_HOOK_SECRET you put
-- in Vercel (keep the quotes). Do not share the edited file.
-- Requires the pg_cron and pg_net extensions (Database -> Extensions, or the lines below).
-- To stop it later:  select cron.unschedule('aquacast-stale-check');
-- =====================================================================
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select cron.unschedule('aquacast-stale-check')
where exists (select 1 from cron.job where jobname = 'aquacast-stale-check');

select cron.schedule(
  'aquacast-stale-check',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://aquacast-research.vercel.app/api/push/stale-check',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-aquacast-hook-secret', 'PASTE_YOUR_HOOK_SECRET_HERE'),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
  $$
);
