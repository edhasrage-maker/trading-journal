-- ============================================================================
-- 20260704_demo_readonly.public.sql
-- ⚠️  PUBLIC / multi-tenant project ONLY (dmutgkycrjudfejswvhg — tapescore.app).
--     Do NOT run against your personal single-user project.
-- ============================================================================
--
-- Database backstop that makes the seeded "Explore the demo" account READ-ONLY.
--
-- The primary gate is src/middleware.ts (rejects every non-GET /api request from
-- the demo session — all app writes go through /api). This adds defense-in-depth
-- at the row level so that even a direct PostgREST write using the demo session's
-- JWT is refused: for each user-data table we add RESTRICTIVE policies that deny
-- INSERT / UPDATE / DELETE when auth.uid() is the demo user. SELECT is untouched,
-- so the demo user still reads its own seeded rows normally.
--
-- RESTRICTIVE policies AND with the existing permissive owner policies, so real
-- users are unaffected (their uid != demo passes the restriction, then their
-- own owner policy governs). The demo uid is inlined as a literal at migration
-- time, so there is no per-write lookup against auth.users.
--
-- PREREQ: the demo user must already exist (run scripts/seed-demo.ts first).
--         If it doesn't, this migration is a safe no-op.
-- Idempotent: drops+recreates its own named policies; re-running is a no-op.
-- ============================================================================

do $$
declare
  demo_uid uuid;
  t text;
  tables text[] := array[
    'trading_days', 'trades', 'market_context', 'trade_tags',
    'daily_prep', 'user_settings', 'trader_profiles', 'annotations',
    'weekly_recaps', 'condition_thresholds', 'condition_lookup',
    'condition_lookup_meta', 'shares'
  ];
begin
  select id into demo_uid from auth.users where lower(email) = 'demo@tapescore.app';
  if demo_uid is null then
    raise notice 'demo user not found — skipping demo read-only RLS (run seed-demo.ts first)';
    return;
  end if;

  foreach t in array tables loop
    -- Only touch tables that actually exist in this project.
    if to_regclass('public.' || t) is null then
      raise notice 'table % absent — skipped', t;
      continue;
    end if;

    execute format('alter table public.%I enable row level security', t);

    execute format('drop policy if exists "demo_readonly_no_insert" on public.%I', t);
    execute format('drop policy if exists "demo_readonly_no_update" on public.%I', t);
    execute format('drop policy if exists "demo_readonly_no_delete" on public.%I', t);

    execute format(
      'create policy "demo_readonly_no_insert" on public.%I as restrictive for insert with check (auth.uid() <> %L)',
      t, demo_uid);
    execute format(
      'create policy "demo_readonly_no_update" on public.%I as restrictive for update using (auth.uid() <> %L)',
      t, demo_uid);
    execute format(
      'create policy "demo_readonly_no_delete" on public.%I as restrictive for delete using (auth.uid() <> %L)',
      t, demo_uid);
  end loop;
end $$;
