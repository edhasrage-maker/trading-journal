-- Optional per-user history window for the Morning Conditions lookup.
--
-- `refreshConditionLookup` aggregates the trader's ENTIRE history. That is the
-- right default, but it makes two things impossible:
--   1. seeing what the panel looks like for a trader with a few months of data
--      (the founder's account has 3+ years, so every bucket is comfortably
--      above MIN_SAMPLE and the thin-sample suppression path never renders);
--   2. deliberately excluding an era that no longer reflects how the trader
--      trades (different instrument, size, or ruleset).
--
-- NULL (the default, and every existing row) = unbounded, i.e. exactly the
-- current behaviour. Set a date and BOTH the trade aggregation and the
-- threshold/tercile cuts are computed from that date forward — cutting buckets
-- on three years of context while filling them from seven months of trades
-- would put the trades in the wrong buckets.
--
-- Honored by refreshConditionLookup(), so the Settings "Refresh now" button and
-- the nightly cron both respect it and neither clobbers the window.

alter table public.condition_lookup_meta
  add column if not exists history_start_date date;

comment on column public.condition_lookup_meta.history_start_date is
  'Optional inclusive lower bound (PT session date) on the history the condition lookup aggregates. NULL = all history.';
