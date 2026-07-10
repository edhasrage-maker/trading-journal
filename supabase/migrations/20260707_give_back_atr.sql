-- 2026-07-07 — Per-user round-trip / "gave it back" threshold on trader_profile.
--
-- The round-trip metric flags a trade that ran meaningfully in the trader's
-- favor and then closed at or below breakeven (a winner handed back). "Ran
-- meaningfully" = at least this many ×ATR (1m Wilder-10 baseline / the user's
-- configured ATR on the EOD panel). Default 1×; each trader sets their own in
-- Settings → ATR measurement. ATR-only by design — R is not used.
--
-- Read by the EOD Entry-efficiency panel (src/components/eod/MfeMaeEfficiency)
-- and the AI coach (src/lib/coach-context). Additive column; existing rows
-- default to 1 (the prior hardcoded behavior), so nothing changes until a
-- trader picks a different multiple.

alter table trader_profile
  add column if not exists give_back_atr numeric not null default 1;
