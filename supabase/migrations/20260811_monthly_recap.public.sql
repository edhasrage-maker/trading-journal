-- 2026-08-11 — Monthly recap, PUBLIC (multi-tenant) variant.
--
-- Same table as 20260811_monthly_recap.sql but per-user from birth, matching
-- how schema.public.sql recomposed weekly_recap: user_id auto-fills from
-- auth.uid() on insert, the natural key becomes (user_id, month_start_date),
-- and owner-only RLS scopes every row to its account.

create table if not exists public.monthly_recap (
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  month_start_date date not null,
  ai_synthesis_json jsonb,
  notes_md text not null default '',
  generated_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, month_start_date)
);

alter table public.monthly_recap enable row level security;
drop policy if exists "monthly_recap_owner" on public.monthly_recap;
create policy "monthly_recap_owner" on public.monthly_recap
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
