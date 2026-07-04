-- First-time setup wizard state + the per-user scoring profile.
--
-- onboarding_json  — wizard progress so it can resume / show the "finish setup"
--   banner / fire the one end-of-week reminder. Shape:
--     { status: 'not_started'|'in_progress'|'completed'|'skipped',
--       steps_done: text[], completed_at, reminder_dismissed, reminder_sent_at }
--
-- scoring_profile_json — the trader's OWN risk / process / execution rules that
--   the Coach Score grades against (per-user, replaces the fixed global rubric).
--   Proposed shape (aligns with the P1–P5 rails + execution params):
--     { risk:   { per_trade:{mode,value}, stop:{mode,value}, tp_targets },
--       rails:  { daily_loss_limit, max_size, max_trades_per_day, cooldown_secs,
--                 no_add_to_loser },
--       execution: { uses_orderflow, of_required_for_size_up, ... } }
--
-- Run in the Supabase SQL editor. Idempotent.
alter table trader_profile
  add column if not exists onboarding_json      jsonb not null default '{}'::jsonb,
  add column if not exists scoring_profile_json jsonb not null default '{}'::jsonb;
