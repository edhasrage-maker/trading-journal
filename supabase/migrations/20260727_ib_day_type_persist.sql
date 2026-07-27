-- IB day-type Phase 2 (Pt 23): persist the day-CHARACTER read and bucket the
-- condition_lookup by it.
--
-- Phase 1 classified today's IB live on the prep page (choppy / normal /
-- expanded via IB ÷ meanHL10, small / normal / large via ib_vs_10d_avg) but
-- threw the result away on reload. Persisting it lets the trader's ACTUAL
-- trades bucket by day character — the "am I capturing the choppy-day edge?"
-- loop.
--
-- Two halves:
--   1. market_context gains the RTH IB/ATR-regime read. Both the raw inputs
--      (ib_meanhl10, ib_atr_ratio) and the classified bands (ib_regime,
--      ib_size_band) are stored: the ratios are what the lookup buckets on, the
--      band words are what the UI reads and they pin the cut version at write
--      time so a later retune doesn't silently rewrite history.
--   2. condition_lookup's dead 5th dimension is repurposed. ATR_entry has
--      always been null (deriveMetrics never captured a per-trade ATR) and was
--      retired from the UI in ConditionFilterPanel; 105 of every user's 236
--      lookup rows constrained it with n=0. Renaming the column to ib_atr_b
--      turns those dead rows into the day-character buckets at zero footprint
--      cost. A condition_lookup refresh must follow this migration — the
--      existing rows' ib_atr_b values are stale ATR_entry buckets.
--
-- trading_days.day_types[] is deliberately untouched: those are hand-tagged
-- with hindsight and drive dashboard/analytics day-type P&L. The derived read
-- is honest-at-07:30 and stays separate.

alter table market_context
  -- Study-native IB ATR: mean(High−Low) of the last 10 IB 1-min bars. NOT
  -- Wilder — atr_at_ib_close runs ~3% smaller and is a labelled fallback only.
  add column if not exists ib_meanhl10   numeric(10,3),
  -- ib_size / ib_meanhl10. The day-character metric the lookup buckets on.
  add column if not exists ib_atr_ratio  numeric(10,3),
  -- 'chop' | 'mid' | 'expanded' at the cuts in ib-day-type.ts (7.7 / 13).
  add column if not exists ib_regime     text,
  -- 'small' | 'normal' | 'large' at SIZE_CUTS (0.75 / 1.25) on ib_vs_10d_avg.
  add column if not exists ib_size_band  text;

alter table condition_lookup rename column atr_entry_b to ib_atr_b;
-- The per-day prep snapshot records the values that were looked up, so it
-- follows the same rename (it has always stored null here).
alter table daily_prep rename column atr_entry to ib_atr;

drop index if exists condition_lookup_buckets_idx;
create index condition_lookup_buckets_idx
  on condition_lookup(rvol_b, dr_adr_b, ib_b, atr_730_b, ib_atr_b);

-- The retired metric's threshold row would otherwise linger and be re-read by
-- assignBuckets. The refresh rewrites thresholds wholesale, but clear it now so
-- the table is consistent the moment the migration lands.
delete from condition_thresholds where metric = 'ATR_entry';
