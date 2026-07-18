-- Dashboard per-day stats materialization (Pt 10, phase 2).
-- See docs/dashboard-stats-materialization-plan.md.
--
-- Steady-state the dashboard reads ~250 tiny trading_days rows and fetches ZERO
-- trades/analysis blobs. `stats_json` holds the per-day rollup produced by the
-- shared pure function src/lib/day-stats.ts::computeDayStats (everything it
-- returns EXCEPT the columns that already live on the row: id, date, day_type,
-- day_types, achievements_json). `stats_version` lets a formula change
-- invalidate every cached row at once (bump STATS_VERSION in day-stats and the
-- read path treats every older row as dirty).
--
-- Runs on BOTH databases (personal + cloud). RLS: covered by the existing
-- trading_days row policy — no new policy needed. Idempotent.

alter table trading_days
  add column if not exists stats_json jsonb,
  add column if not exists stats_version smallint;

-- ── Invalidation layer 1: DB triggers null the cache on any input change ──
-- Authoritative and path-proof: no app path can leave a stale cache behind,
-- regardless of which route wrote the data. The read-through fill + the
-- app-level recompute (layer 2) are optimizations on top of this.
--
-- stats_json is derived from (a) the day's trades, (b) market_context.atr_1m,
-- (c) ai_analysis_json / eod_ai_analysis_json / eod_pnl / day_types on the day.

-- trades + market_context → null the PARENT day's cache.
create or replace function public.invalidate_day_stats_from_child()
returns trigger
language plpgsql
as $$
begin
  -- On UPDATE a row could move between days (rare) — invalidate both parents.
  if (tg_op = 'DELETE') then
    update trading_days set stats_json = null where id = old.trading_day_id;
    return old;
  else
    update trading_days set stats_json = null where id = new.trading_day_id;
    if (tg_op = 'UPDATE' and new.trading_day_id is distinct from old.trading_day_id) then
      update trading_days set stats_json = null where id = old.trading_day_id;
    end if;
    return new;
  end if;
end;
$$;

drop trigger if exists trg_trades_invalidate_day_stats on trades;
create trigger trg_trades_invalidate_day_stats
  after insert or update or delete on trades
  for each row execute function public.invalidate_day_stats_from_child();

drop trigger if exists trg_market_context_invalidate_day_stats on market_context;
create trigger trg_market_context_invalidate_day_stats
  after insert or update or delete on market_context
  for each row execute function public.invalidate_day_stats_from_child();

-- trading_days self-update → null the cache when a stats INPUT column changed.
-- BEFORE UPDATE so it edits NEW in place (no recursive UPDATE). A pure
-- stats_json/stats_version write (recomputeDayStats) leaves the input columns
-- unchanged, so this preserves the freshly-written cache — the app therefore
-- MUST write stats_json in a SEPARATE update from any input-column mutation.
create or replace function public.invalidate_day_stats_on_self_update()
returns trigger
language plpgsql
as $$
begin
  -- Inputs to the STORED rollup fields. achievements_json is intentionally
  -- excluded: it is not stored in stats_json (it has its own column and is
  -- merged at read time), so a coin earned does not dirty the stats cache.
  if (new.ai_analysis_json is distinct from old.ai_analysis_json
      or new.eod_ai_analysis_json is distinct from old.eod_ai_analysis_json
      or new.eod_pnl is distinct from old.eod_pnl
      or new.day_types is distinct from old.day_types
      or new.day_type is distinct from old.day_type) then
    new.stats_json := null;
    new.stats_version := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_trading_days_invalidate_stats on trading_days;
create trigger trg_trading_days_invalidate_stats
  before update on trading_days
  for each row execute function public.invalidate_day_stats_on_self_update();
