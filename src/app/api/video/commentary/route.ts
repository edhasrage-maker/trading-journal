import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import { existsSync } from 'fs'
import { join, basename } from 'path'
import { probeVideo, extractFrameJpegBase64 } from '@/lib/video-frames'
import { normalizeAnthropicMediaType } from '@/lib/anthropic-image'
import { createClient } from '@/lib/supabase/server'
import { OBS_RECORDINGS_DIR } from '../list/route'

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

  let body: { videoFile?: string; trades?: CommentaryTrade[] }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }) }
  const { videoFile, trades } = body
  if (!videoFile || !Array.isArray(trades) || trades.length === 0) {
    return NextResponse.json({ error: 'videoFile and non-empty trades[] required' }, { status: 400 })
  }

  // Path-traversal guard — only allow a bare filename in the recordings dir.
  const safeName = basename(videoFile)
  if (safeName !== videoFile) {
    return NextResponse.json({ error: 'invalid videoFile name' }, { status: 400 })
  }
  const fullPath = join(OBS_RECORDINGS_DIR, safeName)
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

  // Format trade times in America/Los_Angeles for the AI prompt. The raw ISO
  // strings are UTC and the AI was quoting UTC hours in its analysis (e.g.
  // "15:48" for an 08:48 PT entry), confusing the user.
  const PT_TIME_FMT = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const fmtPT = (iso: string | null | undefined): string => {
    if (!iso) return '--:--:--'
    const ms = Date.parse(iso)
    if (!Number.isFinite(ms)) return '--:--:--'
    const parts = PT_TIME_FMT.formatToParts(new Date(ms))
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00'
    return `${get('hour')}:${get('minute')}:${get('second')} PT`
  }

  // Fetch the current mistakes library — we'll show the AI exactly what
  // labels exist so it suggests from the user's taxonomy instead of free-
  // texting. The client constrains suggestions to this list too (it would
  // need to know which chips correspond to real tag rows).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase: any = await createClient()
  const { data: mistakeRows } = await supabase
    .from('trade_tags')
    .select('label')
    .eq('category', 'mistakes')
    .order('sort_order') as { data: { label: string }[] | null }
  const mistakeLibrary = (mistakeRows ?? []).map(r => r.label)

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
      labels.push(`Trade ${i + 1} (id=${t.id}) ENTRY @ ${fmtPT(t.entry_time)}`)

      // Only include an exit frame if exit is meaningfully after entry AND within recording.
      const exitMs = t.exit_time ? Date.parse(t.exit_time) : NaN
      const exitOffset = Number.isFinite(exitMs) ? (exitMs - info.creationTimeMs) / 1000 : NaN
      if (Number.isFinite(exitOffset) && exitOffset > entryOffset + 1 && exitOffset <= durationSec) {
        const exitFrame = await extractFrameJpegBase64(fullPath, exitOffset)
        blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: exitFrame } })
        labels.push(`Trade ${i + 1} (id=${t.id}) EXIT @ ${fmtPT(t.exit_time)}`)
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

  const mistakeListBlock = mistakeLibrary.length > 0
    ? `\n\nAvailable mistake tags (suggest 0–3 per trade, ONLY from this list — copy labels verbatim, do not invent new ones; pick ONLY mistakes clearly visible in the frames, not speculative):\n${mistakeLibrary.map(m => `  - ${m}`).join('\n')}`
    : ''

  const prompt = `You are an objective trading coach reviewing screen-recording frames from a futures trader's session. Each frame is what the trader was looking at on the chart at a precise moment.

For each trade you see frames of (an ENTRY frame and, when distinct, an EXIT frame), do TWO things:

1) Write 1–3 sentences of HONEST commentary tying what's visibly on screen — chart structure, key levels, order flow, where price was relative to the setup — to the trade the trader actually took. Be specific. If the entry frame doesn't support the tagged setup, say so. If price did something obvious between entry and exit that the trader missed, point it out. The trader is paying you to be direct, not encouraging.

2) From the ENTRY frame ONLY (not the exit frame), identify the trader's PLANNED order levels by reading any horizontal lines / DOM order labels visible on the chart at that moment:
   - entry_price: the price the order was waiting at
   - stop_price: the working stop line (BELOW entry for longs, ABOVE for shorts). Sierra labels these as "Stop|Child-Client" with a "(-N.NNp)" suffix indicating distance — when you see "(-20.00p)" on a short, the stop is 20 points above entry.
   - tp1_price / tp2_price: working limit / TP lines (ABOVE entry for longs, BELOW for shorts). TP1 is closer to entry.
   CRITICAL: return null for any field you cannot confidently read off the price scale or a labeled order line. DO NOT GUESS. A null is far more useful than a hallucinated number — the trader will be using these to backfill missing data. levels_confidence is "high" only if every non-null field came from a clearly-labeled order line at a readable price; "medium" if inferred from line position; "low" if the chart was hard to read.${mistakeListBlock}

The image array above is ordered as follows:
${labels.map((l, i) => `${i + 1}. ${l}`).join('\n')}

Trade context (matches the image labels by trade id):
${tradeDescriptions}

Return ONE entry in the trades array per unique trade id (use the id strings exactly as shown above). suggested_mistakes is required but may be an empty array when nothing visible warrants a flag. detected_levels is required — set all four price fields to null if no working orders were visible on the entry frame.`

  blocks.push({ type: 'text', text: prompt })

  try {
    // Structured outputs guarantee syntactically valid JSON — previously we
    // hand-parsed text.match(/{...}/) and JSON.parse, which kept blowing up
    // on the AI's unescaped quotes in commentary strings. The schema uses an
    // array of trade objects (not a map keyed by trade id) because
    // structured outputs don't support `additionalProperties` as a schema —
    // only `additionalProperties: false`. Putting the id inside each object
    // keeps the dynamic-key data without violating the spec.
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      // 6000 sized for a busy day (8+ trades each with commentary +
      // suggested_mistakes + detected_levels). Old cap of 1500 truncated
      // mid-response once level detection was added to the schema —
      // structured outputs then fail to parse with "Unterminated string".
      max_tokens: 6000,
      messages: [{ role: 'user', content: blocks }],
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              trades: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    commentary: { type: 'string' },
                    suggested_mistakes: {
                      type: 'array',
                      items: { type: 'string' },
                    },
                    detected_levels: {
                      type: 'object',
                      properties: {
                        entry_price: { type: ['number', 'null'] },
                        stop_price: { type: ['number', 'null'] },
                        tp1_price: { type: ['number', 'null'] },
                        tp2_price: { type: ['number', 'null'] },
                        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                        reasoning: { type: 'string' },
                      },
                      required: ['entry_price', 'stop_price', 'tp1_price', 'tp2_price', 'confidence', 'reasoning'],
                      additionalProperties: false,
                    },
                  },
                  required: ['id', 'commentary', 'suggested_mistakes', 'detected_levels'],
                  additionalProperties: false,
                },
              },
            },
            required: ['trades'],
            additionalProperties: false,
          },
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    const text = message.content[0]?.type === 'text' ? message.content[0].text : ''
    if (!text) {
      return NextResponse.json({
        commentary: {}, suggested_mistakes: {}, skipped, framesUsed: blocks.length - 1,
        note: 'AI returned no text content.',
      })
    }
    // With structured outputs, the entire `text` IS the JSON — no need to
    // hunt for braces. Still wrap in try/catch in case Anthropic ever returns
    // a refusal or empty payload.
    interface DetectedLevelsPayload {
      entry_price: number | null
      stop_price: number | null
      tp1_price: number | null
      tp2_price: number | null
      confidence: 'high' | 'medium' | 'low'
      reasoning: string
    }
    let parsed: {
      trades?: Array<{
        id?: string
        commentary?: string
        suggested_mistakes?: string[]
        detected_levels?: DetectedLevelsPayload
      }>
    }
    try {
      parsed = JSON.parse(text)
    } catch (parseErr) {
      console.error('[video/commentary] JSON parse failed despite structured outputs:', parseErr, '\nraw text:', text.slice(0, 500))
      return NextResponse.json({
        commentary: {}, suggested_mistakes: {}, detected_levels: {}, skipped, framesUsed: blocks.length - 1,
        note: `Structured-output JSON failed to parse: ${parseErr instanceof Error ? parseErr.message : 'unknown'}`,
      })
    }
    const commentary: Record<string, string> = {}
    const suggested: Record<string, string[]> = {}
    const detectedLevels: Record<string, DetectedLevelsPayload> = {}
    if (Array.isArray(parsed.trades)) {
      const librarySet = new Set(mistakeLibrary)
      for (const t of parsed.trades) {
        if (typeof t?.id !== 'string' || typeof t?.commentary !== 'string') continue
        commentary[t.id] = t.commentary
        if (Array.isArray(t.suggested_mistakes)) {
          // Constrain to known mistake labels — if the model hallucinates,
          // drop those entries silently. The "+ Add tag" flow is the right
          // place to introduce new labels, not the AI.
          const valid = t.suggested_mistakes.filter(s => typeof s === 'string' && librarySet.has(s))
          if (valid.length > 0) suggested[t.id] = valid
        }
        if (t.detected_levels && typeof t.detected_levels === 'object') {
          detectedLevels[t.id] = t.detected_levels
        }
      }
    }

    // Persist per-trade commentary to Supabase so it survives reload + syncs
    // across PCs. Silent-fail on missing column (the migration to add
    // trades.recording_commentary may not have been run yet) so the route
    // still returns the AI text even if persistence is unavailable. Mistake
    // suggestions are not persisted yet — they live in localStorage on the
    // client; revisit once the redesigned mistake-tagging system lands.
    try {
      const generatedAt = new Date().toISOString()
      const writes = Object.entries(commentary).map(([id, text]) =>
        supabase
          .from('trades')
          .update({
            recording_commentary: {
              text,
              video_file: safeName,
              model: 'claude-sonnet-4-6',
              generated_at: generatedAt,
              // Detected levels live inside the same jsonb so we don't need a
              // schema migration. Undefined when the model couldn't return a
              // detected_levels block (very rare under structured outputs).
              detected_levels: detectedLevels[id],
            },
          })
          .eq('id', id),
      )
      const results = await Promise.allSettled(writes)
      const firstReject = results.find(r => r.status === 'rejected')
      if (firstReject && firstReject.status === 'rejected') {
        console.warn('[video/commentary] persistence skipped:', firstReject.reason)
      }
    } catch (persistErr) {
      console.warn('[video/commentary] persistence skipped:', persistErr)
    }

    return NextResponse.json({
      commentary,
      suggested_mistakes: suggested,
      detected_levels: detectedLevels,
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
