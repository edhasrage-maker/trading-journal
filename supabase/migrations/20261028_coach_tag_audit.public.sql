-- 2026-10-28 — Coach tag audit.                                  (PUBLIC project)
--
-- Run once in the PUBLIC (tapescore.app) Supabase project's SQL editor.
-- Safe to re-run. Until it has run, the app's audit writes fail quietly and
-- nothing else changes.
--
-- WHAT IT HOLDS
--   One row per tag the coach picked on a trade (from a screenshot, the notes,
--   the 5m follow/fade read, or an assisted fill), plus the tags the trader
--   already had on that trade when the coach first picked ('before', so they
--   never count as tags the coach missed).
--
--   The outcome is read against the trade's tags as they are NOW, so a tag
--   taken off anywhere (trade form, Deep Dive, weekly review) counts:
--     on the trade + decision 'kept'           → kept (the trader's ✓)
--     on the trade, put on by the coach, no ✓  → to check
--     on the trade, a suggestion they clicked  → kept
--     not on the trade                         → taken off
--   A tag on a coach-tagged trade that no row names = one the coach missed.
--   Rule tags, day types and emotions are never counted (src/lib/coach-tag-audit.ts).
--
--   Owner-only: every row belongs to one trader and can only point at that
--   trader's own trades. Nothing is pooled across traders.

create table if not exists public.coach_tag_audit (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  trade_id    uuid        not null references public.trades(id) on delete cascade,
  category    text        not null,
  label       text        not null,
  source      text        not null check (source in ('screenshot', 'notes', 'structure', 'assist', 'before')),
  applied     boolean     not null default false,
  conf        text        check (conf in ('H', 'M', 'L')),
  reason      text,
  proposed_at timestamptz not null default now(),
  decision    text        check (decision in ('kept', 'removed')),
  decided_at  timestamptz,
  unique (trade_id, category, label, source)
);

comment on table public.coach_tag_audit is
  'Tags the coach picked per trade and the trader''s call on each (kept / taken off), read against the trade''s current tags. Owner-only.';

create index if not exists coach_tag_audit_user_trade_idx on public.coach_tag_audit(user_id, trade_id);

alter table public.coach_tag_audit enable row level security;

drop policy if exists "Owner access" on public.coach_tag_audit;
create policy "Owner access" on public.coach_tag_audit
  for all to authenticated
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (select 1 from public.trades t where t.id = trade_id and t.user_id = auth.uid())
  );
