-- Session-merge Pt 13, step 3: manual "I'm done — end session".
--
-- One nullable timestamp per trading day. Set when the trader ends the session
-- by choice during RTH (before the 13:00 PT close). NULL = never manually ended
-- (the session ran to the close, or is still open).
--
-- Deliberately NEVER cleared once set: re-opening the session (logging a trade
-- after this timestamp) is a DERIVED state — trades with entry_time >
-- session_ended_at — not a column mutation. Keeping the value lets the EOD recap
-- keep showing "ended by choice at HH:MM" as a positive discipline signal AND
-- surface the "re-opened after ending" tilt flag at the same time.
--
-- Run this in the Supabase dashboard SQL editor on BOTH databases (personal +
-- public), per the two-machine convention, then supabase/schema.sql is updated
-- to match.

alter table trading_days
  add column if not exists session_ended_at timestamptz;

comment on column trading_days.session_ended_at is
  'When the trader manually ended the session ("I''m done") during RTH. NULL = never manually ended (ran to the RTH close, or still open). Never cleared after a re-open, so the "ended by choice" note and the re-open tilt flag both survive; re-open is derived from trades with entry_time > session_ended_at.';
