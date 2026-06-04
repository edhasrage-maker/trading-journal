-- 2026-06-04 — Add market_context.day_range so we can carry Sierra's
-- "Day's Range" overlay value through to the DR_ADR auto-fill.
--
-- Before this column, DR_ADR was computed from 1-min bars in the 06:30-07:30
-- PT window via /lib/dr-adr.ts. That works once bars are imported, but at
-- prep time bars often haven't synced yet — Sierra's stats overlay already
-- shows "Day's Range" in points, which extract-context can read directly
-- from the screenshot, much more reliably than the bars path.
--
-- The bars-based path stays as a fallback when day_range is null.
--
-- Idempotent.

ALTER TABLE market_context
  ADD COLUMN IF NOT EXISTS day_range numeric;

COMMENT ON COLUMN market_context.day_range IS
  'Day''s Range in points from Sierra Chart stats overlay (extracted by AI on screenshot upload). Used to compute DR_ADR = day_range / adr.';
