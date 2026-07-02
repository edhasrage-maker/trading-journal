-- Commission-per-side setting on the per-user trader_profile row.
--
-- Applied at import time to logs that carry NO commission of their own
-- (Sierra Chart exports gross P&L). Round-turn cost = commission_per_side × 2.
-- Sources that already include commission (NinjaTrader grid = per-fill
-- commission; Tradezella = Net P&L) are left untouched. 0 = no adjustment.
--
-- Run in the Supabase SQL editor. Idempotent.
alter table trader_profile
  add column if not exists commission_per_side numeric not null default 0;
