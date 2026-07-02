-- ============================================================================
-- schema.public.sql — MULTI-TENANT OVERLAY for the public / testing build
-- ============================================================================
--
-- WHAT THIS IS
--   A catalog-driven overlay that converts the single-user `schema.sql` into a
--   multi-tenant, per-user-isolated schema. It is intentionally NOT a fork of
--   schema.sql — keeping the table *shapes* defined in exactly one place
--   (schema.sql) avoids the drift that a 600-line duplicate would guarantee.
--   This file only adds the tenancy layer on top: a `user_id` column, owner
--   RLS, composite natural keys, shared-read-only reference tables, and a
--   signup trigger that seeds each new user's tag library.
--
-- HOW TO RUN (fresh public Supabase project — see docs/DEPLOY_RUNBOOK.md)
--   1. SQL Editor → paste ALL of `supabase/schema.sql`        → Run
--   2. SQL Editor → paste ALL of `supabase/schema.public.sql` → Run   (this file)
--   Order matters: this overlay ALTERs tables that schema.sql creates.
--
--   ⚠️  Do NOT run this against your PERSONAL single-user project. It is only
--       for the separate, multi-tenant public project.
--
-- IDEMPOTENT
--   Safe to re-run. Each block checks whether its change is already applied
--   (column exists / PK or UNIQUE already includes user_id / policy present)
--   before acting, so a second run is a no-op rather than an error.
--
-- TENANCY MODEL
--   Per-user (owner RLS `auth.uid() = user_id`, default `auth.uid()`):
--     trading_days, market_context, trades, trade_tags, daily_prep,
--     chart_prefs, bar_imports, historical_trades,
--     eod_themes_analysis, trader_profile, weekly_recap, chart_annotations
--   Shared read-only (any authenticated user may SELECT; writes via service
--   role only, which bypasses RLS):
--     performance_stats, condition_thresholds, condition_lookup, lookup_metadata,
--     ohlcv_bars  (market bars are identical for every user — fed centrally)
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Add `user_id` to every per-user table (nullable first; NOT NULL set below
--    once the legacy global tag seed rows have been removed).
-- ----------------------------------------------------------------------------
do $$
declare
  t text;
  peruser text[] := array[
    'trading_days','market_context','trades','trade_tags','daily_prep',
    'chart_prefs','bar_imports','historical_trades',
    'eod_themes_analysis','trader_profile','weekly_recap','chart_annotations'
  ];
begin
  foreach t in array peruser loop
    execute format(
      'alter table public.%I add column if not exists user_id uuid '
      || 'references auth.users(id) on delete cascade default auth.uid()',
      t
    );
  end loop;
end $$;


-- ----------------------------------------------------------------------------
-- 2. Remove the global tag seed that schema.sql inserts.
--    In multi-tenant the tag library is PER USER and is seeded by the signup
--    trigger (section 7). The schema.sql seed rows have a NULL user_id (the
--    column didn't exist when they were inserted) and would otherwise be
--    invisible-but-present clutter. Scoped to user_id IS NULL so re-running
--    this overlay never touches real users' tags.
-- ----------------------------------------------------------------------------
delete from public.trade_tags where user_id is null;


-- ----------------------------------------------------------------------------
-- 3. Enforce NOT NULL on user_id for every per-user table.
--    On a fresh public project these tables are empty (trade_tags was just
--    cleared), so this is safe.
-- ----------------------------------------------------------------------------
do $$
declare
  t text;
  peruser text[] := array[
    'trading_days','market_context','trades','trade_tags','daily_prep',
    'chart_prefs','bar_imports','historical_trades',
    'eod_themes_analysis','trader_profile','weekly_recap','chart_annotations'
  ];
begin
  foreach t in array peruser loop
    execute format('alter table public.%I alter column user_id set not null', t);
  end loop;
end $$;


-- ----------------------------------------------------------------------------
-- 4. Owner RLS on every per-user table. Drop whatever policies schema.sql left
--    (the permissive "authenticated can see everything" ones) and replace with
--    a single owner policy. `with check` stops a user from inserting/updating
--    rows owned by someone else; the column default fills user_id on insert.
-- ----------------------------------------------------------------------------
do $$
declare
  t text;
  p record;
  peruser text[] := array[
    'trading_days','market_context','trades','trade_tags','daily_prep',
    'chart_prefs','bar_imports','historical_trades',
    'eod_themes_analysis','trader_profile','weekly_recap','chart_annotations'
  ];
begin
  foreach t in array peruser loop
    execute format('alter table public.%I enable row level security', t);
    for p in
      select policyname from pg_policies where schemaname = 'public' and tablename = t
    loop
      execute format('drop policy if exists %I on public.%I', p.policyname, t);
    end loop;
    execute format(
      $f$create policy "Owner access" on public.%I
           for all using (auth.uid() = user_id) with check (auth.uid() = user_id)$f$,
      t
    );
  end loop;
end $$;


-- ----------------------------------------------------------------------------
-- 5. Recompose NATURAL-KEY primary keys to include user_id, so two users can
--    own a row with the same natural key (e.g. both have a daily_prep for the
--    same date). Surrogate-uuid PK tables (trades, trading_days, …) keep their
--    `id` PK and are handled by the UNIQUE recomposition in section 6 instead.
-- ----------------------------------------------------------------------------
do $$
declare
  tbls text[] := array['daily_prep','chart_prefs','trader_profile','weekly_recap'];
  cols text[] := array['user_id, trade_date','user_id, key','user_id, id','user_id, week_start_date'];
  i int;
  c text;
begin
  for i in 1 .. array_length(tbls, 1) loop
    -- Already composite (includes user_id)? Skip — keeps this idempotent.
    if exists (
      select 1
      from pg_constraint con
      join unnest(con.conkey) ak(attnum) on true
      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = ak.attnum
      where con.conrelid = ('public.' || tbls[i])::regclass
        and con.contype = 'p'
        and a.attname = 'user_id'
    ) then
      continue;
    end if;
    -- Drop the existing single-column PK (whatever its name).
    select conname into c
    from pg_constraint
    where conrelid = ('public.' || tbls[i])::regclass and contype = 'p';
    if c is not null then
      execute format('alter table public.%I drop constraint %I', tbls[i], c);
    end if;
    execute format('alter table public.%I add primary key (%s)', tbls[i], cols[i]);
  end loop;
end $$;


-- ----------------------------------------------------------------------------
-- 6. Recompose NATURAL-KEY uniques to include user_id. Drops the single-key
--    UNIQUE constraints schema.sql created and adds the composite form.
--    NB trades.sierra_trade_id and historical_trades.dedup_key stay nullable;
--    Postgres treats NULLs as distinct, so manually-entered trades (no Sierra
--    id) still don't collide. The importer's
--    `onConflict: 'user_id,sierra_trade_id'` depends on the trades unique here.
-- ----------------------------------------------------------------------------
do $$
declare
  tbls text[] := array['trading_days','trades','trade_tags','historical_trades','eod_themes_analysis'];
  cols text[] := array['user_id, date','user_id, sierra_trade_id','user_id, category, label','user_id, dedup_key','user_id, from_date, to_date, prompt_version'];
  i int;
  r record;
begin
  for i in 1 .. array_length(tbls, 1) loop
    -- Already has a UNIQUE that includes user_id? Skip.
    if exists (
      select 1
      from pg_constraint con
      join unnest(con.conkey) ak(attnum) on true
      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = ak.attnum
      where con.conrelid = ('public.' || tbls[i])::regclass
        and con.contype = 'u'
        and a.attname = 'user_id'
    ) then
      continue;
    end if;
    -- Drop every existing UNIQUE constraint (the single-key ones).
    for r in
      select conname from pg_constraint
      where conrelid = ('public.' || tbls[i])::regclass and contype = 'u'
    loop
      execute format('alter table public.%I drop constraint %I', tbls[i], r.conname);
    end loop;
    execute format('alter table public.%I add unique (%s)', tbls[i], cols[i]);
  end loop;
end $$;

-- market_context keeps its one-row-per-day unique INDEX (market_context_day_idx
-- on trading_day_id). trading_day_id is a globally-unique uuid that already
-- belongs to exactly one user's trading_days row, so the index needs no
-- user_id recomposition.


-- ----------------------------------------------------------------------------
-- 6b. ohlcv_bars is SHARED market data, not per-user — the same NQ/ES 1-minute
--     bars serve every user, fed centrally (a local ingest agent or a data
--     vendor), never written by end users. It is intentionally NOT in the
--     per-user list above and gets the shared read-only policy in section 7.
--
--     This block undoes any prior overlay run that tenant-ized it (older
--     versions of this file put ohlcv_bars in the per-user list): drop the owner
--     policy, drop the user_id column (CASCADE takes the composite PK + the
--     user-scoped index with it), and restore the natural (symbol, ts) PK.
--     No-op on a fresh project where user_id was never added. Safe because
--     ohlcv_bars is empty until the central feed populates it.
-- ----------------------------------------------------------------------------
drop policy if exists "Owner access" on public.ohlcv_bars;
alter table public.ohlcv_bars drop column if exists user_id cascade;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ohlcv_bars'::regclass and contype = 'p'
  ) then
    alter table public.ohlcv_bars add primary key (symbol, ts);
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- 7. Shared read-only reference tables. Any authenticated user may read; only
--    the service role (which bypasses RLS) may write. These hold global
--    methodology data, not per-user data, so they intentionally have NO user_id.
-- ----------------------------------------------------------------------------
do $$
declare
  t text;
  p record;
  shared text[] := array['performance_stats','condition_thresholds','condition_lookup','lookup_metadata','ohlcv_bars'];
begin
  foreach t in array shared loop
    execute format('alter table public.%I enable row level security', t);
    for p in
      select policyname from pg_policies where schemaname = 'public' and tablename = t
    loop
      execute format('drop policy if exists %I on public.%I', p.policyname, t);
    end loop;
    execute format(
      $f$create policy "Shared read" on public.%I
           for select using (auth.role() = 'authenticated')$f$,
      t
    );
  end loop;
end $$;


-- ----------------------------------------------------------------------------
-- 8. Indexes for the hot per-user query paths. RLS adds an implicit
--    `where user_id = auth.uid()` to every query, so the user_id-leading
--    indexes below keep the dashboard / analytics / chart reads fast.
-- ----------------------------------------------------------------------------
create index if not exists trades_user_day_idx          on public.trades(user_id, trading_day_id);
create index if not exists trading_days_user_date_idx    on public.trading_days(user_id, date);
create index if not exists market_context_user_day_idx   on public.market_context(user_id, trading_day_id);
create index if not exists historical_trades_user_date_idx on public.historical_trades(user_id, trade_date);
create index if not exists bar_imports_user_idx          on public.bar_imports(user_id, imported_at desc);
create index if not exists chart_annotations_user_day_idx on public.chart_annotations(user_id, trading_day_id);


-- ----------------------------------------------------------------------------
-- 9. Seed each new user's default tag library on signup.
--    SECURITY DEFINER so the function runs as the table owner (bypasses the
--    owner RLS while inserting the new user's rows). The label/category list
--    mirrors the seed in schema.sql.
-- ----------------------------------------------------------------------------
create or replace function public.seed_default_trade_tags(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.trade_tags (user_id, category, label, sort_order) values
    -- Setups
    (p_user_id, 'setups', 'IB Fade', 1),
    (p_user_id, 'setups', 'IB Breakout', 2),
    (p_user_id, 'setups', 'Opening Range Break', 3),
    (p_user_id, 'setups', 'VWAP Reclaim', 4),
    (p_user_id, 'setups', 'VWAP Reject', 5),
    (p_user_id, 'setups', 'Level Bounce', 6),
    (p_user_id, 'setups', 'Level Break', 7),
    (p_user_id, 'setups', 'Failed Auction', 8),
    (p_user_id, 'setups', 'Gap Fill', 9),
    (p_user_id, 'setups', 'PDH/PDL Test', 10),
    -- Confluences
    (p_user_id, 'confluences', 'At PDH', 1),
    (p_user_id, 'confluences', 'At PDL', 2),
    (p_user_id, 'confluences', 'At IBH', 3),
    (p_user_id, 'confluences', 'At IBL', 4),
    (p_user_id, 'confluences', 'At ONH', 5),
    (p_user_id, 'confluences', 'At ONL', 6),
    (p_user_id, 'confluences', 'VWAP Confluence', 7),
    (p_user_id, 'confluences', 'Volume Node', 8),
    (p_user_id, 'confluences', 'Gap Edge', 9),
    (p_user_id, 'confluences', 'Round Number', 10),
    -- Order Flow
    (p_user_id, 'order_flow', 'Absorption', 1),
    (p_user_id, 'order_flow', 'Exhaustion', 2),
    (p_user_id, 'order_flow', 'Delta Divergence', 3),
    (p_user_id, 'order_flow', 'Stacked Imbalance', 4),
    (p_user_id, 'order_flow', 'Iceberg Detected', 5),
    (p_user_id, 'order_flow', 'Aggressive Buyers', 6),
    (p_user_id, 'order_flow', 'Aggressive Sellers', 7),
    -- Trade Management
    (p_user_id, 'trade_management', 'Full Size', 1),
    (p_user_id, 'trade_management', 'Scaled In', 2),
    (p_user_id, 'trade_management', 'Scaled Out at TP1', 3),
    (p_user_id, 'trade_management', 'Runner Left', 4),
    (p_user_id, 'trade_management', 'Stopped Out', 5),
    (p_user_id, 'trade_management', 'Early Exit', 6),
    (p_user_id, 'trade_management', 'Moved Stop to BE', 7),
    -- Day Types
    (p_user_id, 'day_type', 'Trend Day', 1),
    (p_user_id, 'day_type', 'Range Day', 2),
    (p_user_id, 'day_type', 'Neutral Day', 3),
    (p_user_id, 'day_type', 'Gap and Go', 4),
    (p_user_id, 'day_type', 'Gap Reversal', 5),
    (p_user_id, 'day_type', 'Double Distribution', 6),
    (p_user_id, 'day_type', 'Volatile/News Day', 7),
    -- Mistakes
    (p_user_id, 'mistakes', 'Chased Entry', 1),
    (p_user_id, 'mistakes', 'FOMO Trade', 2),
    (p_user_id, 'mistakes', 'Oversized', 3),
    (p_user_id, 'mistakes', 'Ignored Stop', 4),
    (p_user_id, 'mistakes', 'Moved Stop Against Trade', 5),
    (p_user_id, 'mistakes', 'Took B-Grade Setup', 6),
    (p_user_id, 'mistakes', 'Traded Outside Plan', 7),
    (p_user_id, 'mistakes', 'Overtraded', 8),
    (p_user_id, 'mistakes', 'Revenge Trade', 9),
    -- Emotions
    (p_user_id, 'emotions', 'Calm/Focused', 1),
    (p_user_id, 'emotions', 'Confident', 2),
    (p_user_id, 'emotions', 'Patient', 3),
    (p_user_id, 'emotions', 'Anxious', 4),
    (p_user_id, 'emotions', 'Hesitant', 5),
    (p_user_id, 'emotions', 'Frustrated', 6),
    (p_user_id, 'emotions', 'Fearful', 7),
    (p_user_id, 'emotions', 'Greedy', 8),
    (p_user_id, 'emotions', 'Impulsive', 9),
    (p_user_id, 'emotions', 'Overconfident', 10)
  on conflict (user_id, category, label) do nothing;
end $$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.seed_default_trade_tags(new.id);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ----------------------------------------------------------------------------
-- 10. (Optional) Backfill the tag library for users who signed up BEFORE the
--     trigger existed. No-op on a fresh project. Uncomment to run.
-- ----------------------------------------------------------------------------
-- do $$
-- declare u record;
-- begin
--   for u in select id from auth.users loop
--     perform public.seed_default_trade_tags(u.id);
--   end loop;
-- end $$;

-- ============================================================================
-- Storage (run in the Supabase dashboard, not here):
--   Buckets: 'screenshots', 'sc-logs'. For early trusted testing, an
--   "authenticated can read/write" policy per bucket is fine; the per-user
--   folder-prefix hardening (prefix objects with auth.uid()) is a follow-up.
--   See docs/DEPLOY_RUNBOOK.md.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 11. Coach-review share links (public build)
-- ----------------------------------------------------------------------------
-- "Share for review" lets a trader send ONE trading day's interactive chart to
-- a coach with no account. Security model:
--   • A `shares` row maps an unguessable token → one trading_day_id, with an
--     optional expiry and a revoke flag. Owner RLS = users manage only their own.
--   • The PUBLIC /share/<token> page reads via get_shared_day() below — a
--     SECURITY DEFINER function that validates the token and returns ONLY that
--     day's data. So no service-role key is needed on the web host; the function
--     is the single controlled door.
create table if not exists public.shares (
  token uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  trading_day_id uuid not null references public.trading_days(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked boolean not null default false
);
create index if not exists shares_user_idx on public.shares(user_id, created_at desc);

alter table public.shares enable row level security;
drop policy if exists "Owner shares" on public.shares;
create policy "Owner shares" on public.shares
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create or replace function public.get_shared_day(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day_id uuid;
begin
  select trading_day_id into v_day_id
  from public.shares
  where token = p_token
    and not revoked
    and (expires_at is null or expires_at > now());
  if v_day_id is null then
    return null;
  end if;
  return jsonb_build_object(
    'day', (select to_jsonb(td) from public.trading_days td where td.id = v_day_id),
    'trades', (
      select coalesce(jsonb_agg(to_jsonb(t) order by t.entry_time), '[]'::jsonb)
      from public.trades t where t.trading_day_id = v_day_id
    ),
    'market_context', (
      select to_jsonb(mc) from public.market_context mc where mc.trading_day_id = v_day_id
    )
  );
end $$;

grant execute on function public.get_shared_day(uuid) to anon, authenticated;

-- Market bars are public data (NQ/ES prices), so let anon read them — a shared
-- chart must render candles for a logged-out coach. This overrides the
-- authenticated-only "Shared read" policy section 7 set on ohlcv_bars.
drop policy if exists "Shared read" on public.ohlcv_bars;
drop policy if exists "Public read" on public.ohlcv_bars;
create policy "Public read" on public.ohlcv_bars for select using (true);
-- ============================================================================
