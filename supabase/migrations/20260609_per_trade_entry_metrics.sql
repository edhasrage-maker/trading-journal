-- 2026-06-09 — Per-trade entry-time ATR + RVOL columns.
--
-- Current state: analytics joins each trade to its day's market_context row,
-- so every trade on a given day inherits the same RVOL/ATR values. This is
-- correct for day-level questions but lossy for "how did I perform when
-- volatility was actually X at the minute I entered" — the late-morning
-- trade and the late-afternoon trade on the same day get bucketed identically
-- even though they faced very different conditions.
--
-- New columns capture per-trade snapshots at the entry minute:
--   entry_atr_1m — Wilder's ATR-10 1m value at the bar containing entry_time
--   entry_rvol   — cumulative volume from RTH open through entry minute,
--                  divided by the 10-day average of the same window
--                  (percent; 100 = average pace)
--
-- Daily Prep continues to use the 07:30 PT snapshot fields
-- (atr_at_ib_close, rvol_at_ib_close) for categorizing day type — those
-- represent "what was visible at IB close, the moment you make the trading
-- decision". Different question, different data.
--
-- Backfill is run via scripts/backfill-entry-metrics.ts. Scoped to 2025+
-- trades only (per the trader's preference — older trades pre-date the
-- TZ workflow and aren't worth the multi-contract .scid plumbing).
-- Pre-2025 trades stay null and analytics falls back to day-level values.

alter table trades
  add column if not exists entry_atr_1m numeric(10,2),
  add column if not exists entry_rvol   numeric(6,2);

alter table historical_trades
  add column if not exists entry_atr_1m numeric(10,2),
  add column if not exists entry_rvol   numeric(6,2);
