-- 2026-06-17 — Weekly recap synthesis + freeform notes.
--
-- One row per week keyed by Monday's date. Stores:
--   - ai_synthesis_json: the structured recap Claude generates (cached so
--     the trader doesn't re-spend tokens on every page load)
--   - notes_md: the trader's own freeform weekly review
--
-- The synthesis is computed by /api/analyze-week, which uses the SAME
-- buildCoachContext helper as the chatbox, guaranteeing the recap and
-- the chatbox agree on overlapping data.

create table if not exists weekly_recap (
  week_start_date date primary key,
  ai_synthesis_json jsonb,
  notes_md text not null default '',
  generated_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table weekly_recap enable row level security;
drop policy if exists "weekly_recap_all" on weekly_recap;
create policy "weekly_recap_all" on weekly_recap
  for all using (auth.role() = 'authenticated');
