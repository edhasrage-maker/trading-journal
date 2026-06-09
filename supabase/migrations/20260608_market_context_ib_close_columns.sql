-- 2026-06-08 — Add IB-close-snapshot columns to market_context.
--
-- The existing rvol/atr_1m fields snapshot end-of-RTH (12:59 PT close).
-- For the day-type classifier we need IB-close snapshots (07:29 PT) so
-- the "by 07:30" labels honestly reflect what was visible at IB close
-- rather than cheating with hindsight from later in the session.
--
-- Plus two more fields: the RTH open price and the IB close price, both
-- needed for the Trend/Range/Double-Inside structural classification.
-- atr_10d_avg is the trailing-10 baseline of atr_at_ib_close, used by
-- the High-Action threshold (atr_at_ib_close ≥ 1.2× atr_10d_avg).
--
-- All values are computed from the 1m CSV by the extended
-- backfill-market-context-from-csv.ts script (Wilder's ATR-10 streamed
-- bar-by-bar; volume aggregated over 06:30-07:29 window for rvol_at_ib_close).

alter table market_context
  add column if not exists rvol_at_ib_close   numeric(6,2),  -- percent: vol 06:30-07:29 / 10d avg same window × 100
  add column if not exists atr_at_ib_close    numeric(10,2), -- Wilder's ATR-10 1m at 07:29 PT bar
  add column if not exists atr_10d_avg        numeric(10,2), -- trailing-10 avg of atr_at_ib_close
  add column if not exists rth_open           numeric(10,2), -- close of 06:30 PT bar
  add column if not exists ib_close_price     numeric(10,2); -- close of 07:29 PT bar
