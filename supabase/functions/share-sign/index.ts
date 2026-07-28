// Edge Function: share-sign
// ---------------------------------------------------------------------------
// Mints short-lived signed URLs for the screenshots on a SHARED trading day,
// for anonymous coach-review visitors at /share/<token>.
//
// Why this exists: the `screenshots` bucket is private with per-user folder RLS
// (`<auth.uid()>/…`). A logged-out share visitor has no session, so they cannot
// sign the OWNER's objects. `get_shared_day` (SECURITY DEFINER) exposes the row
// data but SQL can't mint storage signed URLs. This function closes that gap:
// it validates the share token, then uses the service-role key — which lives in
// SUPABASE's Edge runtime env, NEVER on the Vercel web host — to sign only that
// day's owner-owned screenshot paths.
//
// Security model:
//   • Gated on the unguessable share token, re-validating the SAME conditions
//     as get_shared_day (not revoked, not expired). Revoke/expiry is enforced on
//     every call (view-time), and signed URLs are short-lived (1h by default,
//     up to 24h when the caller asks — see MAX_TTL_SEC).
//   • The service role is used ONLY here, and it only ever signs paths that (a)
//     belong to the token's trading day and (b) sit under the owner's folder —
//     it never signs a client-supplied path.
//
// Deploy (JWT verification OFF — the share token is the auth):
//   supabase functions deploy share-sign \
//     --project-ref dmutgkycrjudfejswvhg --no-verify-jwt
// or paste this in the dashboard Edge Functions editor and disable "Verify JWT".

import { createClient } from 'jsr:@supabase/supabase-js@2'

// 1 hour — view-time freshness for the interactive page, dies fast if captured.
const SIGNED_TTL_SEC = 60 * 60
// Callers may ask for longer, capped here. The one real case is the link's
// UNFURL PREVIEW image: that URL is fetched by a scraper (Slack, iMessage,
// Twitter) rather than a person, sometimes lazily when a recipient opens the
// thread rather than when it was posted. At the 1h default a link pasted in the
// evening and read the next morning previewed as the generic brand card. The
// interactive page keeps the short default — the two have genuinely different
// exposure, since the preview URL only ever reaches whoever already has the
// share link.
const MAX_TTL_SEC = 24 * 60 * 60

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ signed: {} }, 405)

  try {
    const { token, ttl } = await req.json().catch(() => ({}))
    if (!token || typeof token !== 'string') return json({ signed: {} }, 400)
    // Clamped, never trusted raw: the token is the auth, so a caller holding it
    // could otherwise ask for an arbitrarily long-lived URL.
    const ttlSec = (typeof ttl === 'number' && Number.isFinite(ttl))
      ? Math.min(Math.max(Math.floor(ttl), 60), MAX_TTL_SEC)
      : SIGNED_TTL_SEC

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } },
    )

    // 1. Validate the token — same guard as public.get_shared_day.
    const { data: share } = await admin
      .from('shares')
      .select('user_id, trading_day_id, revoked, expires_at')
      .eq('token', token)
      .maybeSingle()
    if (
      !share ||
      share.revoked ||
      (share.expires_at && new Date(share.expires_at as string) <= new Date())
    ) {
      return json({ signed: {} }, 200) // invalid/revoked/expired → nothing to sign
    }
    const owner = share.user_id as string
    const dayId = share.trading_day_id as string

    // 2. Gather this day's screenshot storage PATHS, owner-owned only. Never
    //    trust a client path — re-derive from the DB and require the owner
    //    prefix so the service role can only ever sign this day's own objects.
    const paths = new Set<string>()
    const consider = (v?: string | null) => {
      if (v && !/^https?:\/\//i.test(v) && v.startsWith(owner + '/')) paths.add(v)
    }

    const { data: day } = await admin
      .from('trading_days')
      .select('chart_screenshot_url, eod_chart_screenshot_url')
      .eq('id', dayId)
      .maybeSingle()
    consider(day?.chart_screenshot_url as string | null | undefined)
    consider(day?.eod_chart_screenshot_url as string | null | undefined)

    const { data: trades } = await admin
      .from('trades')
      .select('screenshot_url')
      .eq('trading_day_id', dayId)
    for (const t of trades ?? []) consider((t as { screenshot_url?: string | null }).screenshot_url)

    // 3. Batch-sign.
    const list = [...paths]
    const signed: Record<string, string> = {}
    if (list.length > 0) {
      const { data } = await admin.storage
        .from('screenshots')
        .createSignedUrls(list, ttlSec)
      for (const r of data ?? []) {
        if (r.path && r.signedUrl) signed[r.path] = r.signedUrl
      }
    }
    return json({ signed }, 200)
  } catch (e) {
    // Never hard-fail: the share page degrades to "no image" on error.
    return json({ signed: {}, error: String(e) }, 200)
  }
})
