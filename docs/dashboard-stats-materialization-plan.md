# Dashboard per-day stats materialization

**Goal:** the dashboard currently fetches every trade + every AI analysis blob
for ~18 months (start-of-last-year → today) on each load, then computes ~28
derived fields per day. That is round-trip- and data-bound and scales badly on a
real account. Materialize the per-day rollup so a steady-state dashboard reads
~250 tiny rows and fetches **zero** trades/blobs.

## The one shared function (correctness anchor)

`src/lib/day-stats.ts` → `computeDayStats(day, trades, prepAtr): DayStatsRollup`
— a PURE extraction of the exact per-day computation that lives inline in
`dashboard/page.tsx` today (win counts, avg MFE/MAE pts+$+×ATR, capture, heat,
process_score / process_v13_score / overall_grade / process_verdict /
process_breach_rules, tapescore, setups, atr). The SAME function runs at
write-time (to fill the cache) and at read-time (fallback for a dirty day), so a
cached row and a freshly computed row are byte-identical by construction. No
second implementation to drift.

## Storage

`trading_days.stats_json JSONB` — the rollup for that day (everything
`computeDayStats` returns EXCEPT what already lives in columns: id, date,
day_type, day_types, achievements_json). Plus `stats_version SMALLINT` so a
formula change can invalidate every row at once (bump the constant → all rows
read as dirty). Migration: `supabase/migrations/`; run live on Supabase, then
mirror into `supabase/schema.sql`.

## Invalidation (the crux)

`stats_json` is derived from (a) the day's `trades`, (b) `market_context.atr_1m`,
(c) `ai_analysis_json` + `eod_ai_analysis_json` + `eod_pnl` + `day_types` on the
day. It is stale if any of those changed after it was written.

**Two layers, belt-and-suspenders:**

1. **DB triggers null the cache on any data change** (authoritative, path-proof):
   - `AFTER INSERT/UPDATE/DELETE ON trades` → set parent `trading_days.stats_json = NULL`.
   - `AFTER INSERT/UPDATE/DELETE ON market_context` → same.
   - `BEFORE UPDATE ON trading_days`: if `ai_analysis_json` / `eod_ai_analysis_json`
     / `eod_pnl` / `day_types` changed, set `NEW.stats_json = NULL`.
   This guarantees correctness regardless of which app path wrote the data —
   nothing can leave a stale cache behind.

2. **App recompute at the known mutation points** (optimization, keeps caches warm):
   after import, analyze-eod, analyze-prep, trade edit/delete, market-context
   write → call `recomputeDayStats(sb, dayId)` (fetch that one day's inputs,
   `computeDayStats`, write `stats_json` + `stats_version`). Best-effort; if it's
   skipped, layer 1 + the read-through below still keep results correct.

## Read path (dashboard)

1. `SELECT id, date, day_type, day_types, achievements_json, stats_json, stats_version`
   over the window (one query, no blobs, no trades).
2. Partition: **fresh** = `stats_json != null && stats_version == CURRENT`;
   **dirty** = the rest.
3. For dirty days only, fetch their trades + contexts + analysis blobs (bounded
   to the few recently-changed days), run `computeDayStats`, and best-effort
   write `stats_json` back (read-through fill). Demo/read-only users can't write
   → they just recompute each load (correct, uncached).
4. Assemble the display list from fresh rollups + freshly computed dirty ones.

Steady state (no recent changes): step 3 fetches nothing → the dashboard is one
lightweight query.

## Backfill

`scripts/backfill-day-stats.ts` — walk all `trading_days`, compute + write
`stats_json`. Idempotent; safe to re-run. Run once after the migration; new/edited
days self-heal via triggers + read-through.

## Build order (each independently shippable + verifiable)

1. **Extract `computeDayStats`** and refactor the dashboard to call it — ZERO
   behavior change; verify the demo's numbers are identical before/after.
2. Migration (`stats_json` + `stats_version`) + triggers; mirror schema.sql.
3. `recomputeDayStats` helper + backfill script; run backfill.
4. Dashboard read-through (fresh vs dirty partition).
5. Wire `recomputeDayStats` into the mutation routes.

Rollback at any step: if `stats_json` is absent/ignored, the dashboard falls back
to the current full compute (step 1 leaves that path intact).
