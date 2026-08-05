-- Share link preview image (OG thumbnail).
--
-- Pasting a /share/<token> link produced no thumbnail: generateMetadata falls
-- back to the day's uploaded screenshot, and days reviewed on the LIVE chart
-- have none. So "Share for review" now captures the chart itself — candles,
-- VWAP/EMAs, entry/exit arrows AND the trader's annotations, all of which are
-- canvas primitives, so lightweight-charts' takeScreenshot() gets the lot —
-- and stores it here.
--
-- WHY A PUBLIC BUCKET. Link-preview scrapers (Slack, iMessage, Discord) fetch
-- the image anonymously, on their own schedule, and cache it. The `screenshots`
-- bucket is private and needs the share-sign Edge Function to mint short-lived
-- signed URLs — which is why the preview TTL already had to be stretched to 24h
-- to survive a link read the next morning. A public object removes that whole
-- class of problem. The trade-off is explicit: preview images are readable by
-- anyone holding the URL, exactly like the share link itself. Nothing is written
-- here unless the trader clicks Share.
--
-- The column lives on trading_days rather than shares because get_shared_day
-- returns `to_jsonb(td)` — the whole day row — so it reaches the share page with
-- no change to that function.

alter table public.trading_days
  add column if not exists share_preview_url text;

comment on column public.trading_days.share_preview_url is
  'Public URL of the chart snapshot captured when the day was shared. Powers the OG thumbnail on /share/<token>. Null until the trader shares.';

-- Owners may write only into their own folder (<uid>/…); the bucket being public
-- makes objects world-READABLE, not world-writable.
drop policy if exists "Owner writes share previews" on storage.objects;
create policy "Owner writes share previews" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'share-previews'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Owner updates share previews" on storage.objects;
create policy "Owner updates share previews" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'share-previews'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
