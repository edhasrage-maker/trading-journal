-- 2026-06-03 — Add description column to trade_tags + seed day_type definitions.
--
-- The AI day-type predictor was hardcoded with a stale 7-label list that didn't
-- match the user's library, causing two leaks (Trend Day, Range Day) to be
-- auto-added when predictions were accepted. Fix: pull labels from the library
-- + give each label a definition the AI can use for classification.
--
-- The `description` column is on the parent table (not day_type-specific) so
-- the same pattern can be reused for mistakes, confluences, etc. in future
-- prompt-engineering work.
--
-- Idempotent — safe to re-run.

ALTER TABLE trade_tags
  ADD COLUMN IF NOT EXISTS description text;

-- Seed the 5 canonical user-defined day types with strawman definitions. These
-- are the user's MGI-based terminology; refine in the dashboard if any miss
-- the mark.
UPDATE trade_tags SET description = $$RVOL >= 1.3, expanding ATR-10, clear directional pressure from the open or strong IB extension. Sustained imbalance and little mean reversion within the session.$$
WHERE category = 'day_type' AND label = 'High Action Market';

UPDATE trade_tags SET description = $$RVOL ~0.8-1.2, ATR-10 near 10-day average, no decisive directional commitment. Rotation between levels without expansion; mixed signals with neither side controlling.$$
WHERE category = 'day_type' AND label = 'Medium Mush Market (Indecisive)';

UPDATE trade_tags SET description = $$RVOL < 0.8, tight ATR-10 vs 10-day average, IB narrow relative to 10-day average. Range stays small all session; low participation and compressed price action.$$
WHERE category = 'day_type' AND label = 'Low Participation/Compressed';

UPDATE trade_tags SET description = $$RTH opens INSIDE both prior day's range (PDH/PDL) AND overnight range (ONH/ONL) — i.e. fully contained inside both. Strongly favors rotation / Range / compression behavior. Trend Day requires a decisive break of one of these envelopes first.$$
WHERE category = 'day_type' AND label = 'Double Inside (PD + ON)';

UPDATE trade_tags SET description = $$Significant overnight (Globex) directional move that REVERSES during RTH. RTH prints opposite direction from the Globex extension. Typically marked by Globex high/low getting tested and rejected, followed by sustained move the other way.$$
WHERE category = 'day_type' AND label = 'GBX Reversal';

-- The two that leaked back in via the old hardcoded predictor — write
-- definitions for them too so they're functional rather than orphaned, even
-- though they weren't part of the user's intended canonical 5.
UPDATE trade_tags SET description = $$Persistent directional move with sustained imbalance. Little mean reversion intraday; IB extension holds and continues; one-time-framing in the direction of the trend.$$
WHERE category = 'day_type' AND label = 'Trend Day';

UPDATE trade_tags SET description = $$Defined high and low established early (often the IB); price rotates between them all session. Mean reversion dominates; failed auctions at the extremes.$$
WHERE category = 'day_type' AND label = 'Range Day';
