-- 2026-10-25 — Launch funnel.                                    (PUBLIC project)
--
-- Run once in the PUBLIC (tapescore.app) Supabase project's SQL editor.
-- Safe to re-run. Until it has run, the app's funnel writes fail quietly and
-- nothing else changes.
--
-- WHAT IT MEASURES
--   Where new traders drop off, in our own database — no third-party
--   analytics, no tracking cookies:
--
--     landing visit → signed up → added first trades → got a TapeScore → came back
--
--   funnel_events holds one row per account per milestone, written by the app
--   the first time it happens (src/lib/funnel.ts). The demo account and the
--   admin are never counted. "came_back" is the first full app visit on a
--   later Pacific-time day than the sign-up.
--
--   landing_visits_daily is a bare count of signed-out landing page views per
--   Pacific-time day. Nothing about the visitor is stored, obvious bots are
--   skipped, and anyone can bump it (it's a rough top-of-funnel number).
--
-- HOW TO READ IT (in this SQL editor, which sees every row)
--   select * from public.funnel_by_week;

-- ── Milestones ──────────────────────────────────────────────────────────────
create table if not exists public.funnel_events (
  user_id    uuid        not null references auth.users(id) on delete cascade default auth.uid(),
  event      text        not null check (event in ('signed_up', 'first_trades', 'first_score', 'came_back')),
  created_at timestamptz not null default now(),
  primary key (user_id, event)
);

comment on table public.funnel_events is
  'Launch funnel: one row per account per milestone (signed_up, first_trades, first_score, came_back), first occurrence only.';

alter table public.funnel_events enable row level security;

drop policy if exists "funnel_events_owner_insert" on public.funnel_events;
create policy "funnel_events_owner_insert" on public.funnel_events
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "funnel_events_owner_read" on public.funnel_events;
create policy "funnel_events_owner_read" on public.funnel_events
  for select to authenticated using (auth.uid() = user_id);

-- ── Landing visits ──────────────────────────────────────────────────────────
create table if not exists public.landing_visits_daily (
  day    date    primary key,
  visits integer not null default 0
);

comment on table public.landing_visits_daily is
  'Signed-out landing page views per Pacific-time day. A bare count — nothing about the visitor is stored.';

-- No policies: only record_landing_visit() writes it, and it is read here.
alter table public.landing_visits_daily enable row level security;

create or replace function public.record_landing_visit()
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.landing_visits_daily (day, visits)
  values ((now() at time zone 'America/Los_Angeles')::date, 1)
  on conflict (day) do update set visits = landing_visits_daily.visits + 1;
$$;

revoke all on function public.record_landing_visit() from public;
grant execute on function public.record_landing_visit() to anon, authenticated;

-- ── The weekly read ─────────────────────────────────────────────────────────
-- One row per sign-up week (Monday, Pacific time). Each column after
-- signed_up counts that week's sign-ups who reached the step, so the row reads
-- left to right as a funnel. security_invoker keeps RLS in force for anyone
-- querying it through the API (they see only themselves); this editor sees all.
create or replace view public.funnel_by_week with (security_invoker = true) as
with signups as (
  select
    date_trunc('week', s.created_at at time zone 'America/Los_Angeles')::date as week_of,
    exists (select 1 from public.funnel_events e
            where e.user_id = s.user_id and e.event = 'first_trades') as added_trades,
    exists (select 1 from public.funnel_events e
            where e.user_id = s.user_id and e.event = 'first_score') as got_a_score,
    exists (select 1 from public.funnel_events e
            where e.user_id = s.user_id and e.event = 'came_back'
              and e.created_at < s.created_at + interval '7 days') as came_back_7d
  from public.funnel_events s
  where s.event = 'signed_up'
),
weekly as (
  select week_of,
    count(*)                               as signed_up,
    count(*) filter (where added_trades)   as added_trades,
    count(*) filter (where got_a_score)    as got_a_score,
    count(*) filter (where came_back_7d)   as came_back_within_7_days
  from signups
  group by week_of
),
visits as (
  select date_trunc('week', day)::date as week_of, sum(visits)::bigint as landing_visits
  from public.landing_visits_daily
  group by 1
)
select
  coalesce(w.week_of, v.week_of)          as week_of,
  coalesce(v.landing_visits, 0)           as landing_visits,
  coalesce(w.signed_up, 0)                as signed_up,
  coalesce(w.added_trades, 0)             as added_trades,
  coalesce(w.got_a_score, 0)              as got_a_score,
  coalesce(w.came_back_within_7_days, 0)  as came_back_within_7_days
from weekly w
full outer join visits v on v.week_of = w.week_of
order by 1 desc;
