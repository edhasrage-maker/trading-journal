-- Deep Dive Review — private bucket for the tick tape.          (PUBLIC project)
--
-- Run once in the PUBLIC (tapescore.app) Supabase project's SQL editor.
--
-- WHAT IT HOLDS
--   The NQ + ES trade stream, one small compressed file per instrument per
--   hour, published by the local feed agent (scripts/public-bar-feed.ts) from
--   the owner's Sierra files. tapescore.app's Deep Dive route reads it to build
--   the same charts the local build draws from .scid — including the partial
--   entry bar cut at the fill second. About 2.5 MB per trading day; the feed
--   keeps the last 90 days.
--
-- WHO CAN READ IT
--   Nobody but the server. The bucket is private and this file adds NO storage
--   policy for it, so with RLS on storage.objects neither the anon key nor a
--   signed-in user's token can list, read or write it. Only a secret key can:
--   the feed agent (writes) and the hosted route (reads, SUPABASE_SERVICE_ROLE_KEY).
--   Raw trades never reach a browser — the route cuts at the fill in memory and
--   returns only the finished workspace, and only to the Deep Dive beta list.
--
-- Safe to re-run.

insert into storage.buckets (id, name, public)
values ('tick-tape', 'tick-tape', false)
on conflict (id) do update set public = false;

-- Sanity check (should return 0 rows): no policy may mention this bucket.
-- select policyname from pg_policies
--  where schemaname = 'storage' and tablename = 'objects'
--    and (qual ilike '%tick-tape%' or with_check ilike '%tick-tape%');
