-- =====================================================================
-- AquaCast 007: language of each device's phone notifications (English / Filipino)
-- Each registered phone/browser remembers the language chosen in AquaCast (profile -> This device -> Language),
-- so Warning / Critical notifications arrive in that language.
-- Run once in Supabase -> SQL Editor (after 001-006). Safe to re-run.
-- =====================================================================
alter table public.push_subscriptions add column if not exists lang text not null default 'en';
alter table public.push_subscriptions drop constraint if exists chk_push_lang;
alter table public.push_subscriptions add constraint chk_push_lang check (lang in ('en', 'fil'));
