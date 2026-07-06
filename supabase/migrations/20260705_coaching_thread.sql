-- 2026-07-05 — Coaching thread (distilled session memory for the AI coach).
--
-- A curated record of what the coach told the trader to work on + the
-- commitments they made, distilled from finished coach conversations by
-- /api/coach/distill (one Sonnet call, fired when a chat is archived). Fed back
-- into buildCoachContext so the coach FOLLOWS UP next session instead of
-- starting cold. NOT raw transcripts — a handful of structured, reconcilable
-- action-items. Mirrors the eod_themes_analysis cache pattern.
--
-- Run on BOTH the personal DB and the public/testing DB. On the public project,
-- schema.public.sql adds user_id + owner RLS on top (this file is the base shape).

create table if not exists coaching_thread (
  id uuid primary key default uuid_generate_v4(),
  category text not null default 'other',       -- exits|entries|risk|sizing|psychology|process|other
  directive text not null,                      -- what the coach advised
  commitment text,                              -- what the trader agreed to (nullable)
  evidence_hint text,                           -- a metric/behavior to check next time
  status text not null default 'open',          -- open|followed_up|resolved|dropped
  source text not null default 'coach_chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- Live-item lookup (fetchOpenThread filters status in ('open','followed_up')
-- newest-first) is the hot path.
create index if not exists coaching_thread_status_idx
  on coaching_thread(status, created_at desc);

alter table coaching_thread enable row level security;
drop policy if exists "Authenticated full access" on coaching_thread;
create policy "Authenticated full access" on coaching_thread
  for all using (auth.role() = 'authenticated');
