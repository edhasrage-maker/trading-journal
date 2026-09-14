-- ============================================================================
-- Session volume profile — tick-true volume-at-price, one row per session
-- ============================================================================
-- Market data, like ohlcv_bars: identical for every user, written only by the
-- central feed (service role, which bypasses RLS), readable by anyone — a
-- logged-out visitor on a share link included, since the shared chart draws it.
--
-- Why a table at all, instead of computing from ohlcv_bars: a profile built by
-- spreading each 1-minute bar's volume across its range misplaces the POC. On
-- ES 2026-09-14 RTH it put the POC at 7,634; the true POC — and the one Sierra
-- draws — is 7,625. The value area survived smearing, the POC did not. Only the
-- machine holding the .scid tick files can compute the real thing, so it
-- publishes the result here.
--
-- `rows` is [[price, volume, ask, bid], ...] ascending by price, contiguous in
-- ticks. One session of ES is ~230 rows, so a jsonb blob per session is simpler
-- and cheaper than a row per price. POC / VAH / VAL are stored alongside so a
-- list view or the coach can read them without unpacking the rows.
--
-- `session` is 'rth' (06:30–13:15 PT, CME's day session) today; the key leaves
-- room for 'eth' / overnight profiles later without a schema change.
--
-- Idempotent. Safe to re-run.
create table if not exists public.session_volume_profile (
  symbol       text        not null,                 -- mini root: 'ES', 'NQ'
  date         date        not null,                 -- PT session date
  session      text        not null default 'rth',
  tick         numeric     not null,
  rows         jsonb       not null,
  poc          numeric     not null,
  vah          numeric     not null,
  val          numeric     not null,
  total_volume bigint      not null,
  trades       bigint      not null,
  source       text        not null default 'scid',
  computed_at  timestamptz not null default now(),
  primary key (symbol, date, session)
);

comment on table public.session_volume_profile is
  'Tick-true session volume profile per mini root and PT date, published by the central .scid feed. rows = [[price, volume, ask, bid], ...] ascending.';

alter table public.session_volume_profile enable row level security;

drop policy if exists "Shared read" on public.session_volume_profile;
create policy "Shared read" on public.session_volume_profile
  for select to anon, authenticated using (true);

grant select on public.session_volume_profile to anon, authenticated;
