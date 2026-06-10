-- 2026-06-09 — Per-leg MFE max-possible dollars on trades.
--
-- The simple captureRatio uses
--   mfeDollars = peak_MFE_pts × full_initial_quantity × multiplier
-- which assumes the trader could've held every contract to the peak. For
-- scaled-out trades that's mathematically impossible — once a leg exits at
-- TP1 +20 pts it can't possibly capture more, even if price runs to +25
-- later. The result systematically understates the trader's actual capture
-- skill on multi-leg trades.
--
-- This column stores the honest per-leg ceiling: walk exits_json
-- chronologically, find the highest favorable price seen between each
-- leg's window-start (= prev exit OR trade entry_time) and its exit time,
-- and sum leg_qty × leg_window_peak × multiplier across legs.
--
-- Populated by scripts/backfill-per-leg-mfe.ts (reads 1m bars from the CSV
-- + NQM6.scid hybrid we already use for backfill-historical-mfe). Future
-- imports populate at insert time. Null when bars don't cover the trade's
-- entry → final exit window OR when exits_json is missing AND we fall back
-- to the simple formula at read time.

alter table trades
  add column if not exists mfe_dollars_per_leg numeric(10,2);

alter table historical_trades
  add column if not exists mfe_dollars_per_leg numeric(10,2);
