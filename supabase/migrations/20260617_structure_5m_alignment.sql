-- 2026-06-17 — Per-trade 5m-structure alignment ('following' / 'fading' / 'neutral').
--
-- Simple, deterministic signal: at the trade's entry minute, aggregate the
-- day's 1m bars into 5m bars, compute Wilder EMA-20 of 5m closes, compare
-- the bar's close to the EMA:
--
--   close > EMA-20 → uptrend
--   close < EMA-20 → downtrend
--   |close − EMA| / close < 0.02% → neutral (avoid noise around the line)
--
-- Then by trade direction:
--   long  + uptrend   → 'following'
--   long  + downtrend → 'fading'
--   short + downtrend → 'following'
--   short + uptrend   → 'fading'
--
-- Auto-populated at SC-import time by /api/import-sc-log (same pattern as
-- mfe_dollars_per_leg). Existing trades get backfilled by
-- scripts/backfill-structure-5m-alignment.ts. Trades without bar coverage
-- stay null and display "—" in the trade list.
--
-- Usage:
--   - Filter analytics by "Structure Alignment" to see win rate of
--     following vs fading trades
--   - Coach can reference it ("3 of your 4 losses today were fading 5m
--     structure into a trend day")

alter table trades
  add column if not exists structure_5m_alignment text
  check (structure_5m_alignment is null or structure_5m_alignment in ('following', 'fading', 'neutral'));
