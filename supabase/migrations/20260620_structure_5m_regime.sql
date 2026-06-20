-- Pivot market-structure regime per trade (Phase 2 of the follow/fade port).
-- bull / bear / neutral / insufficient, computed from the HH-HL zig-zag over a
-- continuous NQ front-month 5m series (see scripts/backfill-structure-regime.ts
-- and src/lib/market-structure.ts). Distinct from structure_5m_alignment, which
-- is the simpler EMA-20 following/fading signal. follow/fade derives from
-- (side, regime) at read time.
alter table trades add column if not exists structure_5m_regime text
  check (structure_5m_regime is null or structure_5m_regime in ('bull', 'bear', 'neutral', 'insufficient'));

alter table historical_trades add column if not exists structure_5m_regime text
  check (structure_5m_regime is null or structure_5m_regime in ('bull', 'bear', 'neutral', 'insufficient'));
