-- Custom tag categories (Pt 16).
--
-- `trade_tags.category` was a fixed CHECK enum of the seven built-in buckets
-- (setups / confluences / order_flow / trade_management / day_type / mistakes /
-- emotions — plus entry_model in some deployments). Traders legitimately want
-- their own axes ("4h Candle Shape", "News Regime", …), and the enum was the
-- only thing stopping them: `tags_json` on trades is JSONB, so a new key needs
-- no schema change at all.
--
-- So: drop the value enum, keep a SHAPE check. The key must still be a safe,
-- lowercase snake_case slug because it doubles as a JSONB object key in
-- `trades.tags_json` and as part of the `(category, label)` uniqueness key.
--
-- Which categories a trader sees (their custom ones, and which built-ins
-- they've hidden) lives per-user in `trader_profile.onboarding_json.tag_categories`
-- — no new table, so this migration is the whole DDL surface.
--
-- Safe to re-run. Purely permissive: every existing row already satisfies the
-- new constraint, so nothing is rewritten and nothing can fail validation.

alter table public.trade_tags drop constraint if exists trade_tags_category_check;
alter table public.trade_tags drop constraint if exists trade_tags_category_key_format;

alter table public.trade_tags add constraint trade_tags_category_key_format
  check (category ~ '^[a-z][a-z0-9_]{1,30}$');
