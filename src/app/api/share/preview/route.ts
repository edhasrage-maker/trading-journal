import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { clientError } from '@/lib/api-error'

/**
 * POST /api/share/preview — store the link-preview (OG) image for a shared day.
 *
 * Body: { date: 'YYYY-MM-DD', dataUrl: 'data:image/png;base64,…' }
 *
 * Why this is separate from /api/screenshots: that route writes to the PRIVATE
 * `screenshots` bucket and hands back a short-lived SIGNED url, because those
 * images are only ever read by an authenticated owner or through the share-sign
 * Edge Function. A link preview is read by Slack/iMessage/Discord scrapers —
 * anonymous, on their own schedule, and cached — which is why the existing
 * preview path already had to stretch its signed TTL to 24h just to survive a
 * link opened the next morning. So previews go to the PUBLIC `share-previews`
 * bucket and are stored as a plain, stable URL.
 *
 * The image is the live chart's own canvas (LiveChart.takeScreenshotPng), so it
 * carries the candles, VWAP/EMAs, entry/exit arrows and the trader's zone/text
 * annotations — all of which are chart primitives rather than DOM overlays.
 *
 * Security: the path is server-derived as `<auth.uid()>/…`, never taken from the
 * client, and storage RLS independently requires that prefix. Public here means
 * world-READABLE by URL — the same trust model as the share link itself — not
 * world-writable.
 */
const BUCKET = 'share-previews'
const MAX_BYTES = 5 * 1024 * 1024

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: { date?: string; dataUrl?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Bad JSON' }, { status: 400 }) }

  const date = String(body.date ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'Invalid date' }, { status: 400 })
  }
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.dataUrl ?? ''))
  if (!m) return NextResponse.json({ error: 'Expected a base64 PNG data URL' }, { status: 400 })

  const buffer = Buffer.from(m[1], 'base64')
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_BYTES) {
    return NextResponse.json({ error: 'Image missing or too large' }, { status: 400 })
  }

  // Stable per-day path: re-sharing overwrites rather than accumulating blobs,
  // and the URL stays the same so a scraper's cached copy refreshes in place.
  const path = `${user.id}/${date}.png`
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, buffer, { contentType: 'image/png', upsert: true })
  if (upErr) return NextResponse.json({ error: clientError(upErr, 'Could not store the preview image') }, { status: 500 })

  const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(path)

  // RLS scopes this to the caller's own row; no user_id filter needed here, and
  // adding one would break the local single-user build where the column is absent.
  //
  // Cast: the generated types mirror the LOCAL single-user schema, which has no
  // share_preview_url — it only exists on the public/multi-tenant project. Same
  // reason the other public-only columns are written through an untyped client.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any
  const { error: saveErr } = await db
    .from('trading_days')
    .update({ share_preview_url: publicUrl })
    .eq('date', date)
  if (saveErr) {
    // The image is stored and usable; only the pointer failed. Report it rather
    // than pretending the preview is wired up.
    return NextResponse.json(
      { error: clientError(saveErr, 'Preview uploaded but could not be linked to the day') },
      { status: 500 },
    )
  }

  return NextResponse.json({ url: publicUrl })
}
