-- 2026-07-05 — Post-exit continuation on trades.
--
-- What price did in the 30 minutes AFTER exit: how far it continued in the
-- trade's direction (favorable) vs how far it reversed against it (against),
-- in points. This is NOT an exit-timing grade — it's a MARKET-SENSE /
-- directional-read signal: did the trader's read keep working after they were
-- out (favorable) or did the market reverse against their bias (against).
--
-- Computed by postExitExtension() (src/lib/atr.ts, 30-min window) — already
-- surfaced live in the EOD table. These columns persist it so the coach can
-- aggregate it across the window without recomputing from bars per request.
-- Backfilled by scripts/backfill-post-exit.ts.

alter table trades
  add column if not exists post_exit_favorable_pts numeric,
  add column if not exists post_exit_against_pts numeric;
