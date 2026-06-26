import { NextResponse } from 'next/server'
import { existsSync } from 'fs'
import { join, basename } from 'path'
import { probeVideo, extractFrameJpegBase64 } from '@/lib/video-frames'
import { createClient } from '@/lib/supabase/server'
import { OBS_RECORDINGS_DIR } from '../list/route'

/**
 * POST /api/video/frame
 * Body: { videoFile, entryTimeIso, deltaSec?, tradeId?, save? }
 *
 * Extracts the recording frame at (entry_time + deltaSec) — the frame-nudge
 * scrubber uses this to preview a frame as the user drags ±N seconds around the
 * logged entry, since a typed minute-rounded entry time (or a replay clock that
 * doesn't match wall-clock) won't land on the exact fill moment on its own.
 *
 *   - save=false (default): returns { frame: <data-url>, offsetSec } for preview.
 *   - save=true + tradeId:  uploads the frame to the screenshots bucket, sets
 *     trades.screenshot_url, tags recording_commentary.screenshot_source='obs'
 *     + the chosen delta, and returns { url }.
 *
 * Frame extraction stays local (the recording never leaves the machine).
 */
export async function POST(req: Request) {
  let body: { videoFile?: string; entryTimeIso?: string; deltaSec?: number; tradeId?: string; save?: boolean }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }) }

  const { videoFile, entryTimeIso, tradeId, save } = body
  const deltaSec = Number.isFinite(body.deltaSec) ? Number(body.deltaSec) : 0
  if (!videoFile || !entryTimeIso) {
    return NextResponse.json({ error: 'videoFile and entryTimeIso required' }, { status: 400 })
  }
  if (save && !tradeId) {
    return NextResponse.json({ error: 'tradeId required to save' }, { status: 400 })
  }

  // Path-traversal guard — only a bare filename in the recordings dir.
  const safeName = basename(videoFile)
  if (safeName !== videoFile) return NextResponse.json({ error: 'invalid videoFile name' }, { status: 400 })
  const fullPath = join(OBS_RECORDINGS_DIR, safeName)
  if (!existsSync(fullPath)) return NextResponse.json({ error: `Recording not found: ${fullPath}` }, { status: 404 })

  const entryMs = Date.parse(entryTimeIso)
  if (!Number.isFinite(entryMs)) return NextResponse.json({ error: 'unparseable entryTimeIso' }, { status: 400 })

  let info
  try { info = await probeVideo(fullPath) }
  catch (e) {
    return NextResponse.json({ error: `ffprobe failed: ${e instanceof Error ? e.message : 'unknown'}` }, { status: 500 })
  }
  const durationSec = info.durationMs / 1000
  const offsetSec = Math.min(Math.max(0, (entryMs - info.creationTimeMs) / 1000 + deltaSec), Math.max(0, durationSec - 0.1))

  let frame: string
  try { frame = await extractFrameJpegBase64(fullPath, offsetSec) }
  catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'frame extraction failed' }, { status: 500 })
  }

  // Preview path — return the frame inline, no DB write.
  if (!save) {
    return NextResponse.json({ frame: `data:image/jpeg;base64,${frame}`, offsetSec })
  }

  // Save path — upload + point the trade's screenshot at it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase: any = await createClient()
  try {
    const buf = Buffer.from(frame, 'base64')
    // UNIQUE path per save → always an INSERT. Overwriting an existing object
    // (a stable obs-<id>.jpg) needs a storage UPDATE policy the bucket doesn't
    // have → "new row violates row-level security policy". The manual uploader
    // avoids this the same way: a fresh filename every time. A unique URL also
    // sidesteps browser caching, so no cacheControl needed.
    const path = `trades/obs-${tradeId}-${Date.now()}.jpg`
    const { error: upErr } = await supabase.storage
      .from('screenshots')
      .upload(path, buf, { contentType: 'image/jpeg' })
    if (upErr) return NextResponse.json({ error: `upload failed: ${upErr.message}` }, { status: 500 })
    const url = supabase.storage.from('screenshots').getPublicUrl(path).data.publicUrl

    // Merge into the existing recording_commentary jsonb so we keep the
    // commentary text + detected levels while flagging the source + chosen delta.
    const { data: row } = await supabase.from('trades').select('recording_commentary, screenshot_url').eq('id', tradeId).single()
    const rc = (row?.recording_commentary && typeof row.recording_commentary === 'object') ? row.recording_commentary : {}
    await supabase
      .from('trades')
      .update({
        screenshot_url: url,
        recording_commentary: { ...rc, screenshot_source: 'obs', screenshot_delta_sec: deltaSec },
      })
      .eq('id', tradeId)

    // Best-effort: delete the previous screenshot blob so unique-path saves
    // don't pile up orphans. Ignored if it fails (e.g. it was an external URL).
    const old = row?.screenshot_url as string | undefined
    const marker = '/storage/v1/object/public/screenshots/'
    if (old && old.includes(marker) && old !== url) {
      const oldPath = decodeURIComponent(old.slice(old.indexOf(marker) + marker.length).split('?')[0])
      try { await supabase.storage.from('screenshots').remove([oldPath]) } catch { /* best-effort cleanup */ }
    }

    return NextResponse.json({ url, offsetSec })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'save failed' }, { status: 500 })
  }
}
