-- 2026-06-03 — Support multiple day types per session.
--
-- The trader needs to tag combo sessions like "High Action + Double Inside"
-- on the prep page. trading_days.day_type was a single text column, which
-- forced an either/or pick.
--
-- This migration adds a text[] companion column for multi-select. We keep
-- the legacy `day_type` column as the PRIMARY (first selected) for backward
-- compatibility — analytics, dashboard, calendar, and predict-day-type all
-- read it. New writes go to BOTH columns so a future cleanup can drop the
-- legacy column once every consumer reads from the array.
--
-- Backfill: existing single-string values seed the array so nothing breaks
-- for past sessions.
--
-- Idempotent.

ALTER TABLE trading_days
  ADD COLUMN IF NOT EXISTS day_types text[] DEFAULT '{}'::text[];

-- Backfill: for any row with a legacy day_type but no day_types array yet,
-- seed day_types with [day_type]. Skips rows already populated so re-runs
-- don't clobber multi-select selections made after this migration runs.
UPDATE trading_days
SET day_types = ARRAY[day_type]::text[]
WHERE day_type IS NOT NULL
  AND day_type <> ''
  AND (day_types IS NULL OR cardinality(day_types) = 0);
