-- 2026-06-17 — Trader profile / coaching preferences.
--
-- Standing context the trader provides about their style, system, and
-- preferences. Injected into every AI prompt so the coach respects the
-- trader's actual approach instead of generic critiques.
--
-- Examples of content:
--   - "My system is a 2-ATR scalp — don't critique me for not capturing
--      more MFE after that target."
--   - "I trade MNQ only — don't reference NQ or other instruments."
--   - "I take a forced break after 2 losses by rule — don't flag short
--      trade counts as overtrading restraint or undertrading."
--
-- Single-row table (single-user app). `id` is a fixed string so updates
-- always target the same row via upsert. RLS matches every other table.

create table if not exists trader_profile (
  id text primary key default 'default',
  preferences_md text not null default '',
  updated_at timestamptz not null default now()
);

alter table trader_profile enable row level security;

create policy "trader_profile_all"
  on trader_profile
  for all
  using (auth.role() = 'authenticated');

-- Seed the single default row so subsequent reads always find something
-- without needing an upsert fallback.
insert into trader_profile (id, preferences_md)
values ('default', '')
on conflict (id) do nothing;
