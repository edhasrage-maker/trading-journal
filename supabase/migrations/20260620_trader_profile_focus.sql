-- 2026-06-20 — Coaching Focus field on trader_profile.
--
-- A short, high-priority "pay close attention to this" list, distinct from the
-- standing preferences_md. The coach injects this LAST in its prompt (highest-
-- recency slot, right before the trader's question) so the model weights it
-- heavily — the trader's steering wheel for what to emphasize right now.
--
-- Examples of content:
--   - "Lead with risk management: MAE planned (stop) vs MAE taken (actual
--      heat), and win rate by heat taken."
--   - "Watch my post-loss window — the 1-3 trades after a loss."
--
-- Additive column; existing rows default to empty string.

alter table trader_profile
  add column if not exists focus_md text not null default '';
