/**
 * POST /api/recap/commentary — cloud counterpart to /api/video/commentary.
 *
 * The local build reads OBS recordings with ffmpeg. On the hosted app there is
 * no filesystem, so the trader's BROWSER extracts each trade's entry frame
 * (src/lib/browser-frames.ts) and uploads the small JPEGs to their OWN folder in
 * the `screenshots` bucket. This route takes those storage paths, pulls the
 * bytes back server-side, and runs ONE batched multimodal Claude call to produce
 * per-trade commentary + detected levels — then persists to
 * trades.recording_commentary (identical shape to the ffmpeg path) and back-fills
 * a missing screenshot with the entry frame.
 *
 * Body: { videoFile: string, frames: Array<{ id: string, path: string }> }
 *   - videoFile: the recording filename (stored on the commentary row so the UI
 *     can flag stale commentary if the user re-runs against a different file).
 *   - frames[].path: `<uid>/recap/<tradeId>-<ts>.jpg` in the `screenshots`
 *     bucket. Server verifies each path is under the caller's own folder.
 *
 * Gating: per-user daily cap (recap_commentary) consumed BEFORE the model call;
 * model tier resolved server-side (Sonnet default, Opus for admin + granted
 * users). The excursion framing fed to the model is INTERPRETED (capture %,
 * $ left, heat vs stop, ×ATR) — never raw point averages, which the model skips.
 */

import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { consumeAiUsage } from '@/lib/ai-usage'
import { resolveAiModel } from '@/lib/ai-model'
import { interpretExcursion } from '@/lib/trade-excursion'
import { normalizeAnthropicMediaType } from '@/lib/anthropic-image'

const client = new Anthropic()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

interface FrameRef { id: string; path: string }

const PT_TIME_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
})
function fmtPT(iso: string | null | undefined): string {
  if (!iso) return '--:--:--'
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return '--:--:--'
  const parts = PT_TIME_FMT.formatToParts(new Date(ms))
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00'
  return `${get('hour')}:${get('minute')}:${get('second')} PT`
}

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not configured on the server.' }, { status: 503 })
  }

  let body: { videoFile?: string; frames?: FrameRef[] }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }) }
  const videoFile = typeof body.videoFile === 'string' ? body.videoFile : ''
  const frames = Array.isArray(body.frames) ? body.frames.filter(f => f && typeof f.id === 'string' && typeof f.path === 'string') : []
  if (!videoFile || frames.length === 0) {
    return NextResponse.json({ error: 'videoFile and non-empty frames[] required' }, { status: 400 })
  }

  const supabase: AnyClient = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  // Every uploaded frame must live under the caller's own storage folder — a
  // client can't ask us to read someone else's object.
  const prefix = `${user.id}/`
  if (frames.some(f => !f.path.startsWith(prefix))) {
    return NextResponse.json({ error: 'frame path outside your storage folder' }, { status: 403 })
  }

  // Per-user daily cap — consume ONE unit per click, before the model call.
  const gate = await consumeAiUsage(supabase, 'recap_commentary')
  if (!gate.allowed) {
    return NextResponse.json({ error: gate.message, ...gate }, { status: 429 })
  }

  const model = await resolveAiModel(supabase, user)

  // Fetch the real trade rows (RLS-scoped to this user) so the excursion metrics
  // are authoritative, not client-supplied. Only the frames' trade ids.
  const ids = frames.map(f => f.id)
  const { data: tradeRows } = await supabase
    .from('trades')
    .select('id, trading_day_id, direction, entry_price, exit_price, stop_price, quantity, pnl, symbol, entry_time, exit_time, tags_json, notes, screenshot_url, high_during_position, low_during_position, mfe_dollars_per_leg')
    .in('id', ids)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tradesById = new Map<string, any>((tradeRows ?? []).map((t: any) => [t.id, t]))

  // Day-level 1m ATR (per trading_day) → lets us express heat as ×ATR, the
  // interpreted framing the model actually reacts to. Best-effort.
  const dayIds = Array.from(new Set((tradeRows ?? []).map((t: { trading_day_id: string }) => t.trading_day_id).filter(Boolean)))
  const atrByDay = new Map<string, number>()
  if (dayIds.length > 0) {
    const { data: ctxRows } = await supabase
      .from('market_context')
      .select('trading_day_id, atr_1m')
      .in('trading_day_id', dayIds)
    for (const c of (ctxRows ?? []) as Array<{ trading_day_id: string; atr_1m: number | null }>) {
      if (c.atr_1m != null && c.atr_1m > 0) atrByDay.set(c.trading_day_id, c.atr_1m)
    }
  }

  // Mistake library — constrain the AI's suggestions to the trader's taxonomy.
  const { data: mistakeRows } = await supabase
    .from('trade_tags').select('label').eq('category', 'mistakes').order('sort_order') as { data: { label: string }[] | null }
  const mistakeLibrary = (mistakeRows ?? []).map(r => r.label)

  const mediaType = normalizeAnthropicMediaType('image/jpeg')!
  const blocks: Anthropic.MessageParam['content'] = []
  const labels: string[] = []
  const descriptions: string[] = []
  const skipped: Array<{ id: string; reason: string }> = []

  let idx = 0
  for (const f of frames) {
    const t = tradesById.get(f.id)
    if (!t) { skipped.push({ id: f.id, reason: 'trade not found' }); continue }

    // Pull the frame bytes back from storage (RLS-scoped to the user's folder).
    let dataB64: string
    try {
      const { data: blob, error } = await supabase.storage.from('screenshots').download(f.path)
      if (error || !blob) { skipped.push({ id: f.id, reason: 'frame download failed' }); continue }
      const buf = Buffer.from(await blob.arrayBuffer())
      dataB64 = buf.toString('base64')
    } catch {
      skipped.push({ id: f.id, reason: 'frame download error' }); continue
    }

    idx++
    blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: dataB64 } })
    labels.push(`Trade ${idx} (id=${f.id}) ENTRY @ ${fmtPT(t.entry_time)}`)

    // ── INTERPRETED excursion framing (capture %, $ left, heat vs stop, ×ATR) ──
    const exc = interpretExcursion(t)
    const atr = atrByDay.get(t.trading_day_id)
    const excParts: string[] = []
    if (exc.r != null) excParts.push(`realized ${exc.r.toFixed(2)}R`)
    if (exc.capPct != null) excParts.push(`captured ${Math.round(exc.capPct * 100)}% of the favorable move`)
    if (exc.leftUsd != null && exc.leftUsd > 0) excParts.push(`left $${Math.round(exc.leftUsd)} on the table`)
    if (exc.mfeR != null) excParts.push(`peak favorable run ${exc.mfeR.toFixed(1)}R`)
    if (exc.maePct != null) excParts.push(`took ${Math.round(exc.maePct * 100)}% of the planned stop in heat`)
    else if (exc.maePts != null) excParts.push(`took ${exc.maePts.toFixed(1)} pts of heat`)
    if (atr && exc.maePts != null) excParts.push(`(${(exc.maePts / atr).toFixed(1)}× the day's 1m ATR)`)
    const excLine = excParts.length ? excParts.join(' · ') : 'no MFE/MAE data on this trade'

    const dir = t.direction?.toUpperCase() ?? '—'
    const pnl = t.pnl != null ? `${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}` : '—'
    const setups = (t.tags_json?.setups as string[] | undefined)?.join(', ') || '—'
    const orderFlow = (t.tags_json?.order_flow as string[] | undefined)?.join(', ') || '—'
    const mistakes = (t.tags_json?.mistakes as string[] | undefined)?.join(', ') || '—'
    const notes = t.notes?.trim() ? `\n  notes: ${t.notes.trim()}` : ''
    descriptions.push(`Trade ${idx} (id=${f.id}): ${dir} ${t.quantity ?? '?'} @ ${t.entry_price ?? '?'} → ${t.exit_price ?? '?'} | PnL ${pnl}
  setups: ${setups} | order_flow: ${orderFlow} | mistakes: ${mistakes}
  exit/heat: ${excLine}${notes}`)
  }

  if (blocks.length === 0) {
    return NextResponse.json({
      commentary: {}, skipped, framesUsed: 0, model,
      note: 'No frames could be read — every upload failed or its trade was missing.',
    })
  }

  const mistakeListBlock = mistakeLibrary.length > 0
    ? `\n\nAvailable mistake tags (suggest 0–3 per trade, ONLY from this list — copy labels verbatim, do not invent new ones; pick ONLY mistakes clearly visible in the frame, not speculative):\n${mistakeLibrary.map(m => `  - ${m}`).join('\n')}`
    : ''

  const prompt = `You are an objective trading coach reviewing screen-recording frames from a futures trader's session. Each frame is the trader's chart at the exact moment they entered a trade.

For each ENTRY frame, do TWO things:

1) Write 1–3 sentences of HONEST commentary tying what's visibly on screen — chart structure, key levels, order flow, where price sat relative to the setup — to the trade the trader took. Be specific and direct, not encouraging. IMPORTANT: factor in the exit/heat line for each trade (it is already INTERPRETED for you: capture % of the favorable move, $ left on the table, and heat taken as a share of the planned stop / ×ATR). If a trade captured little of a large favorable move, or took most of its stop in heat before working, SAY SO — those are the coachable moments. If the entry frame doesn't support the tagged setup, say so.

2) From the ENTRY frame, identify the trader's PLANNED order levels by reading horizontal lines / DOM order labels on the chart:
   - entry_price: the price the order was waiting at
   - stop_price: the working stop line (BELOW entry for longs, ABOVE for shorts). Sierra labels these "Stop|Child-Client" with a "(-N.NNp)" distance suffix.
   - tp1_price / tp2_price: working limit / TP lines (ABOVE entry for longs, BELOW for shorts). TP1 is closer to entry.
   CRITICAL: return null for any field you cannot confidently read off the price scale or a labeled order line. DO NOT GUESS — a null is far more useful than a hallucinated number. levels_confidence is "high" only if every non-null field came from a clearly-labeled order line; "medium" if inferred from line position; "low" if the chart was hard to read.${mistakeListBlock}

The image array above is ordered as follows:
${labels.map((l, i) => `${i + 1}. ${l}`).join('\n')}

Trade context (matches the image labels by trade id):
${descriptions.join('\n')}

Return ONE entry in the trades array per unique trade id (use the id strings exactly as shown). suggested_mistakes is required but may be empty. detected_levels is required — set all four price fields to null if no working orders were visible.`

  blocks.push({ type: 'text', text: prompt })

  try {
    const message = await client.messages.create({
      model,
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
                    suggested_mistakes: { type: 'array', items: { type: 'string' } },
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
      return NextResponse.json({ commentary: {}, suggested_mistakes: {}, skipped, framesUsed: blocks.length - 1, model, note: 'AI returned no text content.' })
    }

    interface DetectedLevelsPayload {
      entry_price: number | null; stop_price: number | null
      tp1_price: number | null; tp2_price: number | null
      confidence: 'high' | 'medium' | 'low'; reasoning: string
    }
    let parsed: { trades?: Array<{ id?: string; commentary?: string; suggested_mistakes?: string[]; detected_levels?: DetectedLevelsPayload }> }
    try { parsed = JSON.parse(text) }
    catch (parseErr) {
      console.error('[recap/commentary] JSON parse failed:', parseErr, '\nraw:', text.slice(0, 500))
      return NextResponse.json({ commentary: {}, suggested_mistakes: {}, detected_levels: {}, skipped, framesUsed: blocks.length - 1, model, note: 'Structured-output JSON failed to parse.' })
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
          const valid = t.suggested_mistakes.filter(s => typeof s === 'string' && librarySet.has(s))
          if (valid.length > 0) suggested[t.id] = valid
        }
        if (t.detected_levels && typeof t.detected_levels === 'object') detectedLevels[t.id] = t.detected_levels
      }
    }

    // Persist per-trade commentary (same shape as the ffmpeg path) so it
    // survives reload + syncs across devices. Silent-fail on a missing column so
    // the AI text still returns. NB: unlike the local ffmpeg path this route does
    // NOT back-fill screenshot_url — the entry frame → screenshot wiring is
    // deferred to Phase 3 so it can adopt the storage-hardening track's
    // path-store + signed-URL format rather than writing a soon-stale public URL.
    try {
      const generatedAt = new Date().toISOString()
      const writes = Object.entries(commentary).map(([id, textOut]) =>
        supabase.from('trades').update({
          recording_commentary: {
            text: textOut,
            video_file: videoFile,
            model,
            generated_at: generatedAt,
            detected_levels: detectedLevels[id],
          },
        }).eq('id', id),
      )
      const results = await Promise.allSettled(writes)
      const firstReject = results.find(r => r.status === 'rejected')
      if (firstReject && firstReject.status === 'rejected') console.warn('[recap/commentary] persistence skipped:', firstReject.reason)
    } catch (persistErr) {
      console.warn('[recap/commentary] persistence skipped:', persistErr)
    }

    return NextResponse.json({
      commentary,
      suggested_mistakes: suggested,
      detected_levels: detectedLevels,
      skipped,
      framesUsed: blocks.length - 1,
      model,
    })
  } catch (e) {
    const err = e as { message?: string; error?: { message?: string }; status?: number }
    console.error('[recap/commentary] failed:', err)
    return NextResponse.json({ error: err?.error?.message ?? err?.message ?? 'commentary failed' }, { status: err?.status ?? 500 })
  }
}
