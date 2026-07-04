-- Per-user AI model tier (public/multi-tenant build).
--
-- Default model for every AI feature is Sonnet. A user is upgraded to Opus
-- either implicitly (the app admin, resolved from ADMIN_EMAIL / the local
-- build) or explicitly by an admin flipping their tier here. This table holds
-- ONLY the explicit grants; admin-by-email needs no row.
--
-- READS: the owner may read their own tier (an AI route resolves the model from
-- the caller's own row). WRITES: only the service-role admin route
-- (/api/admin/model-tiers) — never the client — so a user can't self-upgrade.
-- Run in the Supabase SQL editor. Idempotent.

create table if not exists public.ai_model_grants (
  user_id    uuid primary key references auth.users(id) on delete cascade default auth.uid(),
  tier       text not null default 'basic' check (tier in ('basic','opus')),
  updated_at timestamptz not null default now()
);

alter table public.ai_model_grants enable row level security;

-- Owner may READ their own tier; the service role (admin route) bypasses RLS
-- for the list + write paths, so no INSERT/UPDATE policy is granted here.
drop policy if exists "Owner reads own tier" on public.ai_model_grants;
create policy "Owner reads own tier" on public.ai_model_grants
  for select using (auth.uid() = user_id);
