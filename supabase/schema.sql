-- Trading Journal Database Schema
-- Run this in your Supabase SQL editor to create all tables

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ============================================================
-- trading_days: one record per trading day
-- ============================================================
create table if not exists trading_days (
  id uuid primary key default uuid_generate_v4(),
  date date not null unique,
  chart_screenshot_url text,
  day_type text, -- e.g. 'trend', 'range', 'gap-and-go', populated from prep notes
  prep_notes_json jsonb default '{}',
  -- prep_notes_json shape:
  -- {
  --   ib_behaviour: string,
  --   ib_extension_pct: number,
  --   ib_max_retracement_pct: number,
  --   volume_profile_shape: string,
  --   volume_profile_notes: string,
  --   bias: 'bullish'|'bearish'|'neutral',
  --   bias_notes: string,
  --   setups_areas: string,
  --   mood: string,
  --   market_clarity: string
  -- }
  ai_analysis_json jsonb default '{}',
  -- ai_analysis_json shape: { summary: string, flags: string[], score: number }
  eod_notes text,
  eod_pnl numeric(10,2),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
-- market_context: MGI levels and stats for each day
-- ============================================================
create table if not exists market_context (
  id uuid primary key default uuid_generate_v4(),
  trading_day_id uuid not null references trading_days(id) on delete cascade,
  symbol text not null default 'NQ',
  pdh numeric(10,2),
  pdl numeric(10,2),
  ibh numeric(10,2),
  ibl numeric(10,2),
  onh numeric(10,2),
  onl numeric(10,2),
  rvol numeric(6,2),
  ib_size numeric(10,2),
  ib_vs_10d_avg numeric(6,2), -- ratio, e.g. 1.2 = 20% above avg
  adr numeric(10,2),
  atr_1m numeric(10,2),
  stat_performance_json jsonb default '{}',
  -- stat_performance_json shape:
  -- {
  --   rvol: { label: string, win_rate: number, avg_r: number },
  --   ib_size: { label: string, win_rate: number, avg_r: number },
  --   adr: { label: string, win_rate: number, avg_r: number },
  --   atr: { label: string, win_rate: number, avg_r: number }
  -- }
  created_at timestamptz default now()
);

create unique index if not exists market_context_day_idx on market_context(trading_day_id);

-- ============================================================
-- trades: individual trades (from intraday tagging + SC import)
-- ============================================================
create table if not exists trades (
  id uuid primary key default uuid_generate_v4(),
  trading_day_id uuid not null references trading_days(id) on delete cascade,
  entry_time timestamptz,
  entry_price numeric(10,2),
  stop_price numeric(10,2),
  tp1_price numeric(10,2),
  direction text check (direction in ('long', 'short')),
  quantity integer,
  pnl numeric(10,2),
  screenshot_url text,
  entry_pin_x numeric(7,4), -- x as 0-100 percentage of image width (sub-pixel precision via 4 decimal places)
  entry_pin_y numeric(7,4),
  stop_pin_x numeric(7,4),
  stop_pin_y numeric(7,4),
  tp1_pin_x numeric(7,4),
  tp1_pin_y numeric(7,4),
  sierra_trade_id text unique, -- reference from SC import for de-duplication; UNIQUE constraint (not just an index) so Supabase JS upsert can use ON CONFLICT (sierra_trade_id)
  tags_json jsonb default '{}',
  -- tags_json shape:
  -- {
  --   setups: string[],
  --   confluences: string[],
  --   order_flow: string[],
  --   trade_management: string[],
  --   day_type: string,
  --   mistakes: string[],
  --   emotions: string[]
  -- }
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists trades_day_idx on trades(trading_day_id);
-- Unique constraint on sierra_trade_id is declared inline on the column above
-- (as `text unique`). Multiple NULLs are allowed by default — trades entered
-- manually without a Sierra Chart fill ID don't collide with each other.

-- ============================================================
-- trade_tags: the available tag library
-- ============================================================
create table if not exists trade_tags (
  id uuid primary key default uuid_generate_v4(),
  category text not null check (category in (
    'setups', 'confluences', 'order_flow', 'trade_management', 'day_type', 'mistakes', 'emotions'
  )),
  label text not null,
  sort_order integer default 0,
  created_at timestamptz default now(),
  unique(category, label)
);

-- Seed default tags
insert into trade_tags (category, label, sort_order) values
  -- Setups
  ('setups', 'IB Fade', 1),
  ('setups', 'IB Breakout', 2),
  ('setups', 'Opening Range Break', 3),
  ('setups', 'VWAP Reclaim', 4),
  ('setups', 'VWAP Reject', 5),
  ('setups', 'Level Bounce', 6),
  ('setups', 'Level Break', 7),
  ('setups', 'Failed Auction', 8),
  ('setups', 'Gap Fill', 9),
  ('setups', 'PDH/PDL Test', 10),
  -- Confluences
  ('confluences', 'At PDH', 1),
  ('confluences', 'At PDL', 2),
  ('confluences', 'At IBH', 3),
  ('confluences', 'At IBL', 4),
  ('confluences', 'At ONH', 5),
  ('confluences', 'At ONL', 6),
  ('confluences', 'VWAP Confluence', 7),
  ('confluences', 'Volume Node', 8),
  ('confluences', 'Gap Edge', 9),
  ('confluences', 'Round Number', 10),
  -- Order Flow
  ('order_flow', 'Absorption', 1),
  ('order_flow', 'Exhaustion', 2),
  ('order_flow', 'Delta Divergence', 3),
  ('order_flow', 'Stacked Imbalance', 4),
  ('order_flow', 'Iceberg Detected', 5),
  ('order_flow', 'Aggressive Buyers', 6),
  ('order_flow', 'Aggressive Sellers', 7),
  -- Trade Management
  ('trade_management', 'Full Size', 1),
  ('trade_management', 'Scaled In', 2),
  ('trade_management', 'Scaled Out at TP1', 3),
  ('trade_management', 'Runner Left', 4),
  ('trade_management', 'Stopped Out', 5),
  ('trade_management', 'Early Exit', 6),
  ('trade_management', 'Moved Stop to BE', 7),
  -- Day Types
  ('day_type', 'Trend Day', 1),
  ('day_type', 'Range Day', 2),
  ('day_type', 'Neutral Day', 3),
  ('day_type', 'Gap and Go', 4),
  ('day_type', 'Gap Reversal', 5),
  ('day_type', 'Double Distribution', 6),
  ('day_type', 'Volatile/News Day', 7),
  -- Mistakes
  ('mistakes', 'Chased Entry', 1),
  ('mistakes', 'FOMO Trade', 2),
  ('mistakes', 'Oversized', 3),
  ('mistakes', 'Ignored Stop', 4),
  ('mistakes', 'Moved Stop Against Trade', 5),
  ('mistakes', 'Took B-Grade Setup', 6),
  ('mistakes', 'Traded Outside Plan', 7),
  ('mistakes', 'Overtraded', 8),
  ('mistakes', 'Revenge Trade', 9),
  -- Emotions
  ('emotions', 'Calm/Focused', 1),
  ('emotions', 'Confident', 2),
  ('emotions', 'Patient', 3),
  ('emotions', 'Anxious', 4),
  ('emotions', 'Hesitant', 5),
  ('emotions', 'Frustrated', 6),
  ('emotions', 'Fearful', 7),
  ('emotions', 'Greedy', 8),
  ('emotions', 'Impulsive', 9),
  ('emotions', 'Overconfident', 10)
on conflict (category, label) do nothing;

-- ============================================================
-- performance_stats: lookup table for stat ranges
-- ============================================================
create table if not exists performance_stats (
  id uuid primary key default uuid_generate_v4(),
  category text not null check (category in ('rvol', 'ib_sizing', 'adr', 'atr')),
  label text not null,
  range_low numeric(10,2),
  range_high numeric(10,2),
  stat_data_json jsonb default '{}',
  -- stat_data_json shape:
  -- { win_rate: number, avg_r: number, sample_size: number, notes: string }
  sort_order integer default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists perf_stats_category_idx on performance_stats(category);

-- ============================================================
-- Phase 5: EOD Recap additions
-- ============================================================
alter table trading_days
  add column if not exists eod_chart_screenshot_url text,
  add column if not exists chart_calibration_json jsonb,
  -- chart_calibration_json shape:
  -- {
  --   high:  { x_pct, y_pct, price },
  --   low:   { x_pct, y_pct, price },
  --   start: { x_pct, y_pct, time: 'HH:MM' },
  --   end:   { x_pct, y_pct, time: 'HH:MM' },
  --   calibrated_at: ISO timestamp
  -- }
  add column if not exists eod_ai_analysis_json jsonb default '{}',
  add column if not exists last_sc_import_at timestamptz,
  add column if not exists last_sc_import_filename text;

alter table trades
  add column if not exists exit_time timestamptz,
  add column if not exists exit_price numeric(10,2);

-- ============================================================
-- Prep timing: when prep started and when last edit happened.
-- Used to analyze performance vs time-of-arrival-at-desk and prep duration.
-- ============================================================
alter table trading_days
  add column if not exists prep_started_at timestamptz,
  add column if not exists prep_completed_at timestamptz;

-- ============================================================
-- Condition Lookup feature (morning prep condition filter)
-- ============================================================
-- Lives alongside the existing journal but is independent — sourced from
-- trading-studies repo. Refreshed via /settings/condition-lookup upload.

-- Per-metric bucket cutpoints. 5 rows total (one per metric).
create table if not exists condition_thresholds (
  metric text primary key,                  -- RVOL | DR_ADR | IB | ATR_730 | ATR_entry
  median numeric not null,
  tertile_low numeric not null,
  tertile_high numeric not null,
  updated_at timestamptz default now()
);

-- The main lookup table — ~235 rows, one per condition combination.
create table if not exists condition_lookup (
  condition_id text primary key,
  combo_type text not null,                 -- BASELINE | 1-way_median | 1-way_tertile | 2-way_median | 2-way_tertile | 3-way_median
  specificity integer not null,             -- 0..3
  verdict text not null,                    -- GREEN_ROBUST | GREEN_DIRECTIONAL | RED_DIRECTIONAL | YELLOW_FLAT_POS | YELLOW_FLAT_NEG | INSUFFICIENT_DATA
  verdict_rank integer not null,            -- 1..6 (lower = better)
  rvol_b text not null,                     -- LOW/HIGH (median) | L/M/H (tertile) | ANY
  dr_adr_b text not null,
  ib_b text not null,
  atr_730_b text not null,
  atr_entry_b text not null,
  n_trades integer,
  n_sessions integer,
  n_adequate boolean,
  n_reliable boolean,
  trade_wr numeric,
  trade_wr_ci_lo numeric,
  trade_wr_ci_hi numeric,
  day_wr numeric,
  ev_per_trade numeric,
  ev_ci_lo numeric,
  ev_ci_hi numeric,
  ev_ci_excludes_zero boolean,
  total_pnl numeric,
  profit_factor numeric,
  wr_pval_vs_baseline numeric,
  wr_sig_5pct boolean,
  match_priority integer
);

-- Composite index supporting the lookup query's filter + sort
create index if not exists condition_lookup_combo_idx
  on condition_lookup(combo_type, specificity desc, verdict_rank asc);
create index if not exists condition_lookup_buckets_idx
  on condition_lookup(rvol_b, dr_adr_b, ib_b, atr_730_b, atr_entry_b);

-- Per-day condition prep snapshot. Independent of trading_days — the trader
-- logs conditions at 7:30 AM regardless of whether they end up trading.
create table if not exists daily_prep (
  trade_date date primary key,
  rvol numeric,
  dr_adr numeric,
  ib numeric,
  atr_730 numeric,
  atr_entry numeric,                        -- optional, may be null if not yet entering
  matched_median_condition_id text,
  matched_tertile_condition_id text,
  consolidated_verdict text,
  conflict_flag boolean default false,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Generic key-value table for app-wide metadata (e.g. lookup vintage).
-- Reusable for future flag-type values.
create table if not exists lookup_metadata (
  key text primary key,
  value jsonb,
  updated_at timestamptz default now()
);

-- ============================================================
-- Row Level Security
-- ============================================================
alter table trading_days enable row level security;
alter table market_context enable row level security;
alter table trades enable row level security;
alter table trade_tags enable row level security;
alter table performance_stats enable row level security;
alter table condition_thresholds enable row level security;
alter table condition_lookup enable row level security;
alter table daily_prep enable row level security;
alter table lookup_metadata enable row level security;

-- Policy: authenticated users can read/write their own data
-- (single-user journal — all authenticated users own all rows)
drop policy if exists "Authenticated full access" on trading_days;
drop policy if exists "Authenticated full access" on market_context;
drop policy if exists "Authenticated full access" on trades;
drop policy if exists "Authenticated read/write tags" on trade_tags;
drop policy if exists "Authenticated full access" on performance_stats;

create policy "Authenticated full access" on trading_days
  for all using (auth.role() = 'authenticated');

create policy "Authenticated full access" on market_context
  for all using (auth.role() = 'authenticated');

create policy "Authenticated full access" on trades
  for all using (auth.role() = 'authenticated');

create policy "Authenticated read/write tags" on trade_tags
  for all using (auth.role() = 'authenticated');

create policy "Authenticated full access" on performance_stats
  for all using (auth.role() = 'authenticated');

drop policy if exists "Authenticated full access" on condition_thresholds;
drop policy if exists "Authenticated full access" on condition_lookup;
drop policy if exists "Authenticated full access" on daily_prep;
drop policy if exists "Authenticated full access" on lookup_metadata;

create policy "Authenticated full access" on condition_thresholds
  for all using (auth.role() = 'authenticated');

create policy "Authenticated full access" on condition_lookup
  for all using (auth.role() = 'authenticated');

create policy "Authenticated full access" on daily_prep
  for all using (auth.role() = 'authenticated');

create policy "Authenticated full access" on lookup_metadata
  for all using (auth.role() = 'authenticated');

-- ============================================================
-- Storage buckets (run separately in Supabase dashboard or CLI)
-- ============================================================
-- Bucket: 'screenshots'  (for chart + trade entry screenshots)
-- Bucket: 'sc-logs'      (for Sierra Chart trade log uploads)
