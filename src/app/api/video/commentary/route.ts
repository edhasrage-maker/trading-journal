import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import { existsSync } from 'fs'
import { join, basename, isAbsolute, extname } from 'path'
import { probeVideo, extractFrameJpegBase64 } from '@/lib/video-frames'
import { normalizeAnthropicMediaType } from '@/lib/anthropic-image'
import { OBS_RECORDINGS_DIR } from '../list/route'

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.mov'])

const client = new Anthropic()

interface CommentaryTrade {
  id: string
  direction?: string | null
  entry_price?: number | null
  exit_price?: number | null
  quantity?: number | null
  pnl?: number | null
  entry_time?: string | null
  exit_time?: string | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tags_json?: any
  notes?: string | null
}

/**
 * POST /api/video/commentary
 * Body: { videoFile: string, trades: CommentaryTrade[] }
 *
 * For each trade, extracts the entry frame (and exit frame, when distinct)
 * from the OBS recording at the timestamp computed from the recording's
 * `creation_time` + the trade's `entry_time`. Sends every frame in ONE
 * batched multimodal Claude call (image1, image2, …, text) and returns a
 * 1–3 sentence commentary per trade id.
 *
 * Frame extraction stays local (file never leaves the user's machine). The
 * client caches results by content hash, so this only runs when the user
 * explicitly clicks "Run commentary" or when tags/notes/recording change.
 */
export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not configured on the server.' }, { status: 503 })
  }

  let body: { videoFile?: string; videoPath?: string; trades?: CommentaryTrade[] }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }) }
  const { videoFile, videoPath, trades } = body
  if (!Array.isArray(trades) || trades.length === 0) {
    return NextResponse.json({ error: 'non-empty trades[] required' }, { status: 400 })
  }
  if (!videoFile && !videoPath) {
    return NextResponse.json({ error: 'videoFile or videoPath required' }, { status: 400 })
  }

  // Two resolution modes:
  //   1. videoFile = bare filename inside OBS_RECORDINGS_DIR (dropdown selection).
  //   2. videoPath = absolute path to any video on disk (custom-import option).
  // Both must end in a supported extension and the file must exist. The path
  // never leaves the user's machine — ffmpeg reads it locally.
  let fullPath: string
  if (videoPath) {
    if (!isAbsolute(videoPath)) {
      return NextResponse.json({ error: 'videoPath must be an absolute path' }, { status: 400 })
    }
    if (!VIDEO_EXTS.has(extname(videoPath).toLowerCase())) {
      return NextResponse.json({ error: `Unsupported video extension. Use ${Array.from(VIDEO_EXTS).join(', ')}.` }, { status: 400 })
    }
    fullPath = videoPath
  } else {
    const safeName = basename(videoFile!)
    if (safeName !== videoFile) {
      return NextResponse.json({ error: 'invalid videoFile name' }, { status: 400 })
    }
    fullPath = join(OBS_RECORDINGS_DIR, safeName)
  }
  if (!existsSync(fullPath)) {
    return NextResponse.json({ error: `Recording not found: ${fullPath}` }, { status: 404 })
  }

  let info
  try { info = await probeVideo(fullPath) }
  catch (e) {
    return NextResponse.json({
      error: `ffprobe failed: ${e instanceof Error ? e.message : 'unknown'}`,
      hint: 'Install ffmpeg and ensure ffprobe is on PATH (winget install Gyan.FFmpeg).',
    }, { status: 500 })
  }

  const mediaType = normalizeAnthropicMediaType('image/jpeg')!
  const durationSec = info.durationMs / 1000

  // Build the multimodal content array: one image block per frame, then the text.
  const blocks: Anthropic.MessageParam['content'] = []
  const labels: string[] = []
  const skipped: Array<{ id: string; reason: string }> = []

  for (let i = 0; i < trades.length; i++) {
    const t = trades[i]
    if (!t.entry_time) { skipped.push({ id: t.id, reason: 'no entry_time on trade' }); continue }
    const entryMs = Date.parse(t.entry_time)
    if (!Number.isFinite(entryMs)) { skipped.push({ id: t.id, reason: 'unparseable entry_time' }); continue }
    const entryOffset = (entryMs - info.creationTimeMs) / 1000
    if (entryOffset < 0 || entryOffset > durationSec) {
      skipped.push({ id: t.id, reason: `outside recording window (offset ${entryOffset.toFixed(0)}s, duration ${durationSec.toFixed(0)}s)` })
      continue
    }

    try {
      const entryFrame = await extractFrameJpegBase64(fullPath, entryOffset)
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: entryFrame } })
      labels.push(`Trade ${i + 1} (id=${t.id}) ENTRY @ ${t.entry_time}`)

      // Only include an exit frame if exit is meaningfully after entry AND within recording.
      const exitMs = t.exit_time ? Date.parse(t.exit_time) : NaN
      const exitOffset = Number.isFinite(exitMs) ? (exitMs - info.creationTimeMs) / 1000 : NaN
      if (Number.isFinite(exitOffset) && exitOffset > entryOffset + 1 && exitOffset <= durationSec) {
        const exitFrame = await extractFrameJpegBase64(fullPath, exitOffset)
        blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: exitFrame } })
        labels.push(`Trade ${i + 1} (id=${t.id}) EXIT @ ${t.exit_time}`)
      }
    } catch (e) {
      skipped.push({ id: t.id, reason: e instanceof Error ? e.message : 'frame extraction failed' })
    }
  }

  if (blocks.length === 0) {
    return NextResponse.json({
      commentary: {},
      skipped,
      framesUsed: 0,
      note: 'No frames could be extracted — every trade fell outside the recording window or had no entry_time.',
    })
  }

  const tradeDescriptions = trades.map((t, i) => {
    const dir = t.direction?.toUpperCase() ?? '—'
    const pnl = t.pnl != null ? `${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}` : '—'
    const setups = (t.tags_json?.setups as string[] | undefined)?.join(', ') || '—'
    const mistakes = (t.tags_json?.mistakes as string[] | undefined)?.join(', ') || '—'
    const orderFlow = (t.tags_json?.order_flow as string[] | undefined)?.join(', ') || '—'
    const notes = t.notes?.trim() ? `\n  notes: ${t.notes.trim()}` : ''
    return `Trade ${i + 1} (id=${t.id}): ${dir} ${t.quantity ?? '?'} @ ${t.entry_price ?? '?'} → ${t.exit_price ?? '?'} | PnL ${pnl}
  setups: ${setups} | order_flow: ${orderFlow} | mistakes: ${mistakes}${notes}`
  }).join('\n')

  const prompt = `You are an objective trading coach reviewing screen-recording frames from a futures trader's session. Each frame is what the trader was looking at on the chart at a precise moment.

For each trade you see frames of (an ENTRY frame and, when distinct, an EXIT frame), write 1–3 sentences of HONEST commentary tying what's visibly on screen — chart structure, key levels, order flow, where price was relative to the setup — to the trade the trader actually took. Be specific. If the entry frame doesn't support the tagged setup, say so. If price did something obvious between entry and exit that the trader missed, point it out. The trader is paying you to be direct, not encouraging.

The image array above is ordered as follows:
${labels.map((l, i) => `${i + 1}. ${l}`).join('\n')}

Trade context (matches the image labels by trade id):
${tradeDescriptions}

Respond with ONLY valid JSON (no markdown, no code fences), mapping each trade id to its commentary string:
{ "commentary": { "<tradeId>": "<1-3 sentence commentary>", ... } }`

  blocks.push({ type: 'text', text: prompt })

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: blocks }],
    })
    const text = message.content[0]?.type === 'text' ? message.content[0].text : ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return NextResponse.json({
        commentary: {}, skipped, framesUsed: blocks.length - 1,
        note: 'AI returned no parseable JSON.',
      })
    }
    const parsed = JSON.parse(jsonMatch[0]) as { commentary?: Record<string, string> }
    return NextResponse.json({
      commentary: parsed.commentary ?? {},
      skipped,
      framesUsed: blocks.length - 1,
      recordingStartIso: new Date(info.creationTimeMs).toISOString(),
      durationSec,
    })
  } catch (e) {
    const err = e as { message?: string; error?: { message?: string }; status?: number }
    console.error('[video/commentary] failed:', err)
    return NextResponse.json({
      error: err?.error?.message ?? err?.message ?? 'commentary failed',
    }, { status: err?.status ?? 500 })
  }
}
