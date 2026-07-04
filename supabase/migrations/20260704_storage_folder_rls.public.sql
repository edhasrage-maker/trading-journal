-- ============================================================================
-- Storage per-user folder isolation (PUBLIC / hosted TapeScore build)
-- ============================================================================
-- Run this in the Supabase dashboard SQL editor of the PUBLIC project
-- (dmutgkycrjudfejswvhg) — NOT the personal project.
--
-- SEQUENCING (critical): deploy the app code that ships with this migration
-- FIRST (signed-URL read boundary + auth.uid()-prefixed uploads in
-- src/app/api/screenshots/route.ts + src/lib/storage-url.ts), let Vercel
-- redeploy, THEN run this. Applying the folder policies before the
-- uid-prefixing code is live would reject every upload (objects wouldn't sit
-- under `<auth.uid()>/…`). The buckets are already private and hold ZERO
-- objects, so there is no data to migrate.
--
-- What this does:
--   1. Force both buckets private (idempotent; already the case).
--   2. Remove the early-testing "any authenticated user can read/write"
--      policies — THESE ARE THE LEAK. While present, any signed-in user can
--      read any other user's objects (only anonymous access was closed by the
--      private-bucket flip).
--   3. Add folder-scoped policies: a user may only touch objects whose first
--      path segment equals their auth.uid() (uploads are written as
--      `<auth.uid()>/trades/…`, `<auth.uid()>/chart/…`, etc.).
-- ============================================================================

update storage.buckets set public = false where id in ('screenshots', 'sc-logs');

-- ── 1. Drop EVERY existing policy on storage.objects ────────────────────────
-- The dashboard "allow authenticated read/write" wizard auto-names its policies
-- (e.g. "Allow authenticated uploads 1abc2d_0"), so guessing names is fragile —
-- a surviving permissive policy OR's with the folder policies below and the
-- leak persists. Enumerate + drop them all by name instead; §2 then rebuilds
-- exactly the intended set. This project only uses the screenshots + sc-logs
-- buckets, so no other storage policy is collateral.
do $$
declare pol record;
begin
  for pol in
    select policyname from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
  loop
    execute format('drop policy if exists %I on storage.objects', pol.policyname);
  end loop;
end $$;

-- ── 2. Folder-scoped policies (idempotent create) ───────────────────────────
-- One set per bucket. `(storage.foldername(name))[1]` is the first path
-- segment; uploads are prefixed with the uploader's auth.uid().

-- screenshots ----------------------------------------------------------------
drop policy if exists "screenshots_select_own" on storage.objects;
create policy "screenshots_select_own" on storage.objects
  for select to authenticated
  using (bucket_id = 'screenshots' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "screenshots_insert_own" on storage.objects;
create policy "screenshots_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'screenshots' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "screenshots_update_own" on storage.objects;
create policy "screenshots_update_own" on storage.objects
  for update to authenticated
  using (bucket_id = 'screenshots' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'screenshots' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "screenshots_delete_own" on storage.objects;
create policy "screenshots_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'screenshots' and (storage.foldername(name))[1] = auth.uid()::text);

-- sc-logs --------------------------------------------------------------------
-- (import-sc-log is a LOCAL-only feature so this bucket stays empty on the
--  hosted project, but scope it for defence-in-depth / future parity.)
drop policy if exists "sclogs_select_own" on storage.objects;
create policy "sclogs_select_own" on storage.objects
  for select to authenticated
  using (bucket_id = 'sc-logs' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "sclogs_insert_own" on storage.objects;
create policy "sclogs_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'sc-logs' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "sclogs_update_own" on storage.objects;
create policy "sclogs_update_own" on storage.objects
  for update to authenticated
  using (bucket_id = 'sc-logs' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'sc-logs' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "sclogs_delete_own" on storage.objects;
create policy "sclogs_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'sc-logs' and (storage.foldername(name))[1] = auth.uid()::text);

-- ── 3. Verify (two-user probe) ──────────────────────────────────────────────
-- After running, confirm isolation: sign in as user B and attempt to download
-- an object under user A's folder — it must 400/403. See the Pt 4 report.
