-- 2026-06-02 — Persist OBS commentary on the trades row.
--
-- Adds trades.recording_commentary jsonb. The /api/video/commentary route
-- writes here on successful generation so:
--   1. Reloading the EOD page restores commentary without re-running ffmpeg
--      + Claude vision (saves money + time).
--   2. Commentary syncs cross-PC via Supabase, mirroring how chart prefs
--      and saved views do.
--
-- Shape: { text, video_file, model, generated_at }
-- See: lib/supabase/types.ts → RecordingCommentaryData
--
-- Idempotent.

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS recording_commentary jsonb;
