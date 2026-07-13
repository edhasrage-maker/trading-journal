-- Gamification Phase 2: persist each day's earned achievement ids.
--
-- Array of AchievementId strings, e.g. ["sniper","clean_tape","game_winner"].
-- Recomputed server-side whenever a day's EOD analysis is saved
-- (/api/trading-days/[date]/eod) and backfilled across history by
-- POST /api/achievements/backfill. Powers the EOD showcase (earned-today +
-- collection + lifetime counts) and the dashboard recent-days coin markers.
--
-- RLS: covered by the existing trading_days row policy (no new policy needed).
alter table trading_days
  add column if not exists achievements_json jsonb default '[]'::jsonb;
