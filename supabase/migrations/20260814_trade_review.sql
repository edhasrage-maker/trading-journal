-- Per-trade review — the trader's own verdict on a trade (from the weekly
-- "Game film" catalog), and later the coach's screenshot-vs-tape read.
--
-- One JSONB column, not a table: a review is a property of the trade, has at
-- most one of each part, and is read wherever the trade is read. Shape (see
-- TradeReview in src/lib/supabase/types.ts):
--   {
--     "verdict": { "call": "good" | "mistake" | "unsure",
--                  "note": "<one line>", "at": "<ISO>" }
--     -- reserved: "tape_read": { ... }   (the coach's read; not written yet)
--   }
--
-- The trader's verdict is written FIRST and on purpose without the coach's
-- read beside it — these labels are the calibration set the screenshot-coach
-- is graded against, so they must not be anchored by the model.
--
-- Same statement on both DBs (single-tenant and public); RLS on trades already
-- scopes the row.

alter table public.trades
  add column if not exists review_json jsonb;

comment on column public.trades.review_json is
  'Trader verdict on the trade (verdict.call good|mistake|unsure + note) and, later, the coach''s screenshot-vs-tape read. Written by /api/trades/[id]/review (read-merge, never whole-object).';
