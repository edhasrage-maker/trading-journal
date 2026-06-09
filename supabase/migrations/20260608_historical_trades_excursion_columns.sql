-- 2026-06-08 — Add bar-derived MFE/MAE columns to historical_trades.
--
-- The Tradezella export already populates `position_mfe` / `position_mae` /
-- `price_mfe` / `price_mae` from TZ's own analytics, but the trader does
-- not trust those values. These two new columns mirror the shape of
-- `trades.high_during_position` / `trades.low_during_position` so analytics
-- can derive MFE/MAE uniformly across native + historical trades.
--
-- Backfill is run via `scripts/backfill-historical-mfe.ts` (CSV-driven).
-- Trades outside the CSV's date range stay null and analytics treats them
-- the same way it treats native trades missing excursion data.

alter table historical_trades
  add column if not exists high_during_position numeric(10,2),
  add column if not exists low_during_position  numeric(10,2);
