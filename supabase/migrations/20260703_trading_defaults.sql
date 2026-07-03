-- Trading-defaults fields on the per-user trader_profile row (Account Settings →
-- Profile). Display name, default instrument, account size, and timezone.
-- Account size enables %-return and size-relative risk metrics later.
--
-- Run in the Supabase SQL editor. Idempotent.
alter table trader_profile
  add column if not exists display_name       text,
  add column if not exists default_instrument text,
  add column if not exists account_size       numeric,
  add column if not exists timezone           text;
