-- 2026-08-11 — Monthly recap synthesis + freeform notes.
--
-- The monthly sibling of weekly_recap (20260617): one row per calendar month
-- keyed by the month's first date. Stores:
--   - ai_synthesis_json: the structured recap /api/analyze-month generates
--     (cached so the trader doesn't re-spend tokens on every page load)
--   - notes_md: the trader's own freeform monthly review
--
-- A separate table, NOT weekly_recap rows keyed on the 1st — a month whose
-- 1st falls on a Monday would collide with that real week's row.
--
-- On the PUBLIC (multi-tenant) DB, run 20260811_monthly_recap.public.sql
-- INSTEAD — it creates the same table per-user (user_id + owner RLS).

create table if not exists monthly_recap (
  month_start_date date primary key,
  ai_synthesis_json jsonb,
  notes_md text not null default '',
  generated_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table monthly_recap enable row level security;
drop policy if exists "monthly_recap_all" on monthly_recap;
create policy "monthly_recap_all" on monthly_recap
  for all using (auth.role() = 'authenticated');
