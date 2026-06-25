-- ============================================================
-- Trading Journal — MULTI-TENANT schema (public/testing version)
-- ============================================================
-- Run this ONCE in the SQL editor of a NEW, dedicated Supabase project.
-- Do NOT run it on your personal single-user project — that one keeps using
-- supabase/schema.sql. This file is the public, multi-tenant variant: every
-- per-user table carries a `user_id` defaulting to auth.uid(), and RLS scopes
-- rows to their owner, so testers can never see each other's data.
--
-- Design notes:
--  * `user_id ... default auth.uid()` means app INSERTs auto-fill the owner —
--    no app code change needed. RLS auto-filters SELECTs the same way.
--  * Shared reference tables (performance_stats, condition_*, lookup_metadata)
--    are global and read-only to authenticated users; you seed them via SQL.
--  * New users get the default tag library seeded automatically by a trigger
--    on auth.users (see bottom of file).

create extension if not exists "uuid-ossp";

-- ============================================================
-- trading_days
-- ============================================================
create table if not exists trading_days (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  date date not null,
  chart_screenshot_url text,
  day_type text,
  day_types text[] default '{}'::text[],
  prep_notes_json jsonb default '{}',
  ai_analysis_json jsonb default '{}',
  eod_notes text,
  eod_pnl numeric(10,2),
  eod_chart_screenshot_url text,
  chart_calibration_json jsonb,
  eod_ai_analysis_json jsonb default '{}',
  last_sc_import_at timestamptz,
  last_sc_import_filename text,
  prep_started_at timestamptz,
  prep_completed_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, date)            -- date unique PER USER, not globally
);
create index if not exists trading_days_user_idx on trading_days(user_id, date);

-- ============================================================
-- market_context
-- ============================================================
create table if not exists market_context (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  trading_day_id uuid not null references trading_days(id) on delete cascade,
  symbol text not null default 'NQ',
  pdh numeric(10,2), pdl numeric(10,2),
  ibh numeric(10,2), ibl numeric(10,2),
  onh numeric(10,2), onl numeric(10,2),
  rvol numeric(6,2),
  ib_size numeric(10,2),
  ib_vs_10d_avg numeric(6,2),
  adr numeric(10,2),
  day_range numeric(10,2),
  atr_1m numeric(10,2),
  stat_performance_json jsonb default '{}',
  created_at timestamptz default now()
);
create unique index if not exists market_context_day_idx on market_context(trading_day_id);
create index if not exists market_context_user_idx on market_context(user_id);

-- ============================================================
-- trades
-- ============================================================
create table if not exists trades (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  trading_day_id uuid not null references trading_days(id) on delete cascade,
  entry_time timestamptz,
  entry_price numeric(10,2),
  exit_time timestamptz,
  exit_price numeric(10,2),
  stop_price numeric(10,2),
  tp1_price numeric(10,2),
  direction text check (direction in ('long', 'short')),
  quantity integer,
  pnl numeric(10,2),
  screenshot_url text,
  entry_pin_x numeric(7,4), entry_pin_y numeric(7,4),
  stop_pin_x numeric(7,4),  stop_pin_y numeric(7,4),
  tp1_pin_x numeric(7,4),   tp1_pin_y numeric(7,4),
  sierra_trade_id text,
  symbol text,
  high_during_position numeric(10,2),
  low_during_position numeric(10,2),
  exits_json jsonb,
  tags_json jsonb default '{}',
  notes text,
  recording_commentary jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, sierra_trade_id)   -- SC id unique PER USER (multiple NULLs allowed)
);
create index if not exists trades_day_idx on trades(trading_day_id);
create index if not exists trades_user_idx on trades(user_id);

-- ============================================================
-- trade_tags  (PER-USER library, seeded on signup — see trigger below)
-- ============================================================
create table if not exists trade_tags (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  category text not null check (category in (
    'setups', 'confluences', 'order_flow', 'trade_management', 'day_type', 'mistakes', 'emotions'
  )),
  label text not null,
  sort_order integer default 0,
  description text,
  created_at timestamptz default now(),
  unique (user_id, category, label)   -- per-user uniqueness
);
create index if not exists trade_tags_user_idx on trade_tags(user_id, category);

-- ============================================================
-- daily_prep  (PER-USER; PK now composite)
-- ============================================================
create table if not exists daily_prep (
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  trade_date date not null,
  rvol numeric, dr_adr numeric, ib numeric, atr_730 numeric, atr_entry numeric,
  matched_median_condition_id text,
  matched_tertile_condition_id text,
  consolidated_verdict text,
  conflict_flag boolean default false,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  primary key (user_id, trade_date)
);

-- ============================================================
-- chart_prefs  (PER-USER; PK now composite)
-- ============================================================
create table if not exists chart_prefs (
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  key text not null,
  value jsonb not null,
  updated_at timestamptz default now(),
  primary key (user_id, key)
);

-- ============================================================
-- bar_imports / ohlcv_bars  (PER-USER; empty in cloud — no .scid source)
-- ============================================================
create table if not exists ohlcv_bars (
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  symbol text not null,
  ts timestamptz not null,
  open numeric(12,2) not null, high numeric(12,2) not null,
  low numeric(12,2) not null,  close numeric(12,2) not null,
  volume bigint,
  primary key (user_id, symbol, ts)
);
create index if not exists ohlcv_bars_user_symbol_ts_idx on ohlcv_bars(user_id, symbol, ts desc);

create table if not exists bar_imports (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  symbol text not null,
  granularity text not null check (granularity in ('1m', '5m', '15m', '1h', '1d')),
  date_range_start date not null,
  date_range_end date not null,
  rows_inserted integer, rows_updated integer,
  source_filename text,
  imported_at timestamptz default now()
);
create index if not exists bar_imports_user_idx on bar_imports(user_id, imported_at desc);

-- ============================================================
-- historical_trades  (PER-USER Tradezella import)
-- ============================================================
create table if not exists historical_trades (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  source text not null default 'tradezella',
  account text, symbol text,
  side text check (side in ('long', 'short')),
  status text,
  open_at timestamptz, close_at timestamptz, trade_date date,
  entry_price numeric, exit_price numeric, quantity numeric,
  net_pnl numeric, gross_pnl numeric, net_roi numeric,
  realized_rr numeric, reward_ratio numeric, trade_risk numeric,
  position_mfe numeric, position_mae numeric, price_mfe numeric, price_mae numeric,
  duration_sec numeric, rating numeric, zella_score numeric,
  tags_json jsonb default '{}',
  raw_json jsonb,
  dedup_key text,
  imported_at timestamptz default now(),
  unique (user_id, dedup_key)
);
create index if not exists historical_trades_user_date_idx on historical_trades(user_id, trade_date);

-- ============================================================
-- eod_themes_analysis  (PER-USER cached AI themes)
-- ============================================================
create table if not exists eod_themes_analysis (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  from_date date not null, to_date date not null,
  prompt_version integer not null default 1,
  themes_json jsonb not null,
  notes_count integer, total_chars integer,
  model text default 'claude-sonnet-4-6',
  generated_at timestamptz default now(),
  unique (user_id, from_date, to_date, prompt_version)
);
create index if not exists eod_themes_user_range_idx on eod_themes_analysis(user_id, from_date, to_date, prompt_version);

-- ============================================================
-- SHARED reference tables (global, read-only to users; you seed via SQL)
-- ============================================================
create table if not exists performance_stats (
  id uuid primary key default uuid_generate_v4(),
  category text not null check (category in ('rvol', 'ib_sizing', 'adr', 'atr')),
  label text not null,
  range_low numeric(10,2), range_high numeric(10,2),
  stat_data_json jsonb default '{}',
  sort_order integer default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists perf_stats_category_idx on performance_stats(category);

create table if not exists condition_thresholds (
  metric text primary key,
  median numeric not null, tertile_low numeric not null, tertile_high numeric not null,
  updated_at timestamptz default now()
);

create table if not exists condition_lookup (
  condition_id text primary key,
  combo_type text not null, specificity integer not null,
  verdict text not null, verdict_rank integer not null,
  rvol_b text not null, dr_adr_b text not null, ib_b text not null,
  atr_730_b text not null, atr_entry_b text not null,
  n_trades integer, n_sessions integer, n_adequate boolean, n_reliable boolean,
  trade_wr numeric, trade_wr_ci_lo numeric, trade_wr_ci_hi numeric,
  day_wr numeric, ev_per_trade numeric, ev_ci_lo numeric, ev_ci_hi numeric,
  ev_ci_excludes_zero boolean, total_pnl numeric, profit_factor numeric,
  wr_pval_vs_baseline numeric, wr_sig_5pct boolean, match_priority integer
);
create index if not exists condition_lookup_combo_idx on condition_lookup(combo_type, specificity desc, verdict_rank asc);
create index if not exists condition_lookup_buckets_idx on condition_lookup(rvol_b, dr_adr_b, ib_b, atr_730_b, atr_entry_b);

create table if not exists lookup_metadata (
  key text primary key,
  value jsonb,
  updated_at timestamptz default now()
);

-- ============================================================
-- Row Level Security
-- ============================================================
-- Per-user tables: owner-only.
do $$
declare t text;
begin
  foreach t in array array[
    'trading_days','market_context','trades','trade_tags','daily_prep',
    'chart_prefs','ohlcv_bars','bar_imports','historical_trades','eod_themes_analysis'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "owner_all" on %I', t);
    execute format(
      'create policy "owner_all" on %I for all using (auth.uid() = user_id) with check (auth.uid() = user_id)', t);
  end loop;
end $$;

-- Shared reference tables: read-only to any authenticated user.
do $$
declare t text;
begin
  foreach t in array array[
    'performance_stats','condition_thresholds','condition_lookup','lookup_metadata'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "auth_read" on %I', t);
    execute format(
      'create policy "auth_read" on %I for select using (auth.role() = ''authenticated'')', t);
  end loop;
end $$;

-- ============================================================
-- Seed the default tag library for every new user (on signup)
-- ============================================================
create or replace function public.seed_default_tags()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.trade_tags (user_id, category, label, sort_order) values
    (new.id,'setups','IB Fade',1),(new.id,'setups','IB Breakout',2),
    (new.id,'setups','Opening Range Break',3),(new.id,'setups','VWAP Reclaim',4),
    (new.id,'setups','VWAP Reject',5),(new.id,'setups','Level Bounce',6),
    (new.id,'setups','Level Break',7),(new.id,'setups','Failed Auction',8),
    (new.id,'setups','Gap Fill',9),(new.id,'setups','PDH/PDL Test',10),
    (new.id,'confluences','At PDH',1),(new.id,'confluences','At PDL',2),
    (new.id,'confluences','At IBH',3),(new.id,'confluences','At IBL',4),
    (new.id,'confluences','At ONH',5),(new.id,'confluences','At ONL',6),
    (new.id,'confluences','VWAP Confluence',7),(new.id,'confluences','Volume Node',8),
    (new.id,'confluences','Gap Edge',9),(new.id,'confluences','Round Number',10),
    (new.id,'order_flow','Absorption',1),(new.id,'order_flow','Exhaustion',2),
    (new.id,'order_flow','Delta Divergence',3),(new.id,'order_flow','Stacked Imbalance',4),
    (new.id,'order_flow','Iceberg Detected',5),(new.id,'order_flow','Aggressive Buyers',6),
    (new.id,'order_flow','Aggressive Sellers',7),
    (new.id,'trade_management','Full Size',1),(new.id,'trade_management','Scaled In',2),
    (new.id,'trade_management','Scaled Out at TP1',3),(new.id,'trade_management','Runner Left',4),
    (new.id,'trade_management','Stopped Out',5),(new.id,'trade_management','Early Exit',6),
    (new.id,'trade_management','Moved Stop to BE',7),
    (new.id,'day_type','Trend Day',1),(new.id,'day_type','Range Day',2),
    (new.id,'day_type','Neutral Day',3),(new.id,'day_type','Gap and Go',4),
    (new.id,'day_type','Gap Reversal',5),(new.id,'day_type','Double Distribution',6),
    (new.id,'day_type','Volatile/News Day',7),
    (new.id,'mistakes','Chased Entry',1),(new.id,'mistakes','FOMO Trade',2),
    (new.id,'mistakes','Oversized',3),(new.id,'mistakes','Ignored Stop',4),
    (new.id,'mistakes','Moved Stop Against Trade',5),(new.id,'mistakes','Took B-Grade Setup',6),
    (new.id,'mistakes','Traded Outside Plan',7),(new.id,'mistakes','Overtraded',8),
    (new.id,'mistakes','Revenge Trade',9),
    (new.id,'emotions','Calm/Focused',1),(new.id,'emotions','Confident',2),
    (new.id,'emotions','Patient',3),(new.id,'emotions','Anxious',4),
    (new.id,'emotions','Hesitant',5),(new.id,'emotions','Frustrated',6),
    (new.id,'emotions','Fearful',7),(new.id,'emotions','Greedy',8),
    (new.id,'emotions','Impulsive',9),(new.id,'emotions','Overconfident',10)
  on conflict (user_id, category, label) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.seed_default_tags();

-- ============================================================
-- Storage buckets (create in dashboard, then apply per-user RLS)
-- ============================================================
-- Create buckets 'screenshots' and 'sc-logs' in Storage, then run a policy
-- like the below per bucket so users only touch their own folder
-- (objects must be stored under a top-level folder = the user's id):
--
--   create policy "own_folder" on storage.objects for all to authenticated
--     using   (bucket_id = 'screenshots' and (storage.foldername(name))[1] = auth.uid()::text)
--     with check (bucket_id = 'screenshots' and (storage.foldername(name))[1] = auth.uid()::text);
--
-- NOTE: the app currently uploads screenshots without a per-user folder prefix.
-- See DEPLOY_RUNBOOK.md → "Storage" for the small upload-path change needed
-- before turning the folder policy on. For early testing you may keep a simpler
-- "authenticated can read/write the bucket" policy and tighten later.
