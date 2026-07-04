-- ============================================================================
-- 20260703_condition_lookup_per_user.public.sql
-- ⚠️  PUBLIC / multi-tenant project ONLY (dmutgkycrjudfejswvhg — tapescore.app).
--     Do NOT run against your personal single-user project.
-- ============================================================================
--
-- Converts the Morning Conditions methodology from a single SHARED table into
-- PER-USER buckets, so each trader's prep grades come from their own history and
-- the nightly Vercel cron (/api/cron/refresh-condition-lookup) can keep every
-- user fresh. Mirrors the tenancy applied to the other per-user tables in
-- schema.public.sql (owner RLS `auth.uid() = user_id`, composite PKs).
--
-- BEFORE RUNNING: replace <FOUNDER_UUID> with your public-project auth uuid
-- (Supabase → Authentication → Users) — the same value you used as
-- TARGET_USER_ID in scripts/migrate-to-public.ts. It re-homes the existing
-- global rows to you so your conditions keep working immediately.
--
-- Idempotent: re-running is a no-op (guards on column/PK/policy existence).
-- ============================================================================

-- 1. Add user_id (nullable first so we can backfill the existing global rows) --
alter table public.condition_thresholds add column if not exists user_id uuid references auth.users(id) on delete cascade default auth.uid();
alter table public.condition_lookup     add column if not exists user_id uuid references auth.users(id) on delete cascade default auth.uid();

-- 2. Re-home existing global rows to the founder ------------------------------
update public.condition_thresholds set user_id = '<FOUNDER_UUID>' where user_id is null;
update public.condition_lookup     set user_id = '<FOUNDER_UUID>' where user_id is null;

-- 3. Enforce NOT NULL ---------------------------------------------------------
alter table public.condition_thresholds alter column user_id set not null;
alter table public.condition_lookup     alter column user_id set not null;

-- 4. Recompose primary keys to include user_id (idempotent) -------------------
do $$
declare c text;
begin
  if not exists (
    select 1 from pg_constraint con
    join unnest(con.conkey) ak(attnum) on true
    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = ak.attnum
    where con.conrelid = 'public.condition_thresholds'::regclass and con.contype = 'p' and a.attname = 'user_id'
  ) then
    select conname into c from pg_constraint where conrelid = 'public.condition_thresholds'::regclass and contype = 'p';
    if c is not null then execute format('alter table public.condition_thresholds drop constraint %I', c); end if;
    alter table public.condition_thresholds add primary key (user_id, metric);
  end if;

  if not exists (
    select 1 from pg_constraint con
    join unnest(con.conkey) ak(attnum) on true
    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = ak.attnum
    where con.conrelid = 'public.condition_lookup'::regclass and con.contype = 'p' and a.attname = 'user_id'
  ) then
    select conname into c from pg_constraint where conrelid = 'public.condition_lookup'::regclass and contype = 'p';
    if c is not null then execute format('alter table public.condition_lookup drop constraint %I', c); end if;
    alter table public.condition_lookup add primary key (user_id, condition_id);
  end if;
end $$;

create index if not exists condition_thresholds_user_idx on public.condition_thresholds(user_id);
create index if not exists condition_lookup_user_idx     on public.condition_lookup(user_id);

-- 5. Swap shared-read RLS for owner RLS ---------------------------------------
-- "for all" lets a user rebuild their OWN buckets via the Settings button while
-- the service-role cron rebuilds everyone's (service role bypasses RLS).
do $$
declare t text; p record;
begin
  foreach t in array array['condition_thresholds','condition_lookup'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy if exists %I on public.%I', p.policyname, t);
    end loop;
    execute format(
      $f$create policy "Owner access" on public.%I
           for all using (auth.uid() = user_id) with check (auth.uid() = user_id)$f$, t);
  end loop;
end $$;

-- 6. Per-user vintage (replaces the single lookup_metadata key) ----------------
create table if not exists public.condition_lookup_meta (
  user_id          uuid primary key references auth.users(id) on delete cascade default auth.uid(),
  refreshed_at     timestamptz,
  lookup_row_count integer,
  updated_at       timestamptz default now()
);
alter table public.condition_lookup_meta enable row level security;
drop policy if exists "Owner access" on public.condition_lookup_meta;
create policy "Owner access" on public.condition_lookup_meta
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Seed the founder's vintage from the old global key so the badge isn't blank
-- until the first refresh (best-effort; harmless if the key is absent).
insert into public.condition_lookup_meta (user_id, refreshed_at, lookup_row_count)
select '<FOUNDER_UUID>',
       (value->>'at')::timestamptz,
       (select count(*) from public.condition_lookup where user_id = '<FOUNDER_UUID>')
from public.lookup_metadata where key = 'condition_lookup_refreshed_at'
on conflict (user_id) do nothing;
